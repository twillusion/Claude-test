/* SG Temp — live Singapore air temperature from data.gov.sg (NEA).
   No backend: the browser talks to the public API directly. The v2 API is
   primary; the v1 API is kept as a fallback since both are public and
   CORS-enabled. History is loaded in bulk (one request per calendar day
   returns the whole day at per-minute resolution), which powers the time
   scrubber and the interpolated shading overlay. */

const V2_URL = "https://api-open.data.gov.sg/v2/real-time/api/air-temperature";
const V1_URL = "https://api.data.gov.sg/v1/environment/air-temperature";
const WIND_SPEED_URL = "https://api.data.gov.sg/v1/environment/wind-speed";
const WIND_DIR_URL = "https://api.data.gov.sg/v1/environment/wind-direction";
const RAIN_URL = "https://api.data.gov.sg/v1/environment/rainfall";
const RAIN_POLL_MS = 5 * 60_000; // gauges report 5-minute totals
const SAT_POLL_MS = 10 * 60_000; // satellite frames update every ~10 minutes
const KNOTS_TO_KMH = 1.852;
const OM_URL = "https://api.open-meteo.com/v1/forecast";
const POLL_MS = 60_000;
const MODEL_REFRESH_MS = 30 * 60_000; // Open-Meteo models update hourly
const HISTORY_HOURS = 24;
// Shown in the footer; bump together with the ?v= stamps in index.html so a
// glance settles "am I looking at the new build or a stale cache?"
const APP_VERSION = "20260702a";

const SLIDER_STEP_MIN = 5; // scrubber granularity; underlying data is per-minute

// Geographic window and raster size for the shading overlay; the Open-Meteo
// sample grid shares the same bounds so the raster never extrapolates, and
// the map is hard-locked to this exact window.
const OVERLAY = { latMin: 1.09, latMax: 1.56, lonMin: 103.48, lonMax: 104.22, w: 240, h: 152 };
// ~10km sample spacing — matches the model's native resolution, so a denser
// grid adds API weight without adding information
const GRID_NLAT = 6;
const GRID_NLON = 9;
const KM_PER_DEG = 111.32;
// Station residuals shrink toward zero away from stations; at ~12 km the
// correction is halved, so the model field dominates where there's no sensor.
const RESIDUAL_LAMBDA = 1 / (12 * 12);

// Sensor.Community citizen sensors (open API, no key). Civilian-grade:
// included at reduced weight, sanity-filtered, and live-only (no archive).
const CIV_URL = "https://data.sensor.community/airrohr/v1/filter/" +
  `box=${OVERLAY.latMin},${OVERLAY.lonMin},${OVERLAY.latMax},${OVERLAY.lonMax}`;
const CIV_POLL_MS = 120_000; // their readings update ~every 2.5 minutes
const CIV_RESIDUAL_WT = 0.7; // vs 1.0 for official stations

const stations = new Map(); // id -> {id, name, lat, lon, marker, listEl, series: Map t->v, history: [{t,v}], latest}
let timeline = [];    // sorted unique reading timestamps (ms) within the 24h window
let sliderTicks = []; // timeline thinned to SLIDER_STEP_MIN buckets, + forecast hours
let sliderLiveIdx = -1; // tick index that means "live"
const FORECAST_HOURS = 24;
let displayedT = null; // null = live (latest reading)
let selectedId = null;
let map, overlayLayer, overlayCanvas;
let renderQueued = false;
let model = null; // {times: [ms], grids: [Float32Array(GRID_NLAT*GRID_NLON)]}
let latestReadingT = null, statusPinned = false;
let fieldCache = null, fadeCache = null; // last rasterized field, reused by the shimmer

// ---------- API ----------

// SGT wall-clock helpers (the API speaks local Singapore time).
function sgtStamp(date) {
  return new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0, 19);
}
function sgtDate(date) {
  return sgtStamp(date).slice(0, 10);
}

// fetch with a single retry on 429: the data APIs rate-limit bursts, and the
// archive downloads at startup are exactly such a burst.
async function fetch429(url) {
  let res = await fetch(url);
  if (res.status === 429) {
    const wait = Number(res.headers?.get?.("Retry-After")) * 1000 || 4000;
    await new Promise((r) => setTimeout(r, Math.min(wait, 15_000)));
    res = await fetch(url);
  }
  return res;
}

function normalizeStationsV2(list) {
  return list.map((s) => {
    const loc = s.location || s.labelLocation || {};
    return { id: s.id, name: s.name, lat: loc.latitude, lon: loc.longitude };
  });
}

// Latest reading (or the reading nearest a given moment), normalized across API versions.
async function fetchReadings(atDate) {
  const errors = [];
  try {
    const url = atDate ? `${V2_URL}?date=${encodeURIComponent(sgtStamp(atDate))}` : V2_URL;
    const res = await fetch429(url);
    if (!res.ok) throw new Error(`v2 HTTP ${res.status}`);
    const d = (await res.json()).data;
    const reading = d.readings[d.readings.length - 1];
    return {
      stations: normalizeStationsV2(d.stations),
      items: [{ timestamp: reading.timestamp,
                readings: reading.data.map((r) => [r.stationId, r.value]) }],
    };
  } catch (e) {
    errors.push(e);
  }
  try {
    const url = atDate ? `${V1_URL}?date_time=${encodeURIComponent(sgtStamp(atDate))}` : V1_URL;
    const res = await fetch429(url);
    if (!res.ok) throw new Error(`v1 HTTP ${res.status}`);
    const json = await res.json();
    const item = json.items[json.items.length - 1];
    return {
      stations: json.metadata.stations.map((s) => ({
        id: s.id, name: s.name, lat: s.location.latitude, lon: s.location.longitude,
      })),
      items: [{ timestamp: item.timestamp,
                readings: item.readings.map((r) => [r.station_id, r.value]) }],
    };
  } catch (e) {
    errors.push(e);
    throw new Error(errors.map(String).join("; "));
  }
}

// A whole calendar day of per-minute readings in one go.
async function fetchDay(dateStr) {
  try {
    const res = await fetch429(`${V1_URL}?date=${dateStr}`);
    if (!res.ok) throw new Error(`v1 HTTP ${res.status}`);
    const json = await res.json();
    return {
      stations: json.metadata.stations.map((s) => ({
        id: s.id, name: s.name, lat: s.location.latitude, lon: s.location.longitude,
      })),
      items: json.items.map((it) => ({
        timestamp: it.timestamp,
        readings: it.readings.map((r) => [r.station_id, r.value]),
      })),
    };
  } catch { /* fall through to paginated v2 */ }

  let token = null, stationsOut = [], items = [];
  do {
    const url = `${V2_URL}?date=${dateStr}` + (token ? `&paginationToken=${encodeURIComponent(token)}` : "");
    const res = await fetch429(url);
    if (!res.ok) throw new Error(`v2 HTTP ${res.status}`);
    const d = (await res.json()).data;
    stationsOut = normalizeStationsV2(d.stations);
    for (const reading of d.readings) {
      items.push({ timestamp: reading.timestamp,
                   readings: reading.data.map((r) => [r.stationId, r.value]) });
    }
    token = d.paginationToken;
  } while (token);
  return { stations: stationsOut, items };
}

// ---------- Sensor.Community citizen sensors ----------

// Last ~5 minutes of readings inside our box. Readings accumulate into the
// same series as NEA stations (so they scrub for as long as you've had the
// page open), but there's no archive to backfill, so older scrub times show
// official stations only. Obvious junk (out-of-range, or wildly off the NEA
// median — a sensor on a sunny balcony) is dropped.
async function fetchCommunity() {
  const res = await fetch429(CIV_URL);
  if (!res.ok) throw new Error(`sensor.community HTTP ${res.status}`);
  const arr = await res.json();
  const latest = new Map();
  for (const m of arr) {
    const tv = (m.sensordatavalues || []).find((d) => d.value_type === "temperature");
    const lat = parseFloat(m.location?.latitude);
    const lon = parseFloat(m.location?.longitude);
    const v = tv ? parseFloat(tv.value) : NaN;
    const t = new Date(String(m.timestamp).replace(" ", "T") + "Z").getTime(); // UTC
    if (!Number.isFinite(v) || v < 18 || v > 42) continue;
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(t)) continue;
    const id = `civ-${m.sensor.id}`;
    const prev = latest.get(id);
    if (!prev || t > prev.t) latest.set(id, { id, lat, lon, t, v });
  }
  const neaVals = [...stations.values()]
    .filter((s) => s.kind === "nea" && s.latest != null)
    .map((s) => s.latest).sort((a, b) => a - b);
  const median = neaVals.length ? neaVals[neaVals.length >> 1] : null;
  let added = 0;
  for (const e of latest.values()) {
    if (median != null && Math.abs(e.v - median) > 4) continue; // implausible vs island
    const s = upsertStation({
      id: e.id, name: `Community sensor ${e.id.slice(4)}`, lat: e.lat, lon: e.lon, kind: "civ",
    });
    s.series.set(e.t, e.v);
    added++;
  }
  const total = [...stations.values()].filter((s) => s.kind === "civ").length;
  document.getElementById("civ-status").textContent =
    total ? `${total} sensor${total > 1 ? "s" : ""}` : "none in range";
  if (added) { rebuild(); renderAll(); }
}

function pollCommunity() {
  fetchCommunity().catch(() => {
    document.getElementById("civ-status").textContent = "unreachable";
  });
}

// ---------- Open-Meteo model grid ----------

// Hourly 2m-temperature + 10m wind for the whole sample grid, yesterday
// through tomorrow — the scrubber's past window plus the forecast horizon.
function buildModelFromResults(results) {
  const times = results[0].hourly.time.map((s) => s * 1000);
  const grids = [], uGrids = [], vGrids = [];
  times.forEach((_, k) => {
    const g = new Float32Array(results.length);
    const gu = new Float32Array(results.length);
    const gv = new Float32Array(results.length);
    for (let i = 0; i < results.length; i++) {
      const h = results[i].hourly;
      const v = h.temperature_2m[k];
      g[i] = v == null ? NaN : v;
      const ws = h.wind_speed_10m?.[k], wd = h.wind_direction_10m?.[k];
      if (ws == null || wd == null) { gu[i] = NaN; gv[i] = NaN; continue; }
      // meteorological direction = where the wind comes FROM
      const rad = (wd * Math.PI) / 180;
      gu[i] = -ws * Math.sin(rad); // eastward, km/h
      gv[i] = -ws * Math.cos(rad); // northward, km/h
    }
    grids.push(g); uGrids.push(gu); vGrids.push(gv);
  });
  model = { times, grids, uGrids, vGrids };
}

// Primary source: data/model.json, committed by the scheduled GitHub Action
// (scripts/fetch-model.mjs) — same-origin, so browser-side blocks and rate
// limits on Open-Meteo can't touch it.
async function fetchModelLocal() {
  const res = await fetch(`data/model.json?t=${Math.floor(Date.now() / 600_000)}`);
  if (!res.ok) throw new Error(`local model HTTP ${res.status}`);
  const j = await res.json();
  if (!j.results?.length) throw new Error("empty model file");
  if (Date.now() - (j.generated ?? 0) > 12 * 3600_000) throw new Error("stale model file");
  buildModelFromResults(j.results);
}

// Fallback: fetch Open-Meteo directly from the browser.
async function fetchModel() {
  const lats = [], lons = [];
  for (let iy = 0; iy < GRID_NLAT; iy++) {
    for (let ix = 0; ix < GRID_NLON; ix++) {
      lats.push((OVERLAY.latMin + (iy * (OVERLAY.latMax - OVERLAY.latMin)) / (GRID_NLAT - 1)).toFixed(4));
      lons.push((OVERLAY.lonMin + (ix * (OVERLAY.lonMax - OVERLAY.lonMin)) / (GRID_NLON - 1)).toFixed(4));
    }
  }
  // chunked: long multi-location URLs / heavy requests are what get refused
  const CHUNK = 27;
  const requests = [];
  for (let i = 0; i < lats.length; i += CHUNK) {
    const url = `${OM_URL}?latitude=${lats.slice(i, i + CHUNK).join(",")}` +
      `&longitude=${lons.slice(i, i + CHUNK).join(",")}` +
      `&hourly=temperature_2m,wind_speed_10m,wind_direction_10m` +
      `&past_days=1&forecast_days=2&timeformat=unixtime&timezone=UTC`;
    requests.push(fetch(url).then(async (res) => {
      if (!res.ok) throw new Error(`open-meteo HTTP ${res.status}`);
      const j = await res.json();
      return Array.isArray(j) ? j : [j];
    }));
  }
  const results = (await Promise.all(requests)).flat();
  if (results.length !== lats.length) throw new Error("open-meteo result count mismatch");
  buildModelFromResults(results);
}

// Cache the model in localStorage so page reloads within the refresh window
// don't re-hit Open-Meteo — rapid reloads are how free-tier rate limits get
// burned, which then takes the model (and wind) down for everyone-you.
const MODEL_CACHE_KEY = "sgtemp-model-v1";

function loadModelCache() {
  try {
    const c = JSON.parse(localStorage.getItem(MODEL_CACHE_KEY));
    if (!c || Date.now() - c.at > MODEL_REFRESH_MS) return false;
    const revive = (arr) => arr.map((g) => Float32Array.from(g, (x) => (x == null ? NaN : x)));
    model = { times: c.times, grids: revive(c.grids), uGrids: revive(c.uGrids), vGrids: revive(c.vGrids) };
    return true;
  } catch {
    return false;
  }
}

function saveModelCache() {
  try {
    const pack = (arr) => arr.map((g) => Array.from(g, (x) => (Number.isNaN(x) ? null : x)));
    localStorage.setItem(MODEL_CACHE_KEY, JSON.stringify({
      at: Date.now(), times: model.times,
      grids: pack(model.grids), uGrids: pack(model.uGrids), vGrids: pack(model.vGrids),
    }));
  } catch { /* storage full or unavailable — not worth failing over */ }
}

function setShadeMode(text) {
  document.getElementById("shade-mode").textContent = text;
}

function modelLoaded(source) {
  if (typeof localStorage !== "undefined") saveModelCache();
  setShadeMode(`Open-Meteo model + station correction (${source})`);
  rebuild(); // the slider grows its forecast ticks from the model times
  scheduleRender();
}

async function refreshModel() {
  try {
    await fetchModelLocal();
    modelLoaded("via repo");
    return;
  } catch { /* no data file yet, or stale — fall through */ }
  if (!model && typeof localStorage !== "undefined" && loadModelCache()) {
    setShadeMode("Open-Meteo model + station correction (cached)");
    rebuild();
    scheduleRender();
    return; // fresh enough; the next interval tick refetches
  }
  try {
    await fetchModel();
    modelLoaded("direct");
  } catch (e) {
    // keep whatever model we had; surface the real error in the footer
    if (!model) {
      setShadeMode(`stations only (model: ${e.message})`);
      setTimeout(refreshModel, 3 * 60_000);
    }
  }
}

// A grid series blended in time to the displayed moment.
function blendGrids(gridsArr, t) {
  const { times } = model;
  let k = 0;
  while (k < times.length - 2 && times[k + 1] <= t) k++;
  const t0 = times[k], t1 = times[Math.min(k + 1, times.length - 1)];
  const f = t1 > t0 ? Math.min(1, Math.max(0, (t - t0) / (t1 - t0))) : 0;
  const a = gridsArr[k], b = gridsArr[Math.min(k + 1, gridsArr.length - 1)];
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) {
    out[i] = Number.isNaN(a[i]) ? b[i] : Number.isNaN(b[i]) ? a[i] : a[i] + (b[i] - a[i]) * f;
  }
  return out;
}

function buildBlendedGrid(t) {
  return model ? blendGrids(model.grids, t) : null;
}

// Wind field at the displayed time, refreshed by renderAll.
let windU = null, windV = null;

function updateWindBlend() {
  if (!model || !model.uGrids) { windU = null; windV = null; return; }
  const t = displayedTime() ?? Date.now();
  windU = blendGrids(model.uGrids, t);
  windV = blendGrids(model.vGrids, t);
}

// ---------- NEA observed wind (primary source for the particles) ----------

/* data.gov.sg real-time wind: same reliable host as the temperatures.
   Per-station history is built from day files (yesterday + today) at
   startup and appended by the per-minute polls, so the time scrubber
   replays observed wind. The live view shows each station's last known
   reading — the feed is sparse, so reading ages vary by station. */
const windStations = new Map(); // id -> {id, name, lat, lon, series: [{t, u, v}]}
let windVectors = [];           // station vectors at the displayed time
const windVectorsById = new Map();
let windFieldT = NaN;
let windDayLoaded = false;

function vecFrom(kn, deg) {
  const kmh = kn * KNOTS_TO_KMH;
  const rad = (deg * Math.PI) / 180; // direction the wind comes FROM
  return { u: -kmh * Math.sin(rad), v: -kmh * Math.cos(rad) };
}

function addWindPoint(id, st, t, kn, deg) {
  if (kn == null || deg == null || !st?.location || !Number.isFinite(t)) return;
  let rec = windStations.get(id);
  if (!rec) {
    rec = {
      id, name: st.name || `Wind station ${id}`,
      lat: st.location.latitude, lon: st.location.longitude, series: [],
    };
    windStations.set(id, rec);
  }
  const last = rec.series[rec.series.length - 1];
  if (last && last.t === t) return;
  const { u, v } = vecFrom(kn, deg);
  rec.series.push({ t, u, v });
  if (last && last.t > t) rec.series.sort((x, y) => x.t - y.t);
}

// Vectors at the displayed time: live = each station's latest reading;
// scrubbed = the last reading at or before that moment (within 90 min).
function updateWindField() {
  windFieldT = displayedT === null ? Infinity : displayedT;
  windVectors = [];
  windVectorsById.clear();
  for (const st of windStations.values()) {
    const arr = st.series;
    if (!arr.length) continue;
    let p;
    if (displayedT === null) {
      p = arr[arr.length - 1];
    } else {
      let lo = 0, hi = arr.length - 1, idx = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (arr[mid].t <= displayedT + 60_000) { idx = mid; lo = mid + 1; } else hi = mid - 1;
      }
      if (idx < 0 || displayedT - arr[idx].t > 90 * 60_000) continue;
      p = arr[idx];
    }
    const vec = { id: st.id, name: st.name, lat: st.lat, lon: st.lon, u: p.u, v: p.v };
    windVectors.push(vec);
    windVectorsById.set(st.id, vec);
  }
  buildWindGrid();
}

/* The displayed-time wind field rasterized onto a coarse grid: built once
   per field change (a few hundred cells × a dozen stations), so the
   per-frame particle work drops from one IDW pass per particle per tick to
   a cheap bilinear lookup. NaN cells mark "no data within coverage". */
const WGRID = { nx: 24, ny: 16 };
let windGridU = null, windGridV = null;

function buildWindGrid() {
  if (windVectors.length < 2) { windGridU = null; windGridV = null; return; }
  const { nx, ny } = WGRID;
  windGridU = new Float32Array(nx * ny);
  windGridV = new Float32Array(nx * ny);
  const cosLat = Math.cos((1.35 * Math.PI) / 180);
  const cover2 = WIND_COVER_KM * WIND_COVER_KM;
  for (let iy = 0; iy < ny; iy++) {
    const lat = OVERLAY.latMax - ((iy + 0.5) / ny) * (OVERLAY.latMax - OVERLAY.latMin);
    for (let ix = 0; ix < nx; ix++) {
      const lon = OVERLAY.lonMin + ((ix + 0.5) / nx) * (OVERLAY.lonMax - OVERLAY.lonMin);
      let wSum = 0, u = 0, v = 0, nearest = Infinity;
      for (const p of windVectors) {
        const dx = (lon - p.lon) * cosLat * KM_PER_DEG;
        const dy = (lat - p.lat) * KM_PER_DEG;
        const d2 = dx * dx + dy * dy;
        if (d2 < nearest) nearest = d2;
        const w = 1 / (d2 + 0.5);
        wSum += w; u += w * p.u; v += w * p.v;
      }
      const i = iy * nx + ix;
      if (nearest > cover2) { windGridU[i] = NaN; windGridV[i] = NaN; }
      else { windGridU[i] = u / wSum; windGridV[i] = v / wSum; }
    }
  }
}

// ---------- rain (NEA rain gauges, 24h history, scrubbable) ----------

/* 5-minute rainfall totals from ~60 gauges, kept as a 24-hour per-gauge
   series (positive readings only — absence means dry). A gauge is "wet" at
   a moment if it rained within the previous 30 minutes, so showers that
   just ended still show (faded). The time scrubber replays the day's rain.
   Each wet gauge gets a rain glyph and a translucent circle estimating the
   splash zone (radius and colour grow with intensity). */
const RAIN_RECENT_MS = 30 * 60_000;
let rainReadings = []; // latest poll: [{id, lat, lon, mm}]
let wetGauges = [];    // wet list at "now"
const rainSeries = new Map(); // gauge id -> [{t, mm>0}] sorted, ~25h window
const rainLocs = new Map();   // gauge id -> {lat, lon}

function pushRainSeries(id, t, mm) {
  if (!(mm > 0) || !Number.isFinite(t)) return;
  const arr = rainSeries.get(id) ?? [];
  if (arr.some((p) => p.t === t)) return;
  arr.push({ t, mm });
  arr.sort((a, b) => a.t - b.t);
  rainSeries.set(id, arr);
}

function pruneRainSeries() {
  const cutoff = Date.now() - (HISTORY_HOURS + 1) * 3600_000;
  for (const [id, arr] of rainSeries) {
    while (arr.length && arr[0].t < cutoff) arr.shift();
    if (!arr.length) rainSeries.delete(id);
  }
}

function rainSum(arr, from, to) {
  let s = 0;
  for (const p of arr) {
    if (p.t > from && p.t <= to) s += p.mm;
  }
  return s;
}

// Gauges wet at a moment: rained in the 30 minutes before it.
function wetList(t) {
  const out = [];
  for (const [id, arr] of rainSeries) {
    const recent = rainSum(arr, t - RAIN_RECENT_MS, t);
    if (recent <= 0.2) continue;
    const loc = rainLocs.get(id);
    if (!loc) continue;
    out.push({ id, lat: loc.lat, lon: loc.lon, mm: rainSum(arr, t - 5.5 * 60_000, t), recent });
  }
  return out;
}

function recomputeWet() {
  pruneRainSeries();
  wetGauges = wetList(Date.now());
}

async function fetchRainSnap(dt) {
  const q = dt ? `?date_time=${encodeURIComponent(sgtStamp(dt))}` : "";
  const res = await fetch429(RAIN_URL + q);
  if (!res.ok) throw new Error(`rain HTTP ${res.status}`);
  const json = await res.json();
  const item = json.items?.[0] ?? { readings: [] };
  for (const s of json.metadata?.stations ?? []) {
    if (s.location) rainLocs.set(s.id, { lat: s.location.latitude, lon: s.location.longitude });
  }
  return {
    t: new Date(item.timestamp).getTime() || Date.now(),
    readings: item.readings ?? [],
  };
}

async function fetchRain() {
  // like every realtime feed here, the latest snapshot can be sparse — top
  // up from the previous 5-minute mark when it looks thin
  const snaps = [await fetchRainSnap()];
  if (snaps[0].readings.length < 10) {
    const m = new Date(Date.now() - 5 * 60_000);
    m.setSeconds(0, 0);
    m.setMinutes(Math.floor(m.getMinutes() / 5) * 5);
    try { snaps.push(await fetchRainSnap(m)); } catch { /* best-effort */ }
  }
  const byId = new Map();
  for (const snap of snaps) {
    for (const r of snap.readings) {
      const loc = rainLocs.get(r.station_id);
      if (!loc || r.value == null || r.value < 0 || byId.has(r.station_id)) continue;
      byId.set(r.station_id, { id: r.station_id, lat: loc.lat, lon: loc.lon, mm: r.value });
      pushRainSeries(r.station_id, snap.t, r.value);
    }
  }
  rainReadings = [...byId.values()];
  recomputeWet();
  console.info(`[sgtemp] rain: ${rainReadings.length} gauges reporting, ${wetGauges.length} wet`);
  renderRain();
  renderRainStatus();
}

// Full 24h rain history from the day files (today + yesterday), deferred —
// it powers the time scrubber and settles "did it really not rain today?".
let rainDayLoaded = false;

async function loadRainHistory() {
  if (rainDayLoaded) return;
  rainDayLoaded = true;
  for (const day of [sgtDate(new Date()), sgtDate(new Date(Date.now() - 86_400_000))]) {
    try {
      const res = await fetch429(`${RAIN_URL}?date=${day}`);
      if (!res.ok) continue;
      const json = await res.json();
      for (const s of json.metadata?.stations ?? []) {
        if (s.location) rainLocs.set(s.id, { lat: s.location.latitude, lon: s.location.longitude });
      }
      for (const item of json.items ?? []) {
        const t = new Date(item.timestamp).getTime();
        for (const r of item.readings ?? []) {
          if (r.value > 0) pushRainSeries(r.station_id, t, r.value);
        }
      }
    } catch { /* day files are best-effort */ }
  }
  recomputeWet();
  renderRain();
  renderRainStatus();
  if (typeof localStorage !== "undefined") saveHistCache();
}

// Seed the 30-minute window so rain that fell before the page was opened
// still shows. Rainfall publishes on exact 5-minute marks (unlike wind), so
// six small spot-snapshots beat downloading the multi-MB day file.
async function seedRainRecent() {
  for (let back = 5; back <= 30; back += 5) {
    const m = new Date(Date.now() - back * 60_000);
    m.setSeconds(0, 0);
    m.setMinutes(Math.floor(m.getMinutes() / 5) * 5);
    try {
      const res = await fetch429(`${RAIN_URL}?date_time=${encodeURIComponent(sgtStamp(m))}`);
      if (!res.ok) continue;
      const item = (await res.json()).items?.[0];
      if (!item) continue;
      const t = new Date(item.timestamp).getTime();
      if (!Number.isFinite(t)) continue;
      for (const r of item.readings ?? []) {
        if (r.value > 0) pushRainSeries(r.station_id, t, r.value);
      }
    } catch { /* seeding is best-effort */ }
  }
  recomputeWet();
  renderRain();
  renderRainStatus();
}

const rainLayer = new Map(); // gauge id -> {circle, icon}

// Light drizzle = light blue, downpour = deep blue.
function rainColor(mm) {
  const t = Math.min(1, Math.max(0, (mm - 0.2) / 8));
  const c0 = [158, 212, 255], c1 = [16, 86, 200];
  return `rgb(${c0.map((v, i) => Math.round(v + (c1[i] - v) * t)).join(",")})`;
}

function renderRain() {
  if (typeof L === "undefined" || !map) return;
  // live shows "now"; scrubbing replays the day's rain at the displayed time
  const list = displayedT === null ? wetGauges : wetList(displayedTime() ?? Date.now());
  const seen = new Set();
  for (const g of list) {
    seen.add(g.id);
    const active = g.mm > 0.05; // raining now vs rained recently
    const intensity = Math.max(g.mm, (g.recent ?? 0) / 3);
    const radius = 1200 + Math.min(8, intensity) * 350; // metres — a rough splash zone
    const col = rainColor(intensity);
    let e = rainLayer.get(g.id);
    if (!e) {
      e = {
        circle: L.circle([g.lat, g.lon], {
          pane: "rain", radius,
          color: col, weight: 1,
          fillColor: col,
          interactive: false,
        }).addTo(map),
        icon: L.marker([g.lat, g.lon], { pane: "rain", keyboard: false }).addTo(map),
      };
      rainLayer.set(g.id, e);
    }
    e.circle.setRadius(radius);
    if (e.circle.setStyle) {
      e.circle.setStyle({
        color: col, fillColor: col,
        opacity: active ? 0.4 : 0.2,
        fillOpacity: active ? 0.14 : 0.06,
      });
    }
    e.icon.setIcon(L.divIcon({
      className: "",
      html: `<span class="rain-icon"${active ? "" : ' style="opacity:0.5"'}>🌧️</span>`,
      iconSize: [0, 0],
    }));
    e.icon.bindTooltip(
      `${g.mm.toFixed(1)} mm now · ${(g.recent ?? 0).toFixed(1)} mm last 30 min`);
  }
  for (const [id, e] of rainLayer) {
    if (!seen.has(id)) { e.circle.remove(); e.icon.remove(); rainLayer.delete(id); }
  }
}

// Open the page with ?testrain to verify the rain rendering on a dry day:
// synthetic wet gauges replace the real poll.
const TEST_RAIN = typeof location !== "undefined" && /testrain/.test(location.search);

function injectTestRain() {
  const now = Date.now();
  const gauges = [
    { id: "T1", lat: 1.34, lon: 103.78, mm: 6 },
    { id: "T2", lat: 1.36, lon: 103.95, mm: 2.5 },
    { id: "T3", lat: 1.29, lon: 103.85, mm: 0 }, // "rained 20 min ago" look
  ];
  rainReadings = gauges;
  for (const g of gauges) {
    rainLocs.set(g.id, { lat: g.lat, lon: g.lon });
    pushRainSeries(g.id, now, g.mm);
    pushRainSeries(g.id, now - 20 * 60_000, 3);
  }
  recomputeWet();
  renderRain();
  const el = document.getElementById("rain-status");
  if (el) el.textContent = "TEST MODE — synthetic rain";
}

function pollRain() {
  if (TEST_RAIN) { injectTestRain(); return; }
  fetchRain().catch(() => {
    const el = document.getElementById("rain-status");
    if (el) el.textContent = "unreachable";
  });
}

function renderRainStatus() {
  const el = document.getElementById("rain-status");
  if (!el) return;
  if (!rainReadings.length) { el.textContent = "no gauges reporting"; return; }
  if (!wetGauges.length) {
    el.textContent = `dry 30 min (${rainReadings.length} gauges)`;
    return;
  }
  const max = Math.max(...wetGauges.map((g) => Math.max(g.mm, (g.recent ?? 0) / 3)));
  el.textContent = `${wetGauges.length} gauge${wetGauges.length > 1 ? "s" : ""} wet · up to ${max.toFixed(1)} mm`;
}

// ---------- precipitation radar (RainViewer) ----------

/* The organic green blobs on commercial weather maps are precipitation
   radar, not satellite cloud photos: smoothed reflectivity composites
   coloured by intensity. RainViewer's free API still serves the global
   radar composite (only its satellite product was retired), so we draw the
   latest frame with the classic NEXRAD palette, smoothed. */
const RV_META_URL = "https://api.rainviewer.com/public/weather-maps.json";
let satLabel = "";
let radarOn = true;
try { radarOn = localStorage.getItem("sgtemp-radar") !== "off"; } catch { /* default on */ }

function updateRadarBtn() {
  const b = document.getElementById("radar-btn");
  if (b && b.classList) b.classList.toggle("active", radarOn);
}

function setSatStatus(text) {
  const el = document.getElementById("sat-status");
  if (el) el.textContent = text;
}

let radarFrames = []; // [{time: sec, path}] \u2014 RainViewer keeps ~2h of past frames
let radarHost = "";
const radarLayers = new Map(); // frame path -> persistent preloaded layer
let radarShown = null;         // frame path currently visible

function radarUrl(path) {
  // 512px tiles double the resolution at the same zoom cap;
  // colour scheme 6 = NEXRAD green/yellow/red; options 1_1 = smoothed
  return `${radarHost}${path}/512/{z}/{x}/{y}/6/1_1.png`;
}

function makeRadarLayer(url) {
  const l = L.tileLayer(url, {
    pane: "clouds",
    opacity: 0,
    tileSize: 512,
    zoomOffset: -1, // 512px tiles: view zoom 8 fetches URL zoom 7
    // RainViewer's free tiles stop at URL zoom 7; beyond that they serve a
    // literal "Zoom Level Not Supported" image, so Leaflet must upscale
    maxNativeZoom: 8,
    maxZoom: 18,
    attribution: 'Radar: <a href="https://www.rainviewer.com/">RainViewer</a>',
  });
  if (l.on) {
    l.on("load", () => { l._warm = true; });
    l.on("tileerror", () => setSatStatus("tiles failing"));
  }
  return l;
}

function layerFor(path) {
  let l = radarLayers.get(path);
  if (!l) {
    l = makeRadarLayer(radarUrl(path)).addTo(map);
    radarLayers.set(path, l);
  }
  return l;
}

function radarFrameFor(tMs) {
  let best = null, bestD = Infinity;
  for (const f of radarFrames) {
    const d = Math.abs(f.time * 1000 - tMs);
    if (d < bestD) { bestD = d; best = f; }
  }
  return bestD <= 15 * 60_000 ? best : null;
}

/* Show the frame matching the displayed time: latest when live, the nearest
   archive frame when scrubbing the last ~2h, hidden (with an honest status)
   beyond the archive. Every frame is a persistent preloaded layer, so a
   scrub is just an opacity flip between layers that are already on the map
   \u2014 no network, nothing to fade. A cold (not yet loaded) frame defers its
   flip until loaded, keeping the previous frame visible meanwhile. */
function applyRadarFrame() {
  if (!radarOn || !radarHost || !radarFrames.length) return;
  const pane = map.getPane && map.getPane("clouds");
  const f = displayedT === null
    ? radarFrames[radarFrames.length - 1]
    : radarFrameFor(displayedTime() ?? Date.now());
  if (!f) {
    if (pane) pane.style.display = "none";
    setSatStatus("no archive at this time");
    return;
  }
  if (pane) pane.style.display = "";
  if (f.path === radarShown) return;
  radarShown = f.path;
  satLabel = new Date(f.time * 1000).toLocaleTimeString("en-SG",
    { timeZone: "Asia/Singapore", hour: "2-digit", minute: "2-digit" });
  const l = layerFor(f.path);
  const finalize = () => {
    if (radarShown !== f.path) return; // the scrub has moved on
    for (const [p, ly] of radarLayers) ly.setOpacity(p === f.path ? 0.7 : 0);
    setSatStatus(`radar ${satLabel}`);
  };
  if (l._warm || !l.once) finalize();
  else l.once("load", finalize);
}

async function fetchSatellite() {
  if (!radarOn) { setSatStatus("off"); return; }
  const res = await fetch429(RV_META_URL);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  radarHost = json.host;
  // past ~2h plus RainViewer's ~30-minute nowcast, so the slider's first
  // forecast steps still show projected rain
  radarFrames = [...(json.radar?.past ?? []), ...(json.radar?.nowcast ?? [])];
  if (!radarFrames.length) { setSatStatus("no radar frames"); return; }
  const valid = new Set(radarFrames.map((f) => f.path));
  for (const [p, ly] of radarLayers) {
    if (!valid.has(p)) {
      ly.remove();
      radarLayers.delete(p);
      if (radarShown === p) radarShown = null;
    }
  }
  if (!radarLayers.size) setSatStatus("loading radar\u2026");
  applyRadarFrame();
  // warm every frame in the background so scrubbing flips instantly
  setTimeout(() => {
    if (radarOn && radarHost) for (const f of radarFrames) layerFor(f.path);
  }, 2500);
}

function pollSatellite() {
  fetchSatellite().catch((e) => setSatStatus(`unreachable (${e.message})`));
}


// Bilinear sample over a WGRID-shaped array (row 0 = north); null on NaN.
function gridSample2(arr, lat, lon) {
  const { nx, ny } = WGRID;
  let fy = ((OVERLAY.latMax - lat) / (OVERLAY.latMax - OVERLAY.latMin)) * ny - 0.5;
  let fx = ((lon - OVERLAY.lonMin) / (OVERLAY.lonMax - OVERLAY.lonMin)) * nx - 0.5;
  fy = Math.min(ny - 1, Math.max(0, fy));
  fx = Math.min(nx - 1, Math.max(0, fx));
  const cy = Math.min(ny - 2, Math.floor(fy));
  const cx = Math.min(nx - 2, Math.floor(fx));
  const ty = fy - cy, tx = fx - cx;
  const v00 = arr[cy * nx + cx], v01 = arr[cy * nx + cx + 1];
  const v10 = arr[(cy + 1) * nx + cx], v11 = arr[(cy + 1) * nx + cx + 1];
  if (Number.isNaN(v00) || Number.isNaN(v01) || Number.isNaN(v10) || Number.isNaN(v11)) return null;
  const top = v00 + (v01 - v00) * tx;
  const bot = v10 + (v11 - v10) * tx;
  return top + (bot - top) * ty;
}

function ensureWindField() {
  if ((displayedT === null ? Infinity : displayedT) !== windFieldT) updateWindField();
}

async function fetchWindAt(dt) {
  const q = dt ? `?date_time=${encodeURIComponent(sgtStamp(dt))}` : "";
  const [spd, dir] = await Promise.all([WIND_SPEED_URL + q, WIND_DIR_URL + q].map(async (url) => {
    const res = await fetch429(url);
    if (!res.ok) throw new Error(`wind HTTP ${res.status}`);
    return res.json();
  }));
  const locs = new Map();
  for (const s of [...spd.metadata.stations, ...dir.metadata.stations]) locs.set(s.id, s);
  return {
    locs,
    ts: new Date(spd.items[0].timestamp).getTime(),
    speeds: new Map(spd.items[0].readings.map((r) => [r.station_id, r.value])),
    dirs: new Map(dir.items[0].readings.map((r) => [r.station_id, r.value])),
  };
}

// Whole-day files: every snapshot of the day, catching stations no matter
// which minutes they reported in.
async function fetchWindDayRaw(dayStr) {
  const [spd, dir] = await Promise.all(
    [`${WIND_SPEED_URL}?date=${dayStr}`, `${WIND_DIR_URL}?date=${dayStr}`].map(async (url) => {
      const res = await fetch429(url);
      if (!res.ok) throw new Error(`wind day HTTP ${res.status}`);
      return res.json();
    }));
  const locs = new Map();
  for (const s of [...spd.metadata.stations, ...dir.metadata.stations]) locs.set(s.id, s);
  const dirByTs = new Map(dir.items.map((it) => [it.timestamp, it.readings]));
  for (const it of spd.items) {
    const dirReadings = dirByTs.get(it.timestamp);
    if (!dirReadings) continue;
    const degs = new Map(dirReadings.map((r) => [r.station_id, r.value]));
    const t = new Date(it.timestamp).getTime();
    for (const r of it.readings) {
      addWindPoint(r.station_id, locs.get(r.station_id), t, r.value, degs.get(r.station_id));
    }
  }
}

// Deferred wind archive: only needed for scrubbing, so it loads after the
// temperature history instead of competing with it at startup. Total
// failure (rate limit) retries itself with backoff rather than leaving the
// session windless.
let windHistRetries = 0;

async function loadWindHistory() {
  if (windDayLoaded) return;
  let ok = false;
  for (const day of [sgtDate(new Date()), sgtDate(new Date(Date.now() - 86_400_000))]) {
    try {
      await fetchWindDayRaw(day);
      ok = true;
    } catch { /* day files are best-effort */ }
  }
  if (!ok) {
    if (windHistRetries++ < 3) {
      setTimeout(() => loadWindHistory().catch(() => {}), 60_000 * windHistRetries);
    }
    return;
  }
  windDayLoaded = true;
  updateWindField();
  renderWindStatus();
  renderWindPins();
  scheduleRender();
  if (typeof localStorage !== "undefined") saveHistCache();
}

async function fetchWind() {
  const snap = await fetchWindAt();
  for (const [id, kn] of snap.speeds) {
    addWindPoint(id, snap.locs.get(id), snap.ts, kn, snap.dirs.get(id));
  }
  const cutoff = Date.now() - (HISTORY_HOURS + 1) * 3600_000;
  for (const st of windStations.values()) {
    while (st.series.length && st.series[0].t < cutoff) st.series.shift();
  }
  updateWindField();
  renderWindStatus();
  renderWindPins();
  scheduleRender(); // hybrid pill socks may have changed
}

/* Wind direction glyph: a windsock wedge — a tapered streak growing out
   from under the marker's edge, extending downwind, longer in stronger
   wind, fading at the tip. On hybrid stations it's drawn in the pill's own
   temperature colour so pill + sock read as one object. The (a, b) ellipse
   semi-axes approximate the host marker's outline so the wedge emerges
   flush from its rim at any angle. */
function tailGeom(wv, a = 0, b = 0) {
  const kmh = Math.hypot(wv.u, wv.v);
  const toward = (Math.atan2(wv.u, wv.v) * 180 / Math.PI + 360) % 360;
  const rot = toward - 90; // CSS rotation: 0deg points east on screen
  let inset = 3;
  if (a && b) {
    // start right at the host marker's rim (3px tucked under, hiding the seam)
    const t = (rot * Math.PI) / 180;
    inset = (a * b) / Math.sqrt((b * Math.cos(t)) ** 2 + (a * Math.sin(t)) ** 2) - 3;
  }
  return {
    rot: Math.round(rot),
    len: Math.round(Math.min(46, 14 + kmh * 2)),
    inset: Math.round(inset),
  };
}

function sockStyle(g, color) {
  return `width:${g.len}px;transform:rotate(${g.rot}deg) translateX(${g.inset}px);` +
    `background:linear-gradient(90deg, ${color}, ${color} 30%, transparent 95%)`;
}

function windSockHtml(wv, a, b, color) {
  return `<span class="wind-sock" style="${sockStyle(tailGeom(wv, a, b), color)}"></span>`;
}

function applySock(el, wv, a, b, color) {
  const g = tailGeom(wv, a, b);
  el.style.width = `${g.len}px`;
  el.style.transform = `rotate(${g.rot}deg) translateX(${g.inset}px)`;
  el.style.background = `linear-gradient(90deg, ${color}, ${color} 30%, transparent 95%)`;
}

// Standalone anemometer pins (dot + tail). Stations that also report
// temperature are "hybrid": their wind tail rides on the temperature pill
// instead, so no separate pin.
const windPins = new Map();

function renderWindPins() {
  if (typeof L === "undefined" || !map) return;
  ensureWindField();
  const seen = new Set();
  for (const p of windVectors) {
    if (stations.get(p.id)?.kind === "nea") {
      const existing = windPins.get(p.id);
      if (existing) { existing.remove(); windPins.delete(p.id); }
      continue;
    }
    seen.add(p.id);
    const kmh = Math.hypot(p.u, p.v);
    const from = (tailGeom(p).rot + 90 + 180) % 360;
    let m = windPins.get(p.id);
    if (!m) {
      m = L.marker([p.lat, p.lon], { keyboard: false }).addTo(map);
      windPins.set(p.id, m);
    }
    m.setIcon(L.divIcon({
      className: "",
      html: `<span class="wind-spot">${windSockHtml(p, 5, 5, "rgba(159, 208, 255, 0.9)")}<span class="wind-dot"></span></span>`,
      iconSize: [0, 0],
    }));
    m.bindTooltip(`${p.name} · ${kmh.toFixed(0)} km/h from ${COMPASS[Math.round(from / 22.5) % 16]}`);
  }
  for (const [id, m] of windPins) {
    if (!seen.has(id)) { m.remove(); windPins.delete(id); }
  }
}

function pollWind() {
  fetchWind().catch(() => renderWindStatus());
}

function windVecAt(lat, lon) {
  ensureWindField();
  if (windGridU) { // observed at displayed time, precomputed grid
    const u = gridSample2(windGridU, lat, lon);
    const v = gridSample2(windGridV, lat, lon);
    return u == null || v == null ? null : { u, v };
  }
  if (!windU) return null; // fall back to the model field if we have one
  const u = gridSample(windU, lat, lon);
  const v = gridSample(windV, lat, lon);
  return u == null || v == null ? null : { u, v };
}

// Island-average wind in the footer — doubles as a diagnostic that wind
// data is actually flowing (shows "–" if the model has no wind field).
const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
  "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];

function renderWindStatus() {
  const el = document.getElementById("wind-status");
  ensureWindField();
  let u = 0, v = 0, n = 0, src = "";
  if (windVectors.length) {
    for (const p of windVectors) { u += p.u; v += p.v; n++; }
    src = ` (${windVectors.length} stations)`;
  } else if (windU) {
    for (let i = 0; i < windU.length; i++) {
      if (!Number.isNaN(windU[i]) && !Number.isNaN(windV[i])) { u += windU[i]; v += windV[i]; n++; }
    }
    src = " (model)";
  }
  if (!n) { el.textContent = "–"; return; }
  u /= n; v /= n;
  const speed = Math.hypot(u, v);
  const from = (Math.atan2(-u, -v) * 180 / Math.PI + 360) % 360;
  el.textContent = `${speed.toFixed(0)} km/h from ${COMPASS[Math.round(from / 22.5) % 16]}${src}`;
}

// Bilinear sample of a blended grid at a coordinate.
function gridSample(grid, lat, lon) {
  const fy = ((OVERLAY.latMax - lat) / (OVERLAY.latMax - OVERLAY.latMin)) * (GRID_NLAT - 1);
  const fx = ((lon - OVERLAY.lonMin) / (OVERLAY.lonMax - OVERLAY.lonMin)) * (GRID_NLON - 1);
  const cy = Math.min(GRID_NLAT - 2, Math.max(0, Math.floor(fy)));
  const cx = Math.min(GRID_NLON - 2, Math.max(0, Math.floor(fx)));
  const ty = Math.min(1, Math.max(0, fy - cy)), tx = Math.min(1, Math.max(0, fx - cx));
  // grid index iy counts from latMin upward; fy counts from latMax downward
  const at = (iy, ix) => grid[(GRID_NLAT - 1 - iy) * GRID_NLON + ix];
  const v00 = at(cy, cx), v01 = at(cy, cx + 1), v10 = at(cy + 1, cx), v11 = at(cy + 1, cx + 1);
  if ([v00, v01, v10, v11].some(Number.isNaN)) return null;
  const top = v00 + (v01 - v00) * tx;
  const bot = v10 + (v11 - v10) * tx;
  return top + (bot - top) * ty;
}

// Station residuals vs the model at the displayed time: where NEA disagrees
// with Open-Meteo, the field is nudged toward the real sensor nearby.
function computeResiduals(obsPts, grid) {
  const out = [];
  for (const p of obsPts) {
    const m = gridSample(grid, p.lat, p.lon);
    if (m != null) out.push({ lat: p.lat, lon: p.lon, r: p.v - m, wt: p.wt ?? 1 });
  }
  return out;
}

function fieldAt(lat, lon, grid, residuals) {
  const base = gridSample(grid, lat, lon);
  if (base == null) return null;
  let wSum = 0, rSum = 0;
  for (const p of residuals) {
    const dx = (lon - p.lon) * Math.cos((1.35 * Math.PI) / 180) * KM_PER_DEG;
    const dy = (lat - p.lat) * KM_PER_DEG;
    const w = (p.wt ?? 1) / (dx * dx + dy * dy + 0.05);
    wSum += w;
    rSum += w * p.r;
  }
  return base + rSum / (wSum + RESIDUAL_LAMBDA);
}

// ---------- temperature colour scale (light blue = cool -> orange = hot) ----------

// The ramp is normalized each render to the temperatures actually on screen,
// so the full blue->orange range is always in use (the legend shows what the
// endpoints currently mean). MIN_SPAN stops sensor noise from exploding into
// rainbow colours when the island is uniformly warm.
const RAMP = [[124, 199, 255], [255, 224, 138], [255, 122, 26]];
const MIN_SPAN = 2;
let scaleLo = 25, scaleHi = 35;

function tempRGB(v) {
  const f = Math.min(1, Math.max(0, (v - scaleLo) / (scaleHi - scaleLo || 1)));
  const pos = f * (RAMP.length - 1);
  const i = Math.min(RAMP.length - 2, Math.floor(pos));
  const t = pos - i;
  return RAMP[i].map((c, k) => Math.round(c + (RAMP[i + 1][k] - c) * t));
}

function tempColor(v) {
  return `rgb(${tempRGB(v).join(",")})`;
}

let scaleInit = false;

function updateScale(values, grid) {
  let lo = Infinity, hi = -Infinity;
  for (const [id, v] of values) {
    if (stations.get(id)?.kind === "civ") continue; // scale anchored to official data
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (grid) for (const g of grid) {
    if (!Number.isNaN(g)) { if (g < lo) lo = g; if (g > hi) hi = g; }
  }
  if (!Number.isFinite(lo)) return;
  if (hi - lo < MIN_SPAN) {
    const mid = (hi + lo) / 2;
    lo = mid - MIN_SPAN / 2;
    hi = mid + MIN_SPAN / 2;
  }
  if (!scaleInit) {
    scaleLo = lo;
    scaleHi = hi;
    scaleInit = true;
  } else {
    // ease toward the target so the palette doesn't jump while scrubbing
    scaleLo += (lo - scaleLo) * 0.4;
    scaleHi += (hi - scaleHi) * 0.4;
  }
  document.getElementById("legend-lo").textContent = fmt(scaleLo);
  document.getElementById("legend-hi").textContent = fmt(scaleHi);
}

// ---------- data flow ----------

function upsertStation(info) {
  let s = stations.get(info.id);
  if (!s) {
    s = { kind: "nea", ...info, series: new Map(), history: [], latest: null, marker: null, listEl: null };
    stations.set(info.id, s);
    if (Number.isFinite(s.lat) && Number.isFinite(s.lon)) {
      s.marker = L.marker([s.lat, s.lon], {
        icon: L.divIcon({ className: "", html: "", iconSize: [0, 0] }),
      }).addTo(map);
      s.marker.on("click", () => selectStation(s.id));
    }
  }
  return s;
}

function ingest(result) {
  const maxT = Date.now() + 10 * 60_000; // guard against bogus future stamps
  for (const info of result.stations) upsertStation(info);
  for (const item of result.items) {
    const t = new Date(item.timestamp).getTime();
    if (!Number.isFinite(t) || t > maxT) continue;
    for (const [id, value] of item.readings) {
      stations.get(id)?.series.set(t, value);
    }
  }
}

// Prune to the 24h window and rebuild the sorted views the renderers use.
// Displayed series are smoothed with a centered rolling mean so per-minute
// sensor jitter (a few 0.1°) doesn't flash colours while scrubbing.
const SMOOTH_HALF_MS = 7.5 * 60_000; // 15-minute window

function rebuild(now = Date.now()) {
  const cutoff = now - HISTORY_HOURS * 3600_000;
  const times = new Set();
  for (const s of stations.values()) {
    for (const t of s.series.keys()) {
      if (t < cutoff) s.series.delete(t);
      else times.add(t);
    }
    const raw = [...s.series].map(([t, v]) => ({ t, v })).sort((a, b) => a.t - b.t);
    let a = 0, b = 0, sum = 0;
    s.history = raw.map((p) => {
      while (b < raw.length && raw[b].t <= p.t + SMOOTH_HALF_MS) sum += raw[b++].v;
      while (raw[a].t < p.t - SMOOTH_HALF_MS) sum -= raw[a++].v;
      return { t: p.t, v: sum / (b - a) };
    });
    s.latest = s.history.length ? s.history[s.history.length - 1].v : null;
  }
  timeline = [...times].sort((a, b) => a - b);

  // Uniform 5-minute ticks: -24h .. LIVE .. +24h, so LIVE sits dead centre
  // and both directions scrub at the same speed. Past values resolve via
  // valueAt (30-min tolerance); future values interpolate the hourly model
  // smoothly, so 5-minute forecast steps cost nothing extra.
  const step = SLIDER_STEP_MIN * 60_000;
  const anchor = Math.floor(now / step) * step;
  sliderTicks = [];
  for (let i = -HISTORY_HOURS * 12; i <= 0; i++) sliderTicks.push(anchor + i * step);
  sliderLiveIdx = sliderTicks.length - 1;
  if (model) {
    const horizon = Math.min(
      anchor + FORECAST_HOURS * 3600_000,
      model.times[model.times.length - 1]);
    for (let t = anchor + step; t <= horizon; t += step) sliderTicks.push(t);
  }
}

// Largest reading at or before t (binary search), within a 30-minute tolerance.
function valueAt(s, t) {
  const h = s.history;
  let lo = 0, hi = h.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (h[mid].t <= t) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (best < 0 || t - h[best].t > 30 * 60_000) return null;
  return h[best].v;
}

function displayedTime() {
  return displayedT ?? (timeline.length ? timeline[timeline.length - 1] : null);
}

function isFutureView() {
  return displayedT !== null && timeline.length > 0 && displayedT > timeline[timeline.length - 1];
}

/* Live view shows each station's last known reading (within 2h) rather than
   filtering against the single newest timestamp — the latest 1-minute
   snapshot can be sparse (one station reporting alone), and anchoring on it
   used to blank every other pill. Scrubbed times keep the strict 30-minute
   tolerance: history should be honest about gaps. */
function displayedValues(t, wobbleMs = null) {
  const out = new Map();
  if (t == null) return out;
  const live = displayedT === null;
  if (isFutureView()) {
    // forecast: model field at t, nudged by each station's current bias
    // against the model (a station that runs hot now likely stays hot)
    const gridT = buildBlendedGrid(t);
    if (!gridT) return out;
    const gridNow = buildBlendedGrid(Date.now());
    for (const s of stations.values()) {
      if (s.kind !== "nea" || !Number.isFinite(s.lat)) continue;
      const m = gridSample(gridT, s.lat, s.lon);
      if (m == null) continue;
      let bias = 0;
      const mNow = gridNow ? gridSample(gridNow, s.lat, s.lon) : null;
      if (s.latest != null && mNow != null) {
        bias = Math.max(-2, Math.min(2, s.latest - mNow));
      }
      out.set(s.id, m + bias);
    }
    return out;
  }
  for (const s of stations.values()) {
    let v = null;
    if (live) {
      const last = s.history[s.history.length - 1];
      if (last && Date.now() - last.t < 2 * 3600_000) v = last.v;
    } else {
      v = valueAt(s, t);
    }
    if (v != null) out.set(s.id, wobbleMs == null ? v : v + liveWobble(s.id, wobbleMs));
  }
  return out;
}

// Per-station drift (±0.09°, phase from the station id) shown only on the
// live view, so the last decimal visibly ticks like a live feed. The
// amplitude has to exceed ~0.05 or rounding to one decimal hides it.
const WOBBLE_AMP = 0.09;

function liveWobble(id, ms) {
  let p = 0;
  for (let i = 0; i < id.length; i++) p = (p * 31 + id.charCodeAt(i)) | 0;
  return WOBBLE_AMP * (0.6 * Math.sin(ms / 2600 + p) + 0.4 * Math.sin(ms / 900 + p * 1.7));
}

// Light-weight refresh of the number displays (no overlay re-rasterization).
function renderLive() {
  if (displayedT !== null) return;
  if (typeof document !== "undefined" && document.hidden) return;
  const t = displayedTime();
  if (t == null) return;
  const values = displayedValues(t, Date.now());
  for (const s of stations.values()) renderMarker(s, values.get(s.id));
  renderList(values);
  renderSummary(values);
  renderDetail(values, t);
}

// ---------- rendering ----------

function fmt(v) {
  return v == null ? "–" : `${v.toFixed(1)}°`;
}

function fmtTime(t) {
  return new Date(t).toLocaleTimeString("en-SG",
    { timeZone: "Asia/Singapore", weekday: "short", hour: "2-digit", minute: "2-digit" });
}

// 0 = night, 1 = day, smooth ramps through twilight. Singapore sits on the
// equator, so sunrise/sunset barely move all year (~07:00 / ~19:10 SGT).
// The ramps span two hours so the shift never feels like a switch. Daytime
// just lifts the dark basemap's brightness a touch — "the dark theme,
// slightly lighter" — so day never washes out contrast or clashes with the
// temperature ramp's hues.
const DAY_BRIGHT_BOOST = 0.4;

function smooth01(x) {
  x = Math.min(1, Math.max(0, x));
  return x * x * (3 - 2 * x);
}

function dayFactor(t) {
  const d = new Date(t + 8 * 3600_000); // SGT wall clock via UTC getters
  const h = d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600;
  return Math.min(smooth01((h - 6.0) / 2.0), 1 - smooth01((h - 18.2) / 2.0));
}

/* Rebuilding a divIcon replaces its DOM node, which reads as a flash (and
   restarts the pulse animation). So the icon is only rebuilt when its
   structure changes (selection, live state, value appearing); routine value
   ticks just rewrite the text and colour in place. */
function renderMarker(s, v) {
  if (!s.marker) return;
  if (v == null) {
    if (s.iconKey !== "empty") {
      s.marker.setIcon(L.divIcon({ className: "", html: "", iconSize: [0, 0] }));
      s.iconKey = "empty";
    }
    return;
  }
  let key, html;
  if (s.kind === "civ") {
    const sel = s.id === selectedId ? " selected" : "";
    key = `civ${sel}`;
    html = `<span class="civ-marker${sel}">` +
      `<span class="civ-temp">${fmt(v)}</span>` +
      `<span class="civ-dot" style="--pill:${tempColor(v)}"></span></span>`;
  } else {
    let cls = s.id === selectedId ? "temp-pill selected" : "temp-pill";
    if (isFutureView()) cls += " fc"; // dashed = forecast, not observation
    // hybrid: observed wind, or the model wind when viewing the future
    const wv = windVectorsById.get(s.id) ??
      (isFutureView() ? windVecAt(s.lat, s.lon) : null);
    key = cls + (wv ? "+wind" : "");
    html = `${wv ? windSockHtml(wv, 22, 9, tempColor(v)) : ""}` +
      `<span class="${cls}" style="--pill:${tempColor(v)}">${fmt(v)}</span>`;
  }

  const root = s.iconKey === key && s.marker.getElement && s.marker.getElement();
  if (root && root.querySelector) {
    const text = root.querySelector(s.kind === "civ" ? ".civ-temp" : ".temp-pill");
    const tinted = root.querySelector(s.kind === "civ" ? ".civ-dot" : ".temp-pill");
    if (text && tinted && tinted.style && tinted.style.setProperty) {
      text.textContent = fmt(v);
      tinted.style.setProperty("--pill", tempColor(v));
      if (s.kind !== "civ") {
        const wv = windVectorsById.get(s.id) ??
          (isFutureView() ? windVecAt(s.lat, s.lon) : null);
        const sock = root.querySelector(".wind-sock");
        if (wv && sock && sock.style) applySock(sock, wv, 22, 9, tempColor(v));
      }
      return;
    }
  }
  s.marker.setIcon(L.divIcon({ className: "", html, iconSize: [0, 0] }));
  s.iconKey = key;
  s.marker.bindTooltip(s.name);
}

function sparkPoints(history, w, h, pad = 2, maxPts = 240) {
  if (history.length < 2) return null;
  const stride = Math.max(1, Math.ceil(history.length / maxPts));
  const pts = history.filter((_, i) => i % stride === 0 || i === history.length - 1);
  const vs = pts.map((p) => p.v);
  const lo = Math.min(...vs), hi = Math.max(...vs);
  const span = hi - lo || 1;
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t;
  const tSpan = t1 - t0 || 1;
  return pts.map((p) => {
    const x = pad + ((p.t - t0) / tSpan) * (w - 2 * pad);
    const y = h - pad - ((p.v - lo) / span) * (h - 2 * pad);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
}

let listFilter = "all";
const windListEls = new Map();
let lastListRows = new Set();

function tempRow(s, values) {
  if (!s.listEl) {
    s.listEl = document.createElement("li");
    s.listEl.innerHTML = `
      <span class="station-name"></span>
      <svg class="station-spark" viewBox="0 0 70 24" preserveAspectRatio="none"><polyline points=""/></svg>
      <span class="station-temp"></span>`;
    s.listEl.addEventListener("click", () => selectStation(s.id));
  }
  const v = values.get(s.id);
  s.listEl.querySelector(".station-name").textContent = s.name;
  const temp = s.listEl.querySelector(".station-temp");
  temp.textContent = fmt(v);
  temp.style.color = tempColor(v);
  const line = s.listEl.querySelector("polyline");
  const pts = sparkPoints(s.history, 70, 24, 2, 120);
  if (pts) {
    line.setAttribute("points", pts);
    line.setAttribute("stroke", tempColor(v));
  }
  s.listEl.classList.toggle("selected", s.id === selectedId);
  return s.listEl;
}

function windRow(p) {
  let el = windListEls.get(p.id);
  if (!el) {
    el = document.createElement("li");
    el.className = "wind-row";
    el.innerHTML = `
      <span class="station-name"></span>
      <span class="wind-row-dir"></span>
      <span class="station-temp wind-speed"></span>`;
    el.addEventListener("click", () => { if (map && map.panTo) map.panTo([p.lat, p.lon]); });
    windListEls.set(p.id, el);
  }
  const kmh = Math.hypot(p.u, p.v);
  el.querySelector(".station-name").textContent = p.name;
  el.querySelector(".wind-row-dir").innerHTML = windSockHtml(p, 2, 2, "rgba(94, 193, 255, 0.9)");
  el.querySelector(".wind-speed").textContent = `${kmh.toFixed(0)} km/h`;
  return el;
}

function civRow(s, values) {
  if (!s.listEl) {
    s.listEl = document.createElement("li");
    s.listEl.className = "civ-row";
    s.listEl.innerHTML = `<span class="station-name"></span><span class="station-temp"></span>`;
    s.listEl.addEventListener("click", () => selectStation(s.id));
  }
  const v = values.get(s.id);
  s.listEl.querySelector(".station-name").textContent = s.name;
  const temp = s.listEl.querySelector(".station-temp");
  temp.textContent = fmt(v);
  temp.style.color = tempColor(v);
  s.listEl.classList.toggle("selected", s.id === selectedId);
  return s.listEl;
}

function renderList(values) {
  const ul = document.getElementById("station-list");
  const rows = [];
  if (listFilter === "all" || listFilter === "temp") {
    const temp = [...stations.values()]
      .filter((s) => s.kind === "nea" && values.has(s.id))
      .sort((a, b) => values.get(b.id) - values.get(a.id));
    for (const s of temp) rows.push(tempRow(s, values));
  }
  if (listFilter === "all" || listFilter === "wind") {
    ensureWindField();
    const wind = windVectors.slice().sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const p of wind) rows.push(windRow(p));
  }
  if (listFilter === "all" || listFilter === "civ") {
    const civ = [...stations.values()].filter((s) => s.kind === "civ" && values.has(s.id));
    for (const s of civ) rows.push(civRow(s, values));
  }
  document.getElementById("station-count").textContent = `(${rows.length})`;
  const current = new Set(rows);
  for (const el of lastListRows) {
    if (!current.has(el) && el.remove) el.remove(); // filtered out since last render
  }
  lastListRows = current;
  for (const el of rows) ul.appendChild(el); // re-appending keeps order
}

// Headline stats stay official-only so one sun-baked balcony sensor can't
// become the island's "hottest".
function renderSummary(values) {
  const vals = [...stations.values()]
    .filter((s) => s.kind === "nea" && values.has(s.id))
    .map((s) => values.get(s.id));
  if (!vals.length) return;
  const el = (id) => document.getElementById(id);
  el("stat-min").textContent = fmt(Math.min(...vals));
  el("stat-max").textContent = fmt(Math.max(...vals));
  el("stat-mean").textContent = fmt(vals.reduce((a, b) => a + b, 0) / vals.length);
}

function renderDetail(values, t) {
  const panel = document.getElementById("detail");
  const s = stations.get(selectedId);
  if (!s) { panel.classList.add("hidden"); return; }
  panel.classList.remove("hidden");
  document.getElementById("detail-name").textContent = s.name;
  const v = values.get(s.id);
  document.getElementById("detail-temp").textContent = fmt(v);
  document.getElementById("detail-temp").style.color = tempColor(v ?? 30);
  document.getElementById("detail-when").textContent = t ? `at ${fmtTime(t)} SGT` : "";

  const svg = document.getElementById("detail-spark");
  svg.innerHTML = "";
  const pts = sparkPoints(s.history, 320, 80, 6);
  if (pts) {
    const first = pts.split(" ")[0].split(",")[0];
    const last = pts.split(" ").at(-1).split(",")[0];
    let cursor = "";
    if (t && s.history.length > 1) {
      const t0 = s.history[0].t, t1 = s.history[s.history.length - 1].t;
      const x = 6 + (Math.min(1, Math.max(0, (t - t0) / (t1 - t0 || 1))) * 308);
      cursor = `<line class="spark-cursor" x1="${x.toFixed(1)}" y1="0" x2="${x.toFixed(1)}" y2="80"/>`;
    }
    svg.innerHTML =
      `<polygon class="spark-fill" points="${first},80 ${pts} ${last},80"/>` +
      `<polyline points="${pts}"/>` + cursor;
  }
  const vs = s.history.map((p) => p.v);
  document.getElementById("detail-low").textContent = vs.length ? fmt(Math.min(...vs)) : "–";
  document.getElementById("detail-high").textContent = vs.length ? fmt(Math.max(...vs)) : "–";
}

/* Shading overlay, rasterized to a small canvas and stretched over the island
   as an image layer. With the Open-Meteo model loaded, every pixel is the
   model field corrected by nearby station residuals (smooth everywhere, exact
   at the sensors). Without it, falls back to station-only IDW with alpha
   fading away from stations, since values far from any sensor are guesswork.
   Opacity scales with distance from the middle of the colour scale: average
   areas are transparent (map stays readable), only genuine hot and cold
   anomalies get painted. */
const OVERLAY_MAX_ALPHA = 0.48;

// Steep curve: fully transparent only in a thin band at the scale midpoint
// (a wide band produced visible "transparency stripes" along the contour
// where the field crosses the middle), full colour from ~25% out.
function extremeness(val) {
  const f = Math.min(1, Math.max(0, (val - scaleLo) / (scaleHi - scaleLo || 1)));
  return smooth01(Math.abs(f - 0.5) * 4);
}
function renderOverlay(values, grid) {
  const pts = [...stations.values()]
    .filter((s) => values.has(s.id) && Number.isFinite(s.lat) && Number.isFinite(s.lon))
    .map((s) => ({
      lat: s.lat, lon: s.lon, v: values.get(s.id),
      wt: s.kind === "civ" ? CIV_RESIDUAL_WT : 1,
    }));
  if (!grid && pts.length < 3) return;
  const residuals = grid ? computeResiduals(pts, grid) : [];

  if (!overlayCanvas) {
    overlayCanvas = document.createElement("canvas");
    overlayCanvas.width = OVERLAY.w;
    overlayCanvas.height = OVERLAY.h;
  }
  if (typeof overlayCanvas.getContext !== "function") return;
  const n = OVERLAY.w * OVERLAY.h;
  if (!fieldCache) {
    fieldCache = new Float32Array(n);
    fadeCache = new Float32Array(n);
  }
  const cosLat = Math.cos((1.35 * Math.PI) / 180);
  const edgePx = Math.round(OVERLAY.w * 0.05);

  for (let py = 0; py < OVERLAY.h; py++) {
    const lat = OVERLAY.latMax - ((py + 0.5) / OVERLAY.h) * (OVERLAY.latMax - OVERLAY.latMin);
    for (let px = 0; px < OVERLAY.w; px++) {
      const lon = OVERLAY.lonMin + ((px + 0.5) / OVERLAY.w) * (OVERLAY.lonMax - OVERLAY.lonMin);
      const i = py * OVERLAY.w + px;
      if (grid) {
        const val = fieldAt(lat, lon, grid, residuals);
        if (val == null) { fieldCache[i] = NaN; continue; }
        fieldCache[i] = val;
        // soft fade only at the raster's outer edges
        const edge = Math.min(px, OVERLAY.w - 1 - px, py, OVERLAY.h - 1 - py) / edgePx;
        fadeCache[i] = Math.min(1, edge);
      } else {
        let wSum = 0, vSum = 0, nearest = Infinity;
        for (const p of pts) {
          const dx = (lon - p.lon) * cosLat * KM_PER_DEG;
          const dy = (lat - p.lat) * KM_PER_DEG;
          const d2 = dx * dx + dy * dy + 0.05;
          const w = p.wt / d2; // IDW, power 2
          wSum += w;
          vSum += w * p.v;
          if (d2 < nearest) nearest = d2;
        }
        fieldCache[i] = vSum / wSum;
        // full shade within 8 km of a station, gone past 18 km
        fadeCache[i] = Math.min(1, Math.max(0, (18 - Math.sqrt(nearest)) / 10));
      }
    }
  }
  paintOverlay();
}

/* Colour pass over the cached field. */
function paintOverlay() {
  if (!fieldCache || !overlayCanvas || typeof overlayCanvas.getContext !== "function") return;
  const ctx = overlayCanvas.getContext("2d");
  const img = ctx.createImageData(OVERLAY.w, OVERLAY.h);
  for (let py = 0; py < OVERLAY.h; py++) {
    for (let px = 0; px < OVERLAY.w; px++) {
      const i = py * OVERLAY.w + px;
      const v = fieldCache[i];
      if (Number.isNaN(v)) continue;
      const alpha = OVERLAY_MAX_ALPHA * extremeness(v) * fadeCache[i];
      if (alpha <= 0.004) continue;
      const [r, g, b] = tempRGB(v);
      const o = i * 4;
      img.data[o] = r; img.data[o + 1] = g; img.data[o + 2] = b;
      img.data[o + 3] = Math.round(alpha * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  const url = overlayCanvas.toDataURL();
  if (!overlayLayer) {
    overlayLayer = L.imageOverlay(url,
      [[OVERLAY.latMin, OVERLAY.lonMin], [OVERLAY.latMax, OVERLAY.lonMax]],
      { opacity: 1, interactive: false }).addTo(map);
  } else {
    overlayLayer.setUrl(url);
  }
}

function renderTimebar(t) {
  const slider = document.getElementById("time-slider");
  const label = document.getElementById("time-label");
  const liveBtn = document.getElementById("live-btn");
  slider.max = Math.max(0, sliderTicks.length - 1);
  if (displayedT === null) {
    slider.value = Math.max(0, sliderLiveIdx);
  } else {
    let lo = 0, hi = sliderTicks.length - 1, idx = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (sliderTicks[mid] <= displayedT) { idx = mid; lo = mid + 1; } else hi = mid - 1;
    }
    slider.value = idx;
  }
  const future = isFutureView();
  label.textContent = t ? (future ? `≈ ${fmtTime(t)}` : fmtTime(t)) : "–";
  if (label.classList) label.classList.toggle("future", future);
  // centre line marks LIVE once the forecast half exists (on the wrapper —
  // native range tracks paint over the input's own background)
  const wrap = slider.parentElement;
  if (wrap && wrap.classList) {
    wrap.classList.toggle("has-forecast", sliderTicks.length - 1 > sliderLiveIdx);
  }
  const f = dayFactor(t ?? Date.now());
  document.getElementById("sky-icon").textContent = f > 0.8 ? "☀️" : f < 0.2 ? "🌙" : "🌅";
  liveBtn.classList.toggle("active", displayedT === null);
}

function renderAll() {
  const t = displayedTime();
  const values = displayedValues(t);
  const grid = buildBlendedGrid(t ?? Date.now());
  updateWindBlend();
  ensureWindField(); // socks, pins, and particles follow the displayed time
  updateScale(values, grid); // normalize colours before anything draws
  if (map && map.getContainer) {
    const boost = 1 + DAY_BRIGHT_BOOST * dayFactor(t ?? Date.now());
    map.getContainer().style.setProperty("--day-boost", boost.toFixed(3));
  }
  for (const s of stations.values()) renderMarker(s, values.get(s.id));
  renderList(values);
  renderSummary(values);
  renderDetail(values, t);
  renderOverlay(values, grid);
  renderTimebar(t);
  renderWindStatus();
  renderWindPins();
  renderRain(); // rain follows the scrubber (24h series)
  applyRadarFrame(); // radar follows it too, within RainViewer's ~2h archive
}

// Coalesce slider-drag renders to animation frames.
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; renderAll(); });
}

function selectStation(id) {
  selectedId = id === selectedId ? null : id;
  const s = stations.get(selectedId);
  if (s && s.marker) map.panTo([s.lat, s.lon]);
  renderAll();
}

// ---------- wind particles ----------

/* A real particle system in geographic space: particles spawn inside data
   coverage, advect along the wind field, and carry their recent path as a
   list of lat/lon points. The whole canvas is redrawn from those geographic
   tails every frame, so panning keeps the streaks glued to the land — only
   the zoom animation (where Leaflet's projection jumps at the end) gets a
   brief fade. Toggled by the WIND button. */
const WIND_N = 400;
const WIND_TAIL = 20;          // tail samples per particle (pushed every 2nd tick)
const WIND_TICK_MS = 33;       // ~30fps
const WIND_DEG_PER_S = 0.0018; // visual exaggeration: °lat per second per km/h
const WIND_AGE_S = [8, 20];    // particle lifetime range
const WIND_COVER_KM = 12;      // no particles farther than this from a real sensor

let windOn = true, windCanvas = null, windCtx = null;
let windParts = [];

// Particles only where there's actual wind data nearby — the IDW field happily
// extrapolates over Malaysia, but that's invention, not data.
function windCovered(lat, lon) {
  if (windGridU) return gridSample2(windGridU, lat, lon) != null;
  const pts = windStations.size
    ? [...windStations.values()]
    : [...stations.values()].filter((s) => s.kind === "nea" && Number.isFinite(s.lat));
  if (!pts.length) return false;
  const cosLat = Math.cos((1.35 * Math.PI) / 180);
  for (const p of pts) {
    const dx = (lon - p.lon) * cosLat * KM_PER_DEG;
    const dy = (lat - p.lat) * KM_PER_DEG;
    if (dx * dx + dy * dy < WIND_COVER_KM * WIND_COVER_KM) return true;
  }
  return false;
}

function spawnPart(p = {}) {
  for (let i = 0; i < 8; i++) {
    const lat = OVERLAY.latMin + Math.random() * (OVERLAY.latMax - OVERLAY.latMin);
    const lon = OVERLAY.lonMin + Math.random() * (OVERLAY.lonMax - OVERLAY.lonMin);
    if (!windCovered(lat, lon)) continue;
    p.lat = lat;
    p.lon = lon;
    p.age = WIND_AGE_S[0] + Math.random() * (WIND_AGE_S[1] - WIND_AGE_S[0]);
    p.hist = [[lat, lon]];
    return p;
  }
  p.hist = [];
  p.age = 0.5; // no coverage found this round; retry shortly
  return p;
}

function startWind() {
  if (typeof window === "undefined") return;
  windCanvas = document.getElementById("wind");
  if (!windCanvas || typeof windCanvas.getContext !== "function") return;
  windCtx = windCanvas.getContext("2d");
  try { windOn = localStorage.getItem("sgtemp-wind") !== "off"; } catch { /* default on */ }
  updateWindBtn();

  // The canvas lives in its own map pane so it pans with the tiles, and the
  // zoomanim hook lets Leaflet's zoom animation scale the drawn particles
  // smoothly along with the map (same mechanism tiles use). At zoomend the
  // normal frame loop resumes and redraws crisp at the new zoom.
  const pane = map.createPane("windParticles");
  pane.style.zIndex = 450;
  pane.style.pointerEvents = "none";
  pane.appendChild(windCanvas);
  windCanvas.classList.add("leaflet-zoom-animated");

  const fit = () => {
    const size = map.getSize();
    windCanvas.width = size.x;
    windCanvas.height = size.y;
  };
  fit();
  map.on("resize", fit);

  /* Fluid zoom: while Leaflet's zoom animation CSS-scales the canvas from
     the old view to the new one, we keep advancing and redrawing particles
     in the OLD view's coordinate frame (computed explicitly from the
     pre-zoom zoom level, immune to Leaflet's internal state flipping
     mid-animation). The animated element transform carries that old-frame
     drawing to the right screen positions, so motion never pauses. Pinch
     zoom never fires zoomanim — its projections update live, so the normal
     path already handles it. */
  let zoomCand = null, zoomRef = null;
  map.on("zoomstart", () => {
    const z = map.getZoom();
    const o = map.project(map.containerPointToLatLng([0, 0]), z);
    zoomCand = { zoom: z, ox: o.x, oy: o.y };
  });
  map.on("zoomanim", (e) => {
    if (!map.getZoomScale || !map._latLngBoundsToNewLayerBounds) return;
    zoomRef = zoomCand;
    const scale = map.getZoomScale(e.zoom);
    const offset = map._latLngBoundsToNewLayerBounds(map.getBounds(), e.zoom, e.center).min;
    L.DomUtil.setTransform(windCanvas, offset, scale);
  });
  map.on("zoomend", () => { zoomRef = null; zoomCand = null; });

  windParts = Array.from({ length: WIND_N }, () => spawnPart());
  const cosLat = Math.cos((1.35 * Math.PI) / 180);
  let last = 0, tick = 0, spawnedFor = -1;

  // Particle budget scales with actual data coverage: with one or two
  // stations known, only a proportional handful of particles render around
  // them (constant density, so no swarm), and the field fills out as the
  // network loads — no more waiting for the whole archive before anything
  // moves. Re-scatter whenever the network grows meaningfully.
  const windBudget = () => {
    if (!windGridU) return 0; // fewer than 2 stations: no field to draw
    let covered = 0;
    for (let i = 0; i < windGridU.length; i++) {
      if (!Number.isNaN(windGridU[i])) covered++;
    }
    return Math.round((WIND_N * covered) / windGridU.length);
  };

  function frame(ts) {
    requestAnimationFrame(frame);
    if (!windOn || document.hidden) { last = ts; return; }
    ensureWindField();
    const budget = windBudget();
    if (!budget) { last = ts; return; }
    if (spawnedFor < 0 || windStations.size >= spawnedFor + 3) {
      spawnedFor = windStations.size;
      windParts.forEach((p) => spawnPart(p));
    }
    if (ts - last < WIND_TICK_MS) return;
    const dt = Math.min(0.1, (ts - last) / 1000);
    last = ts;
    tick++;

    const ref = zoomRef;
    const toPt = ref
      ? (ll) => { const p = map.project(ll, ref.zoom); return { x: p.x - ref.ox, y: p.y - ref.oy }; }
      : (ll) => map.latLngToContainerPoint(ll);
    // pin the canvas to the viewport — but never mid-zoom, where setPosition
    // would stomp the animated transform
    if (!ref) L.DomUtil.setPosition(windCanvas, map.containerPointToLayerPoint([0, 0]));
    windCtx.clearRect(0, 0, windCanvas.width, windCanvas.height);
    windCtx.lineCap = "round";
    for (let pi = 0; pi < budget; pi++) {
      const p = windParts[pi];
      const w = p.hist.length ? windVecAt(p.lat, p.lon) : null;
      if (p.hist.length && w && Number.isFinite(w.u)) {
        p.lat += w.v * WIND_DEG_PER_S * dt;
        p.lon += (w.u * WIND_DEG_PER_S * dt) / cosLat;
        if (tick % 2 === 0) {
          p.hist.push([p.lat, p.lon]);
          if (p.hist.length > WIND_TAIL) p.hist.shift();
        }
      }
      p.age -= dt;
      if (p.age <= 0 || !p.hist.length || !windCovered(p.lat, p.lon)) {
        spawnPart(p);
        continue;
      }
      if (p.hist.length < 2) continue;
      // faint full tail, brighter head
      windCtx.beginPath();
      let pt = toPt(p.hist[0]);
      windCtx.moveTo(pt.x, pt.y);
      for (let i = 1; i < p.hist.length; i++) {
        pt = toPt(p.hist[i]);
        windCtx.lineTo(pt.x, pt.y);
      }
      windCtx.strokeStyle = "rgba(214, 233, 255, 0.08)";
      windCtx.lineWidth = 1;
      windCtx.stroke();
      const headStart = Math.max(0, p.hist.length - 4);
      windCtx.beginPath();
      pt = toPt(p.hist[headStart]);
      windCtx.moveTo(pt.x, pt.y);
      for (let i = headStart + 1; i < p.hist.length; i++) {
        pt = toPt(p.hist[i]);
        windCtx.lineTo(pt.x, pt.y);
      }
      windCtx.strokeStyle = "rgba(222, 240, 255, 0.24)";
      windCtx.lineWidth = 1.5;
      windCtx.stroke();
    }
  }
  requestAnimationFrame(frame);
}

function updateWindBtn() {
  const b = document.getElementById("wind-btn");
  if (b && b.classList) b.classList.toggle("active", windOn);
}

// ---------- status ----------

function setStatus(text, pinned = false) {
  statusPinned = pinned;
  const el = document.getElementById("refresh-status");
  el.textContent = text;
  el.classList.toggle("loading", pinned);
}

// ticks once a second so the header feels alive between polls
function tickStatus() {
  if (statusPinned || latestReadingT == null) return;
  const secs = Math.max(0, Math.round((Date.now() - latestReadingT) / 1000));
  setStatus(`live · reading ${secs}s old`);
}

function showError(msg) {
  const b = document.getElementById("error-banner");
  if (!msg) { b.classList.add("hidden"); return; }
  b.textContent = msg;
  b.classList.remove("hidden");
}

// ---------- load & poll ----------

async function refresh() {
  try {
    ingest(await fetchReadings());
    rebuild();
    renderAll();
    showError(null);
    latestReadingT = timeline[timeline.length - 1] ?? null;
    tickStatus();
    // keep the reload cache fresh so the next visit skips the archives
    if (typeof localStorage !== "undefined" && Date.now() - lastHistSave > 5 * 60_000 && timeline.length > 100) {
      saveHistCache();
    }
  } catch (e) {
    showError(`Could not reach data.gov.sg (${e.message}). Retrying in a minute…`);
    setStatus("retrying…", true);
  }
}

// Processed-history cache: the raw day files are several MB each, but the
// extracted per-station series are a few hundred KB — small enough for
// localStorage. A reload within the freshness window restores instantly and
// skips every archive download (live polls fill forward from there).
const HIST_CACHE_KEY = "sgtemp-hist-v2";
const HIST_CACHE_MS = 15 * 60_000;
let lastHistSave = 0;

function saveHistCache() {
  try {
    lastHistSave = Date.now();
    localStorage.setItem(HIST_CACHE_KEY, JSON.stringify({
      at: lastHistSave,
      stations: [...stations.values()].map((s) => ({
        id: s.id, name: s.name, lat: s.lat, lon: s.lon, kind: s.kind,
        series: [...s.series],
      })),
      wind: [...windStations.values()].map((w) => ({
        id: w.id, name: w.name, lat: w.lat, lon: w.lon,
        series: w.series.map((p) => [p.t, p.u, p.v]),
      })),
      rain: [...rainSeries].map(([id, arr]) => {
        const loc = rainLocs.get(id);
        return { id, lat: loc?.lat, lon: loc?.lon, series: arr.map((p) => [p.t, p.mm]) };
      }),
      rainDone: rainDayLoaded,
    }));
  } catch { /* quota or unavailable — caching is best-effort */ }
}

// Wind stations get seeded from the cache even when it's too stale for
// temperatures (up to 12h): live semantics are already last-known-reading,
// per-minute polls replace each station as fresh data arrives, and the
// archive refetch (windDayLoaded stays false) heals the history. This makes
// the particle field full-coverage within a second on any revisit.
function seedWindFromCache() {
  try {
    const c = JSON.parse(localStorage.getItem(HIST_CACHE_KEY));
    if (!c || Date.now() - c.at > 12 * 3600_000) return;
    for (const wc of c.wind ?? []) {
      if (windStations.has(wc.id) || !wc.series?.length) continue;
      windStations.set(wc.id, {
        id: wc.id, name: wc.name, lat: wc.lat, lon: wc.lon,
        series: wc.series.map(([t, u, v]) => ({ t, u, v })),
      });
    }
    if (windStations.size) updateWindField();
  } catch { /* best-effort */ }
}

function loadHistCache() {
  try {
    const c = JSON.parse(localStorage.getItem(HIST_CACHE_KEY));
    if (!c || Date.now() - c.at > HIST_CACHE_MS) return false;
    for (const sc of c.stations ?? []) {
      const s = upsertStation({ id: sc.id, name: sc.name, lat: sc.lat, lon: sc.lon, kind: sc.kind });
      for (const [t, v] of sc.series) s.series.set(t, v);
    }
    for (const wc of c.wind ?? []) {
      if (!windStations.has(wc.id)) {
        windStations.set(wc.id, {
          id: wc.id, name: wc.name, lat: wc.lat, lon: wc.lon,
          series: wc.series.map(([t, u, v]) => ({ t, u, v })),
        });
      }
    }
    // Only trust the cached wind set if it's the full network — a cache
    // saved during a rate-limited session can hold 1-2 stations, and
    // marking the archive "done" then locks in the degraded set (particles
    // swarm the one covered circle).
    if ((c.wind?.length ?? 0) >= 8) windDayLoaded = true;
    for (const rc of c.rain ?? []) {
      if (Number.isFinite(rc.lat)) rainLocs.set(rc.id, { lat: rc.lat, lon: rc.lon });
      for (const [t, mm] of rc.series ?? []) pushRainSeries(rc.id, t, mm);
    }
    if (c.rainDone) rainDayLoaded = true;
    return (c.stations ?? []).length > 0;
  } catch {
    return false;
  }
}

// Bulk-load the 24h window. Today's file first (the most useful hours) and
// only then yesterday's, sequentially — one download at full bandwidth beats
// two sharing it, and each renders as soon as it lands.
async function loadHistory() {
  const now = Date.now();
  if (typeof localStorage !== "undefined" && loadHistCache()) {
    rebuild(now);
    renderAll();
    latestReadingT = timeline[timeline.length - 1] ?? null;
    statusPinned = false;
    tickStatus();
    return;
  }
  setStatus("loading 24h history…", true);
  const failed = [];
  for (const day of [sgtDate(new Date(now)), sgtDate(new Date(now - 24 * 3600_000))]) {
    try {
      ingest(await fetchDay(day));
      rebuild();
      renderAll();
    } catch {
      failed.push(day); // rate limit or hiccup — retried below
    }
  }
  rebuild(now);
  renderAll();
  latestReadingT = timeline[timeline.length - 1] ?? null;
  statusPinned = false;
  tickStatus();
  if (failed.length === 2) {
    showError("History download was rate-limited — retrying in the background…");
  }
  scheduleHistRetry(failed);
  if (!failed.length && typeof localStorage !== "undefined") saveHistCache();
}

// Failed archive days retry themselves with growing backoff instead of
// staying missing for the whole session.
let histRetries = 0;

function scheduleHistRetry(days) {
  if (!days.length || histRetries >= 3) return;
  histRetries++;
  setTimeout(async () => {
    const still = [];
    for (const day of days) {
      try {
        ingest(await fetchDay(day));
        rebuild();
        renderAll();
        showError(null);
      } catch {
        still.push(day);
      }
    }
    if (!still.length && typeof localStorage !== "undefined") saveHistCache();
    scheduleHistRetry(still);
  }, 45_000 * histRetries);
}

// ---------- init ----------

function initMap() {
  // hard-locked to the Open-Meteo grid window — no padding, no drifting off it
  const dataBounds = L.latLngBounds(
    [OVERLAY.latMin, OVERLAY.lonMin], [OVERLAY.latMax, OVERLAY.lonMax]);
  map = L.map("map", {
    zoomControl: true,
    maxBounds: dataBounds,
    maxBoundsViscosity: 1.0, // hard wall when panning
    zoomSnap: 0, // fractional zoom, so min zoom can match the bounds exactly
  });
  const cloudPane = map.createPane("clouds"); // satellite tiles
  cloudPane.style.zIndex = 430; // above the shading (400), below markers (600)
  cloudPane.style.pointerEvents = "none";
  const rainPane = map.createPane("rain"); // gauge glyphs + splash circles
  rainPane.style.zIndex = 440;
  map.fitBounds(dataBounds);
  // Fully zoomed out = screen completely filled by the data window
  // (inside=true), so the map can never show past the data edge. Recompute
  // when the container changes shape, or a resize would reopen the gap.
  const lockMinZoom = () => map.setMinZoom(map.getBoundsZoom(dataBounds, true));
  lockMinZoom();
  map.on("resize", lockMinZoom);
  const tileOpts = {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
    maxZoom: 18,
  };
  // single dark basemap; daytime just brightens it slightly via a CSS
  // filter on the tile pane (no second tile set, no hue clash with the
  // temperature ramp)
  L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", tileOpts).addTo(map);

  // Mobile browsers finish laying out the container (vh units, the dynamic
  // address bar) after L.map() has already measured it — leaving the map
  // sized to 0 and the tiles blank forever. Re-measure once things settle,
  // and on orientation/resize; each invalidateSize fires "resize", which
  // re-runs lockMinZoom against the now-correct size.
  const remeasure = () => { if (map) map.invalidateSize(); };
  setTimeout(remeasure, 200);
  setTimeout(remeasure, 1000);
  if (typeof window !== "undefined") {
    window.addEventListener("load", remeasure);
    window.addEventListener("orientationchange", () => setTimeout(remeasure, 300));
  }
}

document.getElementById("detail-close").addEventListener("click", () => selectStation(selectedId));

document.getElementById("time-slider").addEventListener("input", (e) => {
  const idx = Number(e.target.value);
  displayedT = idx === sliderLiveIdx ? null : sliderTicks[idx];
  scheduleRender();
});

document.getElementById("live-btn").addEventListener("click", () => {
  displayedT = null;
  renderAll();
});

const filterSel = document.getElementById("list-filter");
try {
  listFilter = localStorage.getItem("sgtemp-filter") || "all";
  filterSel.value = listFilter;
} catch { /* default */ }
filterSel.addEventListener("change", () => {
  listFilter = filterSel.value;
  try { localStorage.setItem("sgtemp-filter", listFilter); } catch { /* fine */ }
  renderAll();
});

document.getElementById("radar-btn").addEventListener("click", () => {
  radarOn = !radarOn;
  try { localStorage.setItem("sgtemp-radar", radarOn ? "on" : "off"); } catch { /* fine */ }
  updateRadarBtn();
  if (!radarOn) {
    for (const ly of radarLayers.values()) ly.remove();
    setSatStatus("off");
  } else if (radarLayers.size) {
    for (const ly of radarLayers.values()) ly.addTo(map);
    radarShown = null;
    applyRadarFrame();
  } else {
    pollSatellite();
  }
});
updateRadarBtn();

// Collapsible station panel: hide to give the map the full width; a slim
// handle on the map edge brings it back. The map must re-measure after.
let panelOpen = true;
try { panelOpen = localStorage.getItem("sgtemp-panel") !== "closed"; } catch { /* default open */ }

function setPanel(open) {
  panelOpen = open;
  const panel = document.getElementById("side-panel");
  const show = document.getElementById("panel-show");
  if (panel && panel.classList) panel.classList.toggle("hidden", !open);
  if (show && show.classList) show.classList.toggle("hidden", open);
  try { localStorage.setItem("sgtemp-panel", open ? "open" : "closed"); } catch { /* fine */ }
  if (map && map.invalidateSize) map.invalidateSize();
}

document.getElementById("panel-btn").addEventListener("click", () => setPanel(false));
document.getElementById("panel-show").addEventListener("click", () => setPanel(true));
if (!panelOpen) setPanel(false);

document.getElementById("wind-btn").addEventListener("click", () => {
  windOn = !windOn;
  try { localStorage.setItem("sgtemp-wind", windOn ? "on" : "off"); } catch { /* fine */ }
  if (windCtx) windCtx.clearRect(0, 0, windCanvas.width, windCanvas.height);
  updateWindBtn();
});

{
  const v = document.getElementById("app-version");
  if (v) v.textContent = APP_VERSION;
  console.info(`[sgtemp] app version ${APP_VERSION}`);
}
initMap();
startWind();
refresh().then(() => {
  // the wind archive is what the particles ultimately feed on — fetch it in
  // parallel with the temperature history instead of after it (its four day
  // files used to queue behind temp's two, delaying particles 20-30s)
  setTimeout(() => loadWindHistory().catch(() => {}), 800);
  return loadHistory();
}).then(() => {
  pollCommunity();
  pollRain();
  pollSatellite();
  if (!TEST_RAIN) {
    setTimeout(() => seedRainRecent().catch(() => {}), 3000);
    setTimeout(() => loadRainHistory().catch(() => {}), 6000);
  }
});
if (typeof localStorage !== "undefined") seedWindFromCache();
pollWind();
setInterval(pollRain, RAIN_POLL_MS);
setInterval(pollSatellite, SAT_POLL_MS);
setInterval(pollWind, POLL_MS);
refreshModel();
setInterval(refresh, POLL_MS);
setInterval(refreshModel, MODEL_REFRESH_MS);
setInterval(tickStatus, 1000);
setInterval(pollCommunity, CIV_POLL_MS);
setInterval(renderLive, 1500); // live numbers drift slightly between polls
