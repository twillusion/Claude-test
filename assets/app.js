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
const RADAR_POLL_MS = 10 * 60_000; // radar frames update every ~10 minutes
const KNOTS_TO_KMH = 1.852;
const OM_URL = "https://api.open-meteo.com/v1/forecast";
const POLL_MS = 60_000;
const MODEL_REFRESH_MS = 30 * 60_000; // Open-Meteo models update hourly
const HISTORY_HOURS = 24;
// Shown in the footer; bump together with the ?v= stamps in index.html so a
// glance settles "am I looking at the new build or a stale cache?"
const APP_VERSION = "20260923i";

// CARTO basemap key. Since Aug 2026 basemaps.cartocdn.com answers keyless
// requests with HTTP 200 tiles that have "API KEY REQUIRED" burned in, so
// Leaflet sees no error. Free key: carto.com/basemaps/apikey. Tile keys are
// public by design (every tile URL carries it), so it lives here.
const CARTO_KEY = "cb1_3ukn_1_5f35370e75fa8d0784a66b5a";

const SLIDER_STEP_MIN = 5; // scrubber granularity; underlying data is per-minute

// Geographic window and raster size for the shading overlay; the Open-Meteo
// sample grid shares the same bounds so the raster never extrapolates, and
// the map is hard-locked to this exact window.
const OVERLAY = { latMin: 1.09, latMax: 1.56, lonMin: 103.48, lonMax: 104.22, w: 240, h: 152 };
// Model sample grid. Open-Meteo serves ECMWF IFS here, whose octahedral
// grid is ~0.07° (~8 km) — the snapped coordinates in its responses show
// it. The old 6x9 grid (~0.094°) skipped whole native rows; 8x12 (~0.067°)
// hits every native cell. The dimensions travel inside data/model.json
// (`grid`), so the page follows whatever the file holds.
const GRID_DEFAULT = { nlat: 8, nlon: 12 };
let GRID_NLAT = GRID_DEFAULT.nlat;
let GRID_NLON = GRID_DEFAULT.nlon;
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
let fieldCache = null, fadeCache = null; // last rasterized temperature field + edge fade

// ---------- loading indicator ----------

/* A small static note in the map corner listing what is still loading
   ("loading radar 5/13 · wind history"); hidden when everything is in. No
   spinner — nothing on this page pulses. An item only appears once it has
   been loading for 0.4 s, so quick background refreshes never flicker it. */
const loadingItems = new Map(); // key -> {label, since}

function setLoading(key, label) {
  if (label) loadingItems.set(key, { label, since: loadingItems.get(key)?.since ?? Date.now() });
  else loadingItems.delete(key);
  renderLoading();
  if (label) setTimeout(renderLoading, 420);
}

function renderLoading() {
  const el = typeof document !== "undefined" && document.getElementById("load-status");
  if (!el) return;
  const now = Date.now();
  const shown = [...loadingItems.values()].filter((i) => now - i.since >= 400).map((i) => i.label);
  el.textContent = shown.length ? `loading ${shown.join(" · ")}` : "";
  if (el.classList) el.classList.toggle("hidden", !shown.length);
}

// Wrap a loader so it registers while it runs; label may be a function
// (return null to stay quiet, e.g. for routine refreshes).
function withLoading(key, label, fn) {
  return async (...args) => {
    const l = typeof label === "function" ? label() : label;
    if (l) setLoading(key, l);
    try { return await fn(...args); } finally { if (l) setLoading(key, null); }
  };
}

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

// Hourly 2m-temperature, 10m wind, and precipitation for the whole sample
// grid, yesterday through tomorrow — the scrubber's past window plus the
// forecast horizon.
function buildModelFromResults(results, grid = GRID_DEFAULT) {
  if (results.length !== grid.nlat * grid.nlon) {
    throw new Error(`model grid mismatch (${results.length} points for ${grid.nlat}x${grid.nlon})`);
  }
  const times = results[0].hourly.time.map((s) => s * 1000);
  const grids = [], uGrids = [], vGrids = [], pGrids = [];
  times.forEach((_, k) => {
    const g = new Float32Array(results.length);
    const gu = new Float32Array(results.length);
    const gv = new Float32Array(results.length);
    const gp = new Float32Array(results.length);
    for (let i = 0; i < results.length; i++) {
      const h = results[i].hourly;
      const v = h.temperature_2m[k];
      g[i] = v == null ? NaN : v;
      const pr = h.precipitation?.[k]; // mm in that hour
      gp[i] = pr == null ? NaN : pr;
      const ws = h.wind_speed_10m?.[k], wd = h.wind_direction_10m?.[k];
      if (ws == null || wd == null) { gu[i] = NaN; gv[i] = NaN; continue; }
      // meteorological direction = where the wind comes FROM
      const rad = (wd * Math.PI) / 180;
      gu[i] = -ws * Math.sin(rad); // eastward, km/h
      gv[i] = -ws * Math.cos(rad); // northward, km/h
    }
    grids.push(g); uGrids.push(gu); vGrids.push(gv); pGrids.push(gp);
  });
  model = { times, grids, uGrids, vGrids, pGrids };
  GRID_NLAT = grid.nlat;
  GRID_NLON = grid.nlon;
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
  // files written before the grid moved to 8x12 carry no `grid` field
  buildModelFromResults(j.results, j.grid ?? { nlat: 6, nlon: 9 });
}

// Fallback: fetch Open-Meteo directly from the browser.
async function fetchModel() {
  const lats = [], lons = [];
  const { nlat, nlon } = GRID_DEFAULT;
  for (let iy = 0; iy < nlat; iy++) {
    for (let ix = 0; ix < nlon; ix++) {
      lats.push((OVERLAY.latMin + (iy * (OVERLAY.latMax - OVERLAY.latMin)) / (nlat - 1)).toFixed(4));
      lons.push((OVERLAY.lonMin + (ix * (OVERLAY.lonMax - OVERLAY.lonMin)) / (nlon - 1)).toFixed(4));
    }
  }
  // chunked: long multi-location URLs / heavy requests are what get refused
  const CHUNK = 27;
  const requests = [];
  for (let i = 0; i < lats.length; i += CHUNK) {
    const url = `${OM_URL}?latitude=${lats.slice(i, i + CHUNK).join(",")}` +
      `&longitude=${lons.slice(i, i + CHUNK).join(",")}` +
      `&hourly=temperature_2m,wind_speed_10m,wind_direction_10m,precipitation` +
      `&past_days=1&forecast_days=2&timeformat=unixtime&timezone=UTC`;
    requests.push(fetch(url).then(async (res) => {
      if (!res.ok) throw new Error(`open-meteo HTTP ${res.status}`);
      const j = await res.json();
      return Array.isArray(j) ? j : [j];
    }));
  }
  const results = (await Promise.all(requests)).flat();
  if (results.length !== lats.length) throw new Error("open-meteo result count mismatch");
  buildModelFromResults(results, GRID_DEFAULT);
}

// Cache the model in localStorage so page reloads within the refresh window
// don't re-hit Open-Meteo — rapid reloads are how free-tier rate limits get
// burned, which then takes the model (and wind) down for everyone-you.
const MODEL_CACHE_KEY = "sgtemp-model-v3"; // v3: grid dimensions stored

function loadModelCache() {
  try {
    const c = JSON.parse(localStorage.getItem(MODEL_CACHE_KEY));
    if (!c || Date.now() - c.at > MODEL_REFRESH_MS) return false;
    const revive = (arr) => arr.map((g) => Float32Array.from(g, (x) => (x == null ? NaN : x)));
    if (!c.grid || c.grids[0]?.length !== c.grid.nlat * c.grid.nlon) return false;
    GRID_NLAT = c.grid.nlat;
    GRID_NLON = c.grid.nlon;
    model = {
      times: c.times, grids: revive(c.grids),
      uGrids: revive(c.uGrids), vGrids: revive(c.vGrids),
      pGrids: revive(c.pGrids ?? []),
    };
    return true;
  } catch {
    return false;
  }
}

function saveModelCache() {
  try {
    const pack = (arr) => arr.map((g) => Array.from(g, (x) => (Number.isNaN(x) ? null : x)));
    localStorage.setItem(MODEL_CACHE_KEY, JSON.stringify({
      at: Date.now(), times: model.times, grid: { nlat: GRID_NLAT, nlon: GRID_NLON },
      grids: pack(model.grids), uGrids: pack(model.uGrids), vGrids: pack(model.vGrids),
      pGrids: pack(model.pGrids ?? []),
    }));
  } catch { /* storage full or unavailable — not worth failing over */ }
}

function setShadeMode(text) {
  document.getElementById("shade-mode").textContent = text;
}

function modelLoaded(source) {
  if (typeof localStorage !== "undefined") saveModelCache();
  windFieldT = NaN; // a forecast wind grid may have been built from the old model
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
    windFieldT = NaN;
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
  // The future is the model's, like temperature. Station readings used to
  // persist 90 min into it and then the grid went empty — the particle
  // loop stopped drawing and left its last frame frozen on screen.
  if (isFutureView()) { buildModelWindGrid(); return; }
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

// Forecast wind: the model field at the displayed time, resampled onto the
// same grid so particles, socks and pins read it exactly like observations.
function buildModelWindGrid() {
  if (!model?.uGrids?.length || displayedT === null) { windGridU = null; windGridV = null; return; }
  const u = blendGrids(model.uGrids, displayedT), v = blendGrids(model.vGrids, displayedT);
  const { nx, ny } = WGRID;
  windGridU = new Float32Array(nx * ny);
  windGridV = new Float32Array(nx * ny);
  for (let iy = 0; iy < ny; iy++) {
    const lat = OVERLAY.latMax - ((iy + 0.5) / ny) * (OVERLAY.latMax - OVERLAY.latMin);
    for (let ix = 0; ix < nx; ix++) {
      const lon = OVERLAY.lonMin + ((ix + 0.5) / nx) * (OVERLAY.lonMax - OVERLAY.lonMin);
      const uu = gridSample(u, lat, lon), vv = gridSample(v, lat, lon);
      const i = iy * nx + ix;
      windGridU[i] = uu ?? NaN;
      windGridV[i] = vv ?? NaN;
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
}

const rainLayer = new Map(); // id -> {circle (gauges only), icon}

/* Rain is drawn as neutral grey-white cloud (radar, nowcast, model — see
   the radar section) with 🌧️ glyphs underneath, never with colour: on this
   map colour means temperature and nothing else. Glyphs sit at the real
   NEA gauge positions: observed readings in the past/live, and in the
   future whatever rain the cloud layer brings to that gauge — so, as with
   the real thing, glyphs appear under the cloud as it rolls over. Forecast
   glyphs are dimmer and ringed with a dashed outline, the same "estimate"
   mark as the dashed forecast pills. */
const RAIN_RING = "rgb(222, 229, 239)"; // neutral, deliberately not a hue

// 0..1 visibility of a forecast rain rate: ~0.35 at 0.3 mm/h, ~0.6 at
// 1 mm/h, ~0.95 from 4 mm/h
function fcRainStrength(mm) {
  return smooth01((mm - 0.08) / 0.35) * (0.55 + 0.45 * smooth01(mm / 5));
}

// forecast mm/h worth a glyph: a real shower, not the drizzle haze the
// model spreads everywhere (at 0.3, ~40 of 60 gauges lit up — clutter)
const FC_RAIN_MIN_MM = 1;
let fcRainMax = 0, fcRainSrc = "";

// Open-Meteo's hourly precipitation is the total over the PRECEDING hour,
// so the value stamped 08:00 is the 07:00-08:00 rate: sample half an hour
// later to centre it on the displayed moment.
function forecastRainGrid(t) {
  if (!model?.pGrids?.length) return null;
  return blendGrids(model.pGrids, t + 30 * 60_000);
}

// Catmull-Rom sample of a model-shaped grid (clamped at the edges), so the
// ~8km cells blend smoothly instead of showing bilinear diamonds.
function gridSampleCubic(grid, lat, lon) {
  const fy = ((lat - OVERLAY.latMin) / (OVERLAY.latMax - OVERLAY.latMin)) * (GRID_NLAT - 1);
  const fx = ((lon - OVERLAY.lonMin) / (OVERLAY.lonMax - OVERLAY.lonMin)) * (GRID_NLON - 1);
  const iy = Math.floor(fy), ix = Math.floor(fx);
  const ty = fy - iy, tx = fx - ix;
  const at = (y, x) => {
    const v = grid[Math.min(GRID_NLAT - 1, Math.max(0, y)) * GRID_NLON +
                   Math.min(GRID_NLON - 1, Math.max(0, x))];
    return Number.isNaN(v) ? 0 : v;
  };
  const cr = (p0, p1, p2, p3, t) =>
    p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)));
  const row = (y) => cr(at(y, ix - 1), at(y, ix), at(y, ix + 1), at(y, ix + 2), tx);
  return cr(row(iy - 1), row(iy), row(iy + 1), row(iy + 2), ty);
}

// Forecast glyphs: every gauge position the future rain field reaches.
function forecastGaugeRain(ctx) {
  fcRainMax = 0;
  fcRainSrc = ctx?.src ?? "";
  if (!ctx?.rate) return [];
  const out = [];
  for (const [id, loc] of rainLocs) {
    const mm = ctx.rate(loc.lat, loc.lon);
    if (mm > fcRainMax) fcRainMax = mm;
    if (mm >= FC_RAIN_MIN_MM) out.push({ id: `fc-${id}`, lat: loc.lat, lon: loc.lon, mm, fc: true });
  }
  return out;
}

/* Glyphs and circles fade in and out (~0.35 s) instead of popping, and a
   fading-out one comes straight back if the rain returns mid-fade. */
const RAIN_FADE_MS = 350;
let rainFadeOn = false, rainFadeLast = 0;

function applyRainLook(e) {
  const f = e.fade, L2 = e.look;
  if (!L2) return;
  e.circle.setRadius(L2.radius);
  if (e.circle.setStyle) e.circle.setStyle({ opacity: L2.stroke * f, fillOpacity: L2.fill * f });
  const el = e.icon.getElement && e.icon.getElement()?.querySelector(".rain-icon");
  if (el && el.style) {
    el.style.fontSize = `${L2.size}px`;
    el.style.opacity = (L2.opacity * f).toFixed(2);
  }
}

function startRainFade() {
  if (rainFadeOn) return;
  rainFadeOn = true;
  rainFadeLast = typeof performance !== "undefined" ? performance.now() : Date.now();
  requestAnimationFrame(rainFadeStep);
}

function rainFadeStep(now) {
  const d = Math.min(100, Math.max(1, now - rainFadeLast)) / RAIN_FADE_MS;
  rainFadeLast = now;
  let busy = false;
  for (const [id, e] of rainLayer) {
    const target = e.show ? 1 : 0;
    if (e.fade === target) continue;
    e.fade = target > e.fade ? Math.min(1, e.fade + d) : Math.max(0, e.fade - d);
    if (e.fade === 0 && !e.show) {
      e.circle.remove(); e.icon.remove(); rainLayer.delete(id);
      continue;
    }
    applyRainLook(e);
    busy = true;
  }
  if (busy) requestAnimationFrame(rainFadeStep);
  else rainFadeOn = false;
}

function renderRain() {
  if (typeof L === "undefined" || !map) return;
  // live shows "now"; scrubbing the past replays the day's gauges; the
  // future shows what the forecast rain field brings to each gauge
  const future = isFutureView();
  const t = displayedTime() ?? Date.now();
  const list = displayedT === null ? wetGauges
    : future ? forecastGaugeRain(rainContext(t))
    : wetList(t);
  const seen = new Set();
  for (const g of list) {
    seen.add(g.id);
    const fc = !!g.fc;
    const active = fc || g.mm > 0.05; // raining now vs rained recently
    const intensity = fc ? g.mm : Math.max(g.mm, (g.recent ?? 0) / 3);
    // one scale for both: gauges report mm per 5 min, forecasts mm/h
    const rate = fc ? intensity : intensity * 12;
    const k = fc ? fcRainStrength(intensity) : Math.min(1, intensity / 8);
    let e = rainLayer.get(g.id);
    if (!e) {
      e = {
        // circle of effect: how far the rain reaches, neutral (colour is
        // for temperature), dashed for forecasts like the forecast pills
        circle: L.circle([g.lat, g.lon], {
          pane: "rain", radius: 800, color: RAIN_RING, weight: 1.2,
          fillColor: RAIN_RING, interactive: false, opacity: 0, fillOpacity: 0,
          dashArray: fc ? "4 5" : null,
        }).addTo(map),
        icon: L.marker([g.lat, g.lon], {
          pane: "rain", keyboard: false,
          icon: L.divIcon({ className: "", html: `<span class="rain-icon">🌧️</span>`, iconSize: [0, 0] }),
        }).addTo(map),
        fade: 0,
      };
      e.icon.bindTooltip("");
      rainLayer.set(g.id, e);
    }
    e.show = true;
    e.look = {
      radius: 800 + 4200 * Math.sqrt(Math.min(1, rate / 40)), // 0.8-5 km
      stroke: fc ? 0.45 : active ? 0.55 : 0.28,
      fill: fc ? 0.08 : active ? 0.12 : 0.05,
      size: Math.round(fc ? 12 + 6 * k : 14 + 8 * k),
      opacity: fc ? 0.5 + 0.3 * k : active ? 1 : 0.55,
    };
    applyRainLook(e);
    if (e.icon.setTooltipContent) {
      e.icon.setTooltipContent(fc
        ? `forecast ≈ ${g.mm.toFixed(1)} mm/h`
        : `${g.mm.toFixed(1)} mm now · ${(g.recent ?? 0).toFixed(1)} mm last 30 min`);
    }
  }
  for (const [id, e] of rainLayer) e.show = seen.has(id); // the rest fade out
  startRainFade();
  renderRainStatus();
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
  renderRain(); // the status line carries the TEST MODE marker
}

function pollRain() {
  if (TEST_RAIN) { injectTestRain(); return; }
  fetchRain().catch(() => {
    const el = document.getElementById("rain-status");
    if (el) el.textContent = "unreachable";
  });
}

/* Island-wide model rain per forecast hour, for the slider track and the
   footer outlook — so "showers this afternoon" is visible from the live
   view without scrubbing. Each hour's figure is max(p75, p95/2) over the
   grid: widespread rain and a strong local cell both register, a single
   drizzly node doesn't. Open-Meteo stamps each hour's total at its END. */
let rainOutlookCache = { key: "", hours: [] };

function rainOutlook() {
  if (!model?.pGrids?.length || sliderLiveIdx < 0) return [];
  const now = sliderTicks[sliderLiveIdx], end = sliderTicks[sliderTicks.length - 1];
  const key = `${model.times[0]}|${model.pGrids.length}|${now}|${end}|${model.pGrids[0][0]}`;
  if (rainOutlookCache.key === key) return rainOutlookCache.hours;
  const hours = [];
  model.times.forEach((t, k) => {
    if (t <= now || t - 3600_000 >= end) return;
    const v = [...model.pGrids[k]].filter((x) => !Number.isNaN(x)).sort((a, b) => a - b);
    if (!v.length) return;
    const q = (f) => v[Math.min(v.length - 1, Math.floor(f * v.length))];
    hours.push({ from: t - 3600_000, to: t, mm: Math.max(q(0.75), q(0.95) / 2) });
  });
  rainOutlookCache = { key, hours };
  return hours;
}

const OUTLOOK_MM = 0.3; // island-wide mm/h that counts as "showers"

function fmtHour(t) {
  const opts = { timeZone: "Asia/Singapore", hour: "numeric" };
  const sameDay = sgtDate(new Date(t)) === sgtDate(new Date());
  if (!sameDay) opts.weekday = "short";
  return new Date(t).toLocaleTimeString("en-SG", opts).replace(":00", "");
}

// "showers ~12 pm–4 pm", "showers now–2 pm", or "no rain next 20h"
function rainOutlookText() {
  const hours = rainOutlook();
  if (!hours.length) return "";
  const i = hours.findIndex((h) => h.mm >= OUTLOOK_MM);
  if (i < 0) {
    const span = Math.round((hours[hours.length - 1].to - Date.now()) / 3600_000);
    return `model: no rain next ${span}h`;
  }
  let j = i;
  while (j + 1 < hours.length && hours[j + 1].mm >= OUTLOOK_MM) j++;
  const start = hours[i].from <= Date.now() ? "now" : `~${fmtHour(hours[i].from)}`;
  return `model: showers ${start}–${fmtHour(hours[j].to)}`;
}

// Forecast rain hours marked on the slider track in neutral grey (CSS
// --rain-track; colour stays reserved for temperature),
// positioned the way the thumb travels (half a thumb in at each end).
function renderRainTrack(wrap) {
  if (!wrap?.style?.setProperty) return;
  const t0 = sliderTicks[0], t1 = sliderTicks[sliderTicks.length - 1];
  const stops = [];
  const pos = (t) => {
    const f = Math.min(1, Math.max(0, (t - t0) / (t1 - t0 || 1)));
    return `calc(var(--thumb) / 2 + (100% - var(--thumb)) * ${f.toFixed(4)})`;
  };
  for (const h of rainOutlook()) {
    const k = fcRainStrength(h.mm);
    if (k < 0.15) continue;
    const c = `rgba(222, 229, 239, ${(0.25 + 0.6 * k).toFixed(2)})`; // neutral, not a hue
    const a = pos(Math.max(h.from, sliderTicks[sliderLiveIdx])), b = pos(h.to);
    stops.push(`transparent ${a}`, `${c} ${a}`, `${c} ${b}`, `transparent ${b}`);
  }
  wrap.style.setProperty("--rain-track", stops.length
    ? `linear-gradient(90deg, transparent 0, ${stops.join(", ")}, transparent 100%)`
    : "linear-gradient(transparent, transparent)");
}

// Describes what the map is showing for rain at the displayed time.
function renderRainStatus() {
  const el = document.getElementById("rain-status");
  if (!el) return;
  if (isFutureView()) {
    const src = fcRainSrc === "nowcast" ? "nowcast" : fcRainSrc === "blend" ? "nowcast→model"
      : fcRainSrc === "model" ? "model" : "";
    el.textContent = !src ? "no forecast rain data"
      : fcRainMax >= 0.1 ? `${src} ≈ up to ${fcRainMax.toFixed(1)} mm/h at gauges`
      : `${src}: dry at gauges`;
    return;
  }
  const prefix = TEST_RAIN ? "TEST MODE — synthetic · " : "";
  const outlook = rainOutlookText();
  const suffix = outlook ? ` · ${outlook}` : "";
  if (!rainReadings.length && !rainSeries.size) { el.textContent = `${prefix}no gauges reporting${suffix}`; return; }
  const wet = displayedT === null ? wetGauges : wetList(displayedTime() ?? Date.now());
  if (!wet.length) {
    el.textContent = displayedT === null
      ? `${prefix}dry 30 min (${rainReadings.length} gauges)${suffix}` : `${prefix}dry at this time${suffix}`;
    return;
  }
  const max = Math.max(...wet.map((g) => Math.max(g.mm, (g.recent ?? 0) / 3)));
  el.textContent = `${prefix}${wet.length} gauge${wet.length > 1 ? "s" : ""} wet · up to ${max.toFixed(1)} mm${suffix}`;
}

// ---------- precipitation radar (RainViewer), nowcast, rain clouds ----------

/* Radar is decoded, not just displayed. RainViewer's free tier (reduced in
   Jan 2026) serves ~2h of past frames only: no forecast frames, zoom <= 7,
   possibly a single colour scheme. We request scheme 0, which encodes
   reflectivity in the red channel (dBZ = (R & 127) - 32), and decode two
   z7 tiles per frame into a dBZ grid covering Singapore plus ~250 km in
   every direction (~0.6 km pixels).

   Those grids drive everything rain-cloud related:
   - past/live: the frame itself, drawn as neutral grey-white cloud (colour
     on this map means temperature);
   - future: a nowcast. Block-matching the latest frame against the one
     ~20 min earlier gives a motion field; the latest frame is advected
     along it (semi-Lagrangian), fading with lead time, and blended into the
     model from +45 min to +2h, after which it's the model alone.
   Extrapolation only moves rain that already exists: storms that form in
   place (common on Singapore afternoons) are the model's job.

   If the pixels can't be read (CORS, decode failure) the old coloured tile
   layers come back without the nowcast, and the footer says why. */
const RV_META_URL = "https://api.rainviewer.com/public/weather-maps.json";
let radarOn = true;
try { radarOn = localStorage.getItem("sgtemp-radar") !== "off"; } catch { /* default on */ }

function updateRadarBtn() {
  const b = document.getElementById("radar-btn");
  if (b && b.classList) b.classList.toggle("active", radarOn);
}

function setRadarStatus(text) {
  const el = document.getElementById("radar-status");
  if (el) el.textContent = text;
}

let radarFrames = []; // [{time: sec, path}], oldest first, ~2h of past frames
let radarHost = "";
let radarMode = "pixels"; // "pixels" | "tiles" (fallback: coloured tiles, no nowcast)
let radarModeNote = "";
let radarApprox = false;  // tiles weren't the dBZ-encoded scheme: intensity is a guess

const RV_Z = 7, RV_TILE = 512;
const RV_TX = [100, 101], RV_TY = 63; // lon 101.25-106.875, lat 0-2.81
const RV_W = RV_TILE * RV_TX.length, RV_H = RV_TILE;
const RV_KM_PER_PX = 40075 / (2 ** RV_Z * RV_TILE); // ~0.61 km at the equator
const radarGrids = new Map(); // frame path -> Uint8Array(RV_W*RV_H): dBZ+32, 0 = no echo

// Web Mercator pixel <-> lat/lon inside the decoded domain
function rvX(lon) { return (((lon + 180) / 360) * 2 ** RV_Z - RV_TX[0]) * RV_TILE; }
function rvY(lat) {
  const r = (lat * Math.PI) / 180;
  return (((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** RV_Z - RV_TY) * RV_TILE;
}
function rvLon(x) { return ((x / RV_TILE + RV_TX[0]) / 2 ** RV_Z) * 360 - 180; }
function rvLat(y) {
  const n = Math.PI * (1 - (2 * (y / RV_TILE + RV_TY)) / 2 ** RV_Z);
  return (Math.atan(Math.sinh(n)) * 180) / Math.PI;
}

// dBZ+32 byte -> mm/h (Marshall-Palmer Z = 200 R^1.6; under 10 dBZ is dry)
const RATE_LUT = Float32Array.from({ length: 256 }, (_, b) => {
  const dbz = (b & 127) - 32;
  return dbz < 10 ? 0 : (10 ** (dbz / 10) / 200) ** (1 / 1.6);
});

async function decodeRadarTile(url, grid, ox) {
  const res = await fetch(url); // a CORS block surfaces here as a TypeError
  if (!res.ok) throw new Error(`tile HTTP ${res.status}`);
  const bmp = await createImageBitmap(await res.blob());
  const c = document.createElement("canvas");
  c.width = RV_TILE; c.height = RV_TILE;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0, RV_TILE, RV_TILE);
  const d = ctx.getImageData(0, 0, RV_TILE, RV_TILE).data;
  let grey = 0, coloured = 0;
  for (let y = 0; y < RV_TILE; y++) {
    for (let x = 0; x < RV_TILE; x++) {
      const o = (y * RV_TILE + x) * 4;
      if (d[o + 3] < 8) continue;
      const r = d[o], g = d[o + 1], b = d[o + 2];
      let v;
      if (Math.abs(r - g) <= 3 && Math.abs(g - b) <= 3) { grey++; v = r & 127; }
      // some other palette came back: no dBZ in it, so call it a moderate
      // echo (~45 dBZ) — shape and motion stay right, intensity doesn't
      else { coloured++; v = 77; }
      grid[y * RV_W + ox + x] = v;
    }
  }
  return { grey, coloured };
}

async function loadRadarGrid(f) {
  if (radarGrids.has(f.path)) return radarGrids.get(f.path);
  const grid = new Uint8Array(RV_W * RV_H);
  let grey = 0, coloured = 0;
  for (let i = 0; i < RV_TX.length; i++) {
    const url = `${radarHost}${f.path}/${RV_TILE}/${RV_Z}/${RV_TX[i]}/${RV_TY}/0/1_0.png`;
    const r = await decodeRadarTile(url, grid, i * RV_TILE);
    grey += r.grey; coloured += r.coloured;
  }
  if (coloured > 50 && coloured > grey * 0.25) radarApprox = true;
  radarGrids.set(f.path, grid);
  return grid;
}

// Bilinear rain rate (mm/h) at a fractional domain pixel; 0 outside.
function sampleRate(grid, x, y) {
  x -= 0.5; y -= 0.5;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  if (x0 < 0 || y0 < 0 || x0 >= RV_W - 1 || y0 >= RV_H - 1) return 0;
  const tx = x - x0, ty = y - y0, i = y0 * RV_W + x0;
  const a = RATE_LUT[grid[i]], b = RATE_LUT[grid[i + 1]];
  const c = RATE_LUT[grid[i + RV_W]], d = RATE_LUT[grid[i + RV_W + 1]];
  return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
}

// ---- motion ----

const NOWCAST = {
  f: 4,             // motion is estimated on a 4x-downsampled grid (~2.4 km)
  block: 12,        // matching block, coarse px (~29 km)
  stride: 8,
  maxKmh: 70,       // search radius
  horizonMin: 120,  // radar extrapolation is used up to +2h...
  blendFrom: 45,    // ...handing over to the model from +45 min
  decayMin: 100,    // e-folding of extrapolated intensity (it can't grow)
};
let radarMotion = null; // {vx, vy (full px/min per cell), nx, ny, cw, ch, kmh, toward, key}

function coarseLog(grid, f) {
  const w = RV_W / f, h = RV_H / f, a = new Float32Array(w * h);
  for (let y = 0; y < RV_H; y++) {
    const row = ((y / f) | 0) * w;
    for (let x = 0; x < RV_W; x++) a[row + ((x / f) | 0)] += Math.log1p(RATE_LUT[grid[y * RV_W + x]]);
  }
  for (let i = 0; i < a.length; i++) a[i] /= f * f;
  return { a, w, h };
}

/* Block matching: for each wet block of the later frame B, the shift that
   best matches the earlier frame A (sum of absolute differences), refined
   to sub-pixel with a parabola through the minimum. Vectors are in coarse
   px over the frame gap; flat or ambiguous blocks are dropped. */
function blockMotion(A, B, w, h, block, stride, S) {
  const out = [];
  const n = 2 * S + 1;
  const sad = new Float32Array(n * n);
  for (let by = S; by + block <= h - S; by += stride) {
    for (let bx = S; bx + block <= w - S; bx += stride) {
      let wet = 0;
      for (let y = by; y < by + block; y++) {
        for (let x = bx; x < bx + block; x++) if (B[y * w + x] > 0.05) wet++;
      }
      if (wet < block * block * 0.1) continue;
      let best = Infinity, bi = 0, sum = 0;
      for (let dy = -S; dy <= S; dy++) {
        for (let dx = -S; dx <= S; dx++) {
          let s = 0;
          for (let y = by; y < by + block; y++) {
            const rb = y * w, ra = (y - dy) * w - dx;
            for (let x = bx; x < bx + block; x++) s += Math.abs(B[rb + x] - A[ra + x]);
          }
          const k = (dy + S) * n + dx + S;
          sad[k] = s; sum += s;
          if (s < best) { best = s; bi = k; }
        }
      }
      if (!(best < 0.6 * (sum / (n * n)))) continue;
      const iy = Math.floor(bi / n), ix = bi % n;
      const sub = (m, c, p) => { const d = m - 2 * c + p; return d > 0 ? (0.5 * (m - p)) / d : 0; };
      const fx = ix > 0 && ix < n - 1 ? sub(sad[bi - 1], best, sad[bi + 1]) : 0;
      const fy = iy > 0 && iy < n - 1 ? sub(sad[bi - n], best, sad[bi + n]) : 0;
      out.push({ x: bx + block / 2, y: by + block / 2, dx: ix - S + fx, dy: iy - S + fy, wt: wet });
    }
  }
  return out;
}

/* Smooth motion field on a coarse cell grid: inverse-distance blend of the
   block vectors, pulled toward their median where vectors are sparse, with
   outliers (far from the median) dropped first. */
function motionField(vecs, w, h, f, dtMin) {
  if (!vecs.length) return null;
  const med = (k) => { const s = vecs.map((v) => v[k]).sort((a, b) => a - b); return s[s.length >> 1]; };
  const gx = med("dx"), gy = med("dy");
  const keep = vecs.filter((v) => Math.hypot(v.dx - gx, v.dy - gy) <= Math.max(1.5, 0.8 * Math.hypot(gx, gy)));
  const nx = 16, ny = 8, cw = w / nx, ch = h / ny;
  const vx = new Float32Array(nx * ny), vy = new Float32Array(nx * ny);
  const total = keep.reduce((a, v) => a + v.wt, 0);
  const W0 = total / (60 * 60); // the median, as if seen from ~60 coarse px away
  const scale = f / dtMin;      // coarse px per gap -> full px per minute
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const cx = (i + 0.5) * cw, cy = (j + 0.5) * ch;
      let sw = W0, sx = W0 * gx, sy = W0 * gy;
      for (const v of keep) {
        const wt = v.wt / ((v.x - cx) ** 2 + (v.y - cy) ** 2 + 20 * 20);
        sw += wt; sx += wt * v.dx; sy += wt * v.dy;
      }
      vx[j * nx + i] = (sx / sw) * scale;
      vy[j * nx + i] = (sy / sw) * scale;
    }
  }
  const kmh = Math.hypot(gx, gy) * f * RV_KM_PER_PX * (60 / dtMin);
  const toward = (Math.atan2(gx, -gy) * 180 / Math.PI + 360) % 360; // y grows southward
  return { vx, vy, nx, ny, cw: cw * f, ch: ch * f, kmh, toward, vectors: keep.length };
}

// Motion (full px/min) at a full-res domain pixel, bilinear over the cells.
function motionAt(x, y) {
  const m = radarMotion;
  const fx = Math.min(m.nx - 1, Math.max(0, x / m.cw - 0.5));
  const fy = Math.min(m.ny - 1, Math.max(0, y / m.ch - 0.5));
  const i0 = Math.min(m.nx - 2, Math.floor(fx)), j0 = Math.min(m.ny - 2, Math.floor(fy));
  const tx = fx - i0, ty = fy - j0;
  const at = (arr, i, j) => arr[j * m.nx + i];
  const bl = (arr) => (at(arr, i0, j0) * (1 - tx) + at(arr, i0 + 1, j0) * tx) * (1 - ty) +
    (at(arr, i0, j0 + 1) * (1 - tx) + at(arr, i0 + 1, j0 + 1) * tx) * ty;
  return { vx: bl(m.vx), vy: bl(m.vy) };
}

function updateMotion() {
  const n = radarFrames.length;
  if (n < 2) { radarMotion = null; return; }
  const latest = radarFrames[n - 1];
  let prev = radarFrames[n - 2];
  for (let k = n - 2; k >= 0; k--) {
    if (latest.time - radarFrames[k].time >= 20 * 60) { prev = radarFrames[k]; break; }
  }
  const key = `${prev.path}>${latest.path}`;
  if (radarMotion?.key === key) return;
  const A = radarGrids.get(prev.path), B = radarGrids.get(latest.path);
  if (!A || !B) return;
  const dtMin = (latest.time - prev.time) / 60;
  const f = NOWCAST.f;
  const a = coarseLog(A, f), b = coarseLog(B, f);
  const S = Math.ceil((NOWCAST.maxKmh * dtMin) / 60 / (RV_KM_PER_PX * f));
  const vecs = blockMotion(a.a, b.a, a.w, a.h, NOWCAST.block, NOWCAST.stride, S);
  // no trackable rain anywhere: nothing moves (persistence, still fading)
  radarMotion = motionField(vecs, a.w, a.h, f, dtMin) ??
    { vx: new Float32Array(4), vy: new Float32Array(4), nx: 2, ny: 2, cw: RV_W / 2, ch: RV_H / 2, kmh: 0, toward: 0, vectors: 0 };
  radarMotion.key = key;
  console.info(`[sgtemp] nowcast motion: ${radarMotion.kmh.toFixed(0)} km/h toward ${radarMotion.toward.toFixed(0)}° from ${radarMotion.vectors} blocks`);
}

// ---- ANVIL nowcast: growth and decay ----

/* Pure advection can only slide rain around. This is a browser port of
   ANVIL (Pulkkinen et al. 2020, "Nowcasting of convective rainfall using
   volumetric radar observations", IEEE TGRS; reference implementation in
   pySTEPS, pysteps/nowcasts/anvil.py), which adds growth and decay:

   1. the last four radar frames (10 min apart) are moved into the latest
      frame's Lagrangian coordinates, so only intensity changes remain;
   2. each frame is split into 6 spatial scales with Gaussian band-pass
      filters in Fourier space (pySTEPS filter_gaussian, scale factor ~2.5);
   3. per scale, the frame-to-frame *differences* follow an autoregressive
      integrated ARI(2,1) model whose parameters come from lag-1/lag-2
      correlations estimated in a ~50 km moving window — so a cell that
      was intensifying keeps intensifying, one that was fading keeps
      fading, region by region and scale by scale;
   4. iterating the model gives the Lagrangian forecast every 10 min; the
      display advects it along the motion field.
   Like the original it doesn't create rain where none was observed (the
   "rainrate mask"): brand-new storms stay the model's job.

   Runs on a 2x downsampled grid (512x256, ~1.2 km) once per radar update. */
const ANVIL = {
  levels: 6,
  stepMin: 10,
  steps: 12,         // forecast out to +2h
  windowPx: 40,      // moving-window sigma (~50 km at 1.2 km/px, as pySTEPS' 50 at 1 km)
  maxRate: 150,      // mm/h clamp
};
const AW = RV_W / 2, AH = RV_H / 2; // 512 x 256
let anvilCast = null; // {leads: [Float32Array], t0, key, grew, decayed}

// In-place iterative radix-2 FFT (inv = inverse, unscaled).
function fft1(re, im, off, stride, n, inv) {
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const a = off + i * stride, b = off + j * stride;
      let t = re[a]; re[a] = re[b]; re[b] = t;
      t = im[a]; im[a] = im[b]; im[b] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inv ? 2 : -2) * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = off + (i + k) * stride, b = off + (i + k + len / 2) * stride;
        const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

function fft2(re, im, w, h, inv) {
  for (let y = 0; y < h; y++) fft1(re, im, y * w, 1, w, inv);
  for (let x = 0; x < w; x++) fft1(re, im, x, w, h, inv);
  if (inv) { const s = 1 / (w * h); for (let i = 0; i < w * h; i++) { re[i] *= s; im[i] *= s; } }
}

// pySTEPS filter_gaussian: Gaussian weights in log-wavenumber, normalized
// to sum to one per wavenumber; the mean goes to the largest scale. The y
// wavenumber is rescaled so the non-square domain stays isotropic.
function bandpassWeights(w, h, n) {
  const L = Math.max(w, h), q = (0.5 * L) ** (1 / n);
  const centres = Array.from({ length: n }, (_, k) => 0.5 * (q ** k + q ** (k + 1)));
  const logq = (x) => Math.log(x) / Math.log(q);
  const W = Array.from({ length: n }, () => new Float32Array(w * h));
  for (let y = 0; y < h; y++) {
    const ky = (y < h / 2 ? y : y - h) * (L / h);
    for (let x = 0; x < w; x++) {
      const kx = (x < w / 2 ? x : x - w) * (L / w);
      const r = Math.hypot(kx, ky), i = y * w + x;
      if (r === 0) { W[0][i] = 1; continue; }
      let sum = 0;
      const v = centres.map((c) => { const d = logq(r) - logq(c); const g = Math.exp(-(d * d) / (2 * 0.5 * 0.5)); sum += g; return g; });
      for (let k = 0; k < n; k++) W[k][i] = v[k] / sum;
    }
  }
  return W;
}
let anvilFilters = null;

function decompose(field) {
  const n = AW * AH, re = Float64Array.from(field), im = new Float64Array(n);
  fft2(re, im, AW, AH, false);
  anvilFilters ??= bandpassWeights(AW, AH, ANVIL.levels);
  return anvilFilters.map((wk) => {
    const r = new Float64Array(n), i2 = new Float64Array(n);
    for (let i = 0; i < n; i++) { r[i] = re[i] * wk[i]; i2[i] = im[i] * wk[i]; }
    fft2(r, i2, AW, AH, true);
    return Float32Array.from(r);
  });
}

// Gaussian blur (sigma px) as three box passes, zero outside the domain.
function blurGauss(src, w, h, sigma) {
  const n = 3, wIdeal = Math.sqrt((12 * sigma * sigma) / n + 1);
  let wl = Math.floor(wIdeal); if (wl % 2 === 0) wl--;
  const m = Math.round((12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4));
  let a = Float32Array.from(src), b = new Float32Array(src.length);
  for (let pass = 0; pass < n; pass++) {
    const r = ((pass < m ? wl : wl + 2) - 1) / 2, norm = 1 / (2 * r + 1);
    for (let y = 0; y < h; y++) { // horizontal
      let acc = 0; const o = y * w;
      for (let x = -r; x <= r; x++) if (x >= 0 && x < w) acc += a[o + x];
      for (let x = 0; x < w; x++) {
        b[o + x] = acc * norm;
        const add = x + r + 1, sub = x - r;
        if (add < w) acc += a[o + add];
        if (sub >= 0) acc -= a[o + sub];
      }
    }
    for (let x = 0; x < w; x++) { // vertical
      let acc = 0;
      for (let y = -r; y <= r; y++) if (y >= 0 && y < h) acc += b[y * w + x];
      for (let y = 0; y < h; y++) {
        a[y * w + x] = acc * norm;
        const add = y + r + 1, sub = y - r;
        if (add < h) acc += b[add * w + x];
        if (sub >= 0) acc -= b[sub * w + x];
      }
    }
  }
  return a;
}

// Zero-mean correlation of x and y in a Gaussian moving window (ANVIL
// Sec. II.G; pySTEPS _moving_window_corrcoef).
function movingCorr(x, y, nWin, sigma) {
  const len = x.length, xx = new Float32Array(len), yy = new Float32Array(len), xy = new Float32Array(len);
  for (let i = 0; i < len; i++) { xx[i] = x[i] * x[i]; yy[i] = y[i] * y[i]; xy[i] = x[i] * y[i]; }
  const sx = blurGauss(xx, AW, AH, sigma), sy = blurGauss(yy, AW, AH, sigma), sxy = blurGauss(xy, AW, AH, sigma);
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const n = nWin[i], stdx = Math.sqrt(sx[i] / n), stdy = Math.sqrt(sy[i] / n);
    out[i] = n > 1e-3 && stdx > 1e-8 && stdy > 1e-8 ? (sxy[i] / n) / (stdx * stdy) : 0;
  }
  return out;
}

// rain rate (mm/h) of a full-res frame, 2x2 mean -> AW x AH
function halfRate(grid) {
  const out = new Float32Array(AW * AH);
  for (let y = 0; y < AH; y++) {
    for (let x = 0; x < AW; x++) {
      const i = 2 * y * RV_W + 2 * x;
      out[y * AW + x] = 0.25 * (RATE_LUT[grid[i]] + RATE_LUT[grid[i + 1]] +
        RATE_LUT[grid[i + RV_W]] + RATE_LUT[grid[i + RV_W + 1]]);
    }
  }
  return out;
}

// Bilinear sample of a half-res field at half-res coordinates; 0 outside.
function sampleHalf(f, x, y) {
  x -= 0.5; y -= 0.5;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  if (x0 < 0 || y0 < 0 || x0 >= AW - 1 || y0 >= AH - 1) return 0;
  const tx = x - x0, ty = y - y0, i = y0 * AW + x0;
  return (f[i] + (f[i + 1] - f[i]) * tx) * (1 - ty) + (f[i + AW] + (f[i + AW + 1] - f[i + AW]) * tx) * ty;
}

// Move a half-res field forward by `min` minutes along the motion field
// (semi-Lagrangian: read where each pixel's rain came from).
function advectHalf(f, min) {
  const out = new Float32Array(AW * AH);
  for (let y = 0; y < AH; y++) {
    for (let x = 0; x < AW; x++) {
      const m = radarMotion ? motionAt(2 * x + 1, 2 * y + 1) : { vx: 0, vy: 0 };
      out[y * AW + x] = sampleHalf(f, x + 0.5 - (m.vx * min) / 2, y + 0.5 - (m.vy * min) / 2);
    }
  }
  return out;
}

const pause = () => new Promise((r) => setTimeout(r, 0)); // let the UI breathe

/* frames: the last four decoded grids, oldest first, ~10 min apart.
   Returns Lagrangian forecasts (in the latest frame's coordinates) for
   +10 ... +120 min; display advects them by the lead time. */
async function buildAnvil(frames) {
  const obs = frames.map(halfRate);
  // into the latest frame's Lagrangian coordinates
  const lag = obs.map((f, i) => (i === obs.length - 1 ? f : advectHalf(f, ANVIL.stepMin * (obs.length - 1 - i))));
  await pause();
  const dec = [];
  for (const f of lag) { dec.push(decompose(f)); await pause(); }
  const nWin = blurGauss(new Float32Array(AW * AH).fill(1), AW, AH, ANVIL.windowPx);
  const phi = [];
  for (let k = 0; k < ANVIL.levels; k++) {
    // differences d1 (oldest) .. d3 (newest)
    const d = [1, 2, 3].map((j) => { const a = dec[j][k], b = dec[j - 1][k], o = new Float32Array(a.length); for (let i = 0; i < a.length; i++) o[i] = a[i] - b[i]; return o; });
    const g1 = movingCorr(d[2], d[1], nWin, ANVIL.windowPx);
    const g2 = movingCorr(d[2], d[0], nWin, ANVIL.windowPx);
    const p = [new Float32Array(g1.length), new Float32Array(g1.length), new Float32Array(g1.length)];
    for (let i = 0; i < g1.length; i++) {
      const a = Math.max(-0.999, Math.min(0.999, g1[i]));
      let b = g2[i];
      // pySTEPS adjust_lag2_corrcoef2: keep the AR(2) process stationary
      b = Math.max(b, 2 * a * b - 1);
      if (Math.abs(a) > 1e-6) b = Math.max(b, (3 * a * a - 2 + 2 * (1 - a * a) ** 1.5) / (a * a));
      const pd1 = (a * (1 - b)) / (1 - a * a), pd2 = (b - a * a) / (1 - a * a);
      p[0][i] = 1 + pd1; p[1][i] = -pd1 + pd2; p[2][i] = -pd2;
    }
    phi.push(p);
    await pause();
  }
  // no new rain where none was observed (ANVIL's rainrate mask), with a
  // pixel of slack so edges can breathe
  const latest = obs[obs.length - 1];
  const wet = blurGauss(Float32Array.from(latest, (v) => (v >= 0.1 ? 1 : 0)), AW, AH, 1.5);
  // state per level: the last three Lagrangian fields
  const state = Array.from({ length: ANVIL.levels }, (_, k) => [dec[1][k], dec[2][k], dec[3][k]]);
  const leads = [];
  // Extrapolated trends compound (a cell that doubled in 10 min would keep
  // doubling), so cap growth at 1.5x the heaviest rain now observed.
  let peak0 = 0; for (const v of latest) if (v > peak0) peak0 = v;
  const cap = Math.min(ANVIL.maxRate, 1.5 * peak0 + 5);
  for (let s = 0; s < ANVIL.steps; s++) {
    const out = new Float32Array(AW * AH);
    for (let k = 0; k < ANVIL.levels; k++) {
      const [x2, x1, x0] = state[k], [p0, p1, p2] = phi[k];
      const nx = new Float32Array(x0.length);
      for (let i = 0; i < nx.length; i++) nx[i] = p0[i] * x0[i] + p1[i] * x1[i] + p2[i] * x2[i];
      state[k] = [x1, x0, nx];
      for (let i = 0; i < nx.length; i++) out[i] += nx[i];
    }
    for (let i = 0; i < out.length; i++) {
      const v = wet[i] < 0.05 ? 0 : out[i];
      out[i] = v < 0 ? 0 : v > cap ? cap : v;
    }
    leads.push(out);
    if (s % 3 === 2) await pause();
  }
  return { leads, latest };
}

// Lagrangian ANVIL field at a fractional lead (minutes), linearly between
// the 10-min steps (same coordinates, so no ghosting).
function anvilAtLead(lead) {
  // lead can be slightly negative: the newest radar frame may be a few
  // minutes newer than the newest temperature reading that defines "now"
  // (this once indexed leads[-1], threw mid-glide and froze the slider)
  const k = Math.max(0, lead) / ANVIL.stepMin;
  const i = Math.floor(k), f = k - i;
  const a = i <= 0 ? anvilCast.latest : anvilCast.leads[Math.min(i, ANVIL.steps) - 1];
  const b = anvilCast.leads[Math.min(i + 1, ANVIL.steps) - 1];
  return { a, b, f };
}

async function updateAnvil() {
  const n = radarFrames.length;
  if (radarMode !== "pixels" || n < 4) { anvilCast = null; return; }
  const fr = radarFrames.slice(-4);
  // needs a regular ~10-min series
  for (let i = 1; i < 4; i++) {
    const gap = fr[i].time - fr[i - 1].time;
    if (gap < 8 * 60 || gap > 12 * 60) { anvilCast = null; return; }
  }
  const grids = fr.map((f) => radarGrids.get(f.path));
  if (grids.some((g) => !g)) return;
  const key = fr.map((f) => f.path).join(">") + `|${radarMotion?.key}`;
  if (anvilCast?.key === key) return;
  const t = performance.now?.() ?? Date.now();
  setLoading("nowcast", "nowcast");
  let res;
  try { res = await buildAnvil(grids); } finally { setLoading("nowcast", null); }
  anvilCast = { ...res, t0: fr[3].time, key };
  console.info(`[sgtemp] ANVIL nowcast built in ${Math.round((performance.now?.() ?? Date.now()) - t)} ms`);
  scheduleRender();
}

// Forecast rate at a domain pixel, leadMin after the latest frame: follow
// the motion backwards, then read the ANVIL field there (growth/decay) —
// or, before ANVIL has run, the latest frame itself, fading.
function nowcastRate(grid, x, y, leadMin, t0) {
  leadMin = Math.max(0, leadMin);
  const m = radarMotion ? motionAt(x, y) : { vx: 0, vy: 0 };
  const sx = x - m.vx * leadMin, sy = y - m.vy * leadMin;
  if (anvilCast && anvilCast.t0 === t0) {
    const { a, b, f } = anvilAtLead(leadMin);
    return sampleHalf(a, sx / 2, sy / 2) * (1 - f) + sampleHalf(b, sx / 2, sy / 2) * f;
  }
  return sampleRate(grid, sx, sy) * Math.exp(-leadMin / NOWCAST.decayMin);
}

/* Between two decoded past frames (10 min apart), rain moves instead of
   popping: the earlier frame is carried forward and the later one back
   along the motion field to the displayed moment, then cross-faded
   (motion-compensated interpolation). */
function radarPairAt(t) {
  let a = null, b = null;
  for (const f of radarFrames) {
    if (f.time * 1000 <= t) a = f;
    else { b = f; break; }
  }
  if (!a || !b || b.time - a.time > 15 * 60) return null;
  const ga = radarGrids.get(a.path), gb = radarGrids.get(b.path);
  if (!ga || !gb) return null;
  const ta = (t - a.time * 1000) / 60_000, tb = (b.time * 1000 - t) / 60_000;
  const w = ta / (ta + tb);
  return {
    a, b, w,
    rate: (lat, lon, x = rvX(lon), y = rvY(lat)) => {
      const m = radarMotion ? motionAt(x, y) : { vx: 0, vy: 0 };
      return (1 - w) * sampleRate(ga, x - m.vx * ta, y - m.vy * ta) +
        w * sampleRate(gb, x + m.vx * tb, y + m.vy * tb);
    },
  };
}

function latestRadar() {
  const f = radarFrames[radarFrames.length - 1];
  const grid = f && radarMode === "pixels" ? radarGrids.get(f.path) : null;
  return grid ? { f, grid } : null;
}

function radarFrameFor(tMs) {
  let best = null, bestD = Infinity;
  for (const f of radarFrames) {
    const d = Math.abs(f.time * 1000 - tMs);
    if (d < bestD) { bestD = d; best = f; }
  }
  return bestD <= 15 * 60_000 ? best : null;
}

/* What the rain looks like at displayed time t, as a rate(lat, lon) in
   mm/h plus where it comes from:
   - past/live: the matching radar frame ("radar"), if decoded;
   - future: nowcast, then nowcast->model blend, then model. */
function rainContext(t) {
  if (!isFutureView()) {
    const f = displayedT === null ? radarFrames[radarFrames.length - 1] : radarFrameFor(t);
    const grid = f && radarMode === "pixels" ? radarGrids.get(f.path) : null;
    if (!grid) return { src: radarMode === "tiles" && f ? "tiles" : f ? "pending" : "none", frame: f };
    const pair = displayedT === null ? null : radarPairAt(t);
    if (pair) return { src: "radar", frame: f, pair, rate: pair.rate };
    return { src: "radar", frame: f, rate: (lat, lon, x = rvX(lon), y = rvY(lat)) => sampleRate(grid, x, y) };
  }
  const latest = latestRadar();
  const lead = latest ? Math.max(0, (t - latest.f.time * 1000) / 60_000) : Infinity;
  const p = forecastRainGrid(t);
  const modelRate = p ? (lat, lon) => Math.max(0, gridSampleCubic(p, lat, lon)) : null;
  const useRadar = !!latest && lead <= NOWCAST.horizonMin;
  if (!useRadar && !modelRate) return { src: "none" };
  const radarRate = useRadar
    ? (lat, lon, x = rvX(lon), y = rvY(lat)) => nowcastRate(latest.grid, x, y, lead, latest.f.time) : null;
  const w = !useRadar ? 1 : !modelRate ? 0
    : smooth01((lead - NOWCAST.blendFrom) / (NOWCAST.horizonMin - NOWCAST.blendFrom));
  const src = w >= 1 ? "model" : w <= 0 ? "nowcast" : "blend";
  return {
    src, lead, frame: latest?.f, anvil: !!anvilCast && anvilCast.t0 === latest?.f.time,
    rate: w >= 1 ? modelRate : w <= 0 ? radarRate
      : (lat, lon, x, y) => (1 - w) * radarRate(lat, lon, x, y) + w * modelRate(lat, lon),
  };
}

// ---- rain cloud layer ----

// Raster aligned to the radar pixels over the map window (~0.6 km each).
const CLOUD = (() => {
  const x0 = Math.floor(rvX(OVERLAY.lonMin)), x1 = Math.ceil(rvX(OVERLAY.lonMax));
  const y0 = Math.floor(rvY(OVERLAY.latMax)), y1 = Math.ceil(rvY(OVERLAY.latMin));
  return { x0, y0, w: x1 - x0, h: y1 - y0 };
})();
let cloudLayer = null, cloudCanvas = null, cloudKey = "";

// mm/h -> cloud opacity/brightness: faint grey drizzle, dense white downpour
function cloudLook(mm) {
  if (!(mm > 0.1)) return null;
  const k = Math.min(1, Math.log1p(mm) / Math.log1p(20)) ** 0.7;
  return { a: 0.65 * k, c: Math.round(178 + 72 * k) };
}

function hideClouds() {
  if (cloudLayer) cloudLayer.setOpacity(0);
  cloudKey = "";
}

function fmtClock(sec) {
  return new Date(sec * 1000).toLocaleTimeString("en-SG",
    { timeZone: "Asia/Singapore", hour: "2-digit", minute: "2-digit" });
}

function renderClouds(light = false) {
  if (typeof L === "undefined" || !map) return;
  if (!radarOn) { hideClouds(); setRadarStatus("off"); return; }
  const t = displayedTime() ?? Date.now();
  const ctx = rainContext(t);
  const approx = radarApprox ? " · intensity approx. (unexpected palette)" : "";
  const note = radarModeNote ? ` · ${radarModeNote}` : "";
  const m = radarMotion;
  const motion = m && m.kmh >= 3 ? ` · rain moving ${m.kmh.toFixed(0)} km/h → ${COMPASS[Math.round(m.toward / 22.5) % 16]}` : "";
  const method = ctx.anvil ? "ANVIL" : "advection";
  if (ctx.src === "radar") {
    setRadarStatus(ctx.pair
      ? `${radarSource} frames ${fmtClock(ctx.pair.a.time)}→${fmtClock(ctx.pair.b.time)} (interpolated)${approx}${note}`
      : `${radarSource} frame ${fmtClock(ctx.frame.time)}${approx}${note}`);
  }
  else if (ctx.src === "nowcast") setRadarStatus(`nowcast (${method}) +${Math.round(ctx.lead)} min${motion}${approx}`);
  else if (ctx.src === "blend") setRadarStatus(`nowcast (${method})→model +${Math.round(ctx.lead)} min${motion}`);
  else if (ctx.src === "model") {
    setRadarStatus(radarMode === "pixels" && latestRadar() ? "model rain (past the 2h nowcast)" : `model rain${note}`);
  }
  else if (ctx.src === "pending") setRadarStatus("loading radar…");
  else if (ctx.src === "none") setRadarStatus(radarFrames.length ? "no radar at this time" : "no radar frames");
  // "tiles": applyTileFrame owns the status
  if (!ctx.rate) { hideClouds(); return; }

  const key = `${t}|${light}|${ctx.src}|${ctx.frame?.path}|${radarMotion?.key}|${anvilCast?.key}|${model?.times?.[0]}|${GRID_NLAT}`;
  if (key === cloudKey) return;
  // mid-glide frames at half resolution; the landing frame is full
  const f = light ? 2 : 1, CW = Math.ceil(CLOUD.w / f), CH = Math.ceil(CLOUD.h / f);
  cloudCanvas ??= document.createElement("canvas");
  if (typeof cloudCanvas.getContext !== "function") return;
  if (cloudCanvas.width !== CW || cloudCanvas.height !== CH) {
    cloudCanvas.width = CW;
    cloudCanvas.height = CH;
  }
  const c2 = cloudCanvas.getContext("2d");
  const img = c2.createImageData(CW, CH);
  const future = isFutureView();
  const xs = Array.from({ length: CW }, (_, i) => CLOUD.x0 + (i + 0.5) * f);
  const lons = xs.map(rvLon);
  for (let j = 0; j < CH; j++) {
    const y = CLOUD.y0 + (j + 0.5) * f, lat = rvLat(y);
    for (let i = 0; i < CW; i++) {
      const look = cloudLook(ctx.rate(lat, lons[i], xs[i], y));
      if (!look) continue;
      const o = (j * CW + i) * 4;
      img.data[o] = look.c; img.data[o + 1] = look.c; img.data[o + 2] = Math.min(255, look.c + 4);
      img.data[o + 3] = Math.round(255 * look.a * (future ? 0.85 : 1));
    }
  }
  c2.putImageData(img, 0, 0);
  if (!cloudLayer) {
    cloudLayer = L.svgOverlay(cloudCanvas,
      [[rvLat(CLOUD.y0 + CLOUD.h), rvLon(CLOUD.x0)], [rvLat(CLOUD.y0), rvLon(CLOUD.x0 + CLOUD.w)]],
      { pane: "clouds", opacity: 1, interactive: false, className: "canvas-layer rain-clouds",
        // short: a two-line credit overlaps the phone timebar
        attribution: 'Radar <a href="https://librewxr.net/">LibreWXR</a>·<a href="https://www.rainviewer.com/">RainViewer</a>' }).addTo(map);
  } else {
    cloudLayer.setOpacity(1);
  }
  cloudKey = key;
}

// ---- fallback: RainViewer's own coloured tiles (no pixel access) ----

const radarLayers = new Map(); // frame path -> persistent preloaded layer
let radarShown = null;         // frame path currently visible

function radarUrl(path) {
  // 512px tiles double the resolution at the same zoom cap; scheme 6 =
  // NEXRAD (the free tier may serve its single scheme regardless)
  return `${radarHost}${path}/512/{z}/{x}/{y}/6/1_1.png`;
}

function makeRadarLayer(url) {
  const l = L.tileLayer(url, {
    pane: "radar",
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
    l.on("tileerror", () => setRadarStatus("tiles failing"));
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

/* Tile fallback: every frame is a persistent preloaded layer, so a scrub is
   just an opacity flip (anything that reloads tiles on scrub fades). */
function applyTileFrame() {
  const pane = map.getPane && map.getPane("radar");
  const f = displayedT === null
    ? radarFrames[radarFrames.length - 1]
    : isFutureView() ? null : radarFrameFor(displayedTime() ?? Date.now());
  if (!f) {
    if (pane) pane.style.display = "none";
    return;
  }
  if (pane) pane.style.display = "";
  if (f.path === radarShown) return;
  radarShown = f.path;
  const l = layerFor(f.path);
  const finalize = () => {
    if (radarShown !== f.path) return; // the scrub has moved on
    for (const [p, ly] of radarLayers) ly.setOpacity(p === f.path ? 0.7 : 0);
    setRadarStatus(`tiles ${fmtClock(f.time)} · ${radarModeNote}`);
  };
  if (l._warm || !l.once) finalize();
  else l.once("load", finalize);
}

function applyRadarFrame(light = false) {
  if (radarMode === "tiles" && radarOn && radarHost && radarFrames.length) applyTileFrame();
  renderClouds(light);
}

// Radar sources, best first; both speak the RainViewer API. LibreWXR is an
// open-source RainViewer replacement whose public instance carries MET
// Malaysia's 12-radar composite (Peninsular Malaysia + Singapore, ~2.5 km,
// 10-min); RainViewer is the fallback. The first source whose pixels
// decode wins; if none do, the first reachable one is shown as tiles.
const RADAR_SOURCES = [
  { name: "LibreWXR", meta: "https://api.librewxr.net/public/weather-maps.json" },
  { name: "RainViewer", meta: RV_META_URL },
];
let radarSource = "";

function useRadarSource(name, json) {
  if (name !== radarSource) {
    radarGrids.clear();
    radarMotion = null;
    anvilCast = null;
    for (const ly of radarLayers.values()) ly.remove();
    radarLayers.clear();
    radarShown = null;
    radarApprox = false;
  }
  radarSource = name;
  radarHost = json.host;
  // past frames only: RainViewer's free tier dropped forecast frames and
  // LibreWXR's (60 min) would seam against ours — the nowcast is ANVIL
  radarFrames = json.radar.past.slice().sort((a, b) => a.time - b.time);
}

async function fetchRadar() {
  if (!radarOn) { setRadarStatus("off"); return; }
  const errors = [];
  let reachable = null, decoded = false;
  for (const src of RADAR_SOURCES) {
    let json;
    try {
      const res = await fetch429(src.meta);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      json = await res.json();
      if (!json.radar?.past?.length) throw new Error("no frames");
    } catch (e) {
      errors.push(`${src.name}: ${e.message}`);
      continue;
    }
    reachable ??= { name: src.name, json };
    useRadarSource(src.name, json);
    try {
      await loadRadarGrid(radarFrames[radarFrames.length - 1]);
      decoded = true;
      break;
    } catch (e) {
      errors.push(`${src.name} pixels: ${e.message}`);
      radarGrids.clear();
    }
  }
  if (!reachable) throw new Error(errors.join("; "));
  if (!decoded) {
    // nothing decodable: plain coloured tiles from the first reachable
    // source, no nowcast — and say so
    useRadarSource(reachable.name, reachable.json);
    radarMode = "tiles";
    radarModeNote = `radar pixels unreadable (${errors.join("; ")}) — coloured tiles, no nowcast`;
    console.warn(`[sgtemp] ${radarModeNote}`);
    applyRadarFrame();
    setTimeout(() => {
      if (radarOn && radarHost) for (const f of radarFrames) layerFor(f.path);
    }, 2500);
    return;
  }
  radarMode = "pixels";
  for (const ly of radarLayers.values()) ly.remove();
  radarLayers.clear();
  radarShown = null;
  radarModeNote = errors.length ? `fallback (${errors.join("; ")})` : "";
  if (errors.length) console.warn(`[sgtemp] radar ${radarModeNote}`);
  const valid = new Set(radarFrames.map((f) => f.path));
  for (const p of radarGrids.keys()) if (!valid.has(p)) radarGrids.delete(p);
  scheduleRender();
  // the three before the latest (ANVIL needs four), then the rest newest first
  const n = radarFrames.length;
  const order = [...Array.from({ length: n }, (_, i) => n - 1 - i)].map((i) => radarFrames[i]);
  let failed = 0;
  for (const [k, f] of order.entries()) {
    if (!radarGrids.has(f.path)) setLoading("radar", `radar ${k + 1}/${n}`);
    try { await loadRadarGrid(f); } catch { failed++; }
    if (k === 3) {
      updateMotion();
      await updateAnvil();
    }
  }
  if (failed) console.warn(`[sgtemp] ${failed} radar frame(s) failed to load`);
  updateMotion();
  await updateAnvil();
  scheduleRender();
}

function pollRadar() {
  fetchRadar().catch((e) => setRadarStatus(`unreachable (${e.message})`));
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
    const col = "rgba(222, 229, 239, 0.9)"; // neutral: colour means temperature
    let m = windPins.get(p.id);
    if (!m) {
      m = L.marker([p.lat, p.lon], {
        keyboard: false,
        icon: L.divIcon({
          className: "",
          html: `<span class="wind-spot">${windSockHtml(p, 5, 5, col)}<span class="wind-dot"></span></span>`,
          iconSize: [0, 0],
        }),
      }).addTo(map);
      m.bindTooltip("");
      windPins.set(p.id, m);
    } else {
      // restyle in place: a fresh divIcon per scrub step blinks the pin
      const sock = m.getElement && m.getElement()?.querySelector(".wind-sock");
      if (sock && sock.style) applySock(sock, p, 5, 5, col);
    }
    if (m.setTooltipContent) {
      m.setTooltipContent(`${p.name} · ${kmh.toFixed(0)} km/h from ${COMPASS[Math.round(from / 22.5) % 16]}`);
    }
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
  } else if (displayedT !== null && !isFutureView()) {
    el.textContent = "no observations at this time"; // the particles stop too
    return;
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
  // grid rows count from latMin upward; fy counts from latMax downward.
  // (Hot path while scrubbing: no closures or arrays per call.)
  const r0 = (GRID_NLAT - 1 - cy) * GRID_NLON + cx, r1 = r0 - GRID_NLON;
  const v00 = grid[r0], v01 = grid[r0 + 1], v10 = grid[r1], v11 = grid[r1 + 1];
  if (v00 !== v00 || v01 !== v01 || v10 !== v10 || v11 !== v11) return null; // NaN
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
    // a compact arrow + compass point: the map's windsock wedge is up to
    // 46px long and, rotated inside a list row, spilled over its neighbours
    el.innerHTML = `
      <span class="station-name"></span>
      <span class="wind-row-dir"><svg class="wind-arrow" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M8 1.5 12.5 13 8 10.3 3.5 13z"/></svg><span class="wind-compass"></span></span>
      <span class="station-temp wind-speed"></span>`;
    el.addEventListener("click", () => { if (map && map.panTo) map.panTo([p.lat, p.lon]); });
    windListEls.set(p.id, el);
  }
  const kmh = Math.hypot(p.u, p.v);
  const toward = (Math.atan2(p.u, p.v) * 180 / Math.PI + 360) % 360;
  el.querySelector(".station-name").textContent = p.name;
  const arrow = el.querySelector(".wind-arrow");
  if (arrow && arrow.style) arrow.style.transform = `rotate(${Math.round(toward)}deg)`;
  el.querySelector(".wind-compass").textContent = COMPASS[Math.round(((toward + 180) % 360) / 22.5) % 16];
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
// light = mid-glide frame: half resolution (4x fewer pixels); the landing
// frame redraws at full resolution
function renderOverlay(values, grid, light = false) {
  const OW = light ? OVERLAY.w >> 1 : OVERLAY.w, OH = light ? OVERLAY.h >> 1 : OVERLAY.h;
  const pts = [...stations.values()]
    .filter((s) => values.has(s.id) && Number.isFinite(s.lat) && Number.isFinite(s.lon))
    .map((s) => ({
      lat: s.lat, lon: s.lon, v: values.get(s.id),
      wt: s.kind === "civ" ? CIV_RESIDUAL_WT : 1,
    }));
  if (!grid && pts.length < 3) return;
  const residuals = grid ? computeResiduals(pts, grid) : [];

  overlayCanvas ??= document.createElement("canvas");
  if (typeof overlayCanvas.getContext !== "function") return;
  const n = OW * OH;
  if (overlayCanvas.width !== OW || overlayCanvas.height !== OH) {
    overlayCanvas.width = OW; // the layer keeps its on-map size; the canvas scales
    overlayCanvas.height = OH;
  }
  if (!fieldCache || fieldCache.length !== n) {
    fieldCache = new Float32Array(n);
    fadeCache = new Float32Array(n);
    overlayImg = null;
  }
  const cosLat = Math.cos((1.35 * Math.PI) / 180);
  const edgePx = Math.round(OW * 0.05);
  // This loop runs every frame while scrubbing, so the per-pixel work is
  // precomputed: squared station distances split into a column part and a
  // row part (dx^2 + dy^2), and the model grid's bilinear weights per row
  // and column. Same field as fieldAt(), several times faster.
  const R = residuals.length;
  const dx2 = new Float32Array(R * OW), dy2 = new Float32Array(R * OH);
  const rw = new Float32Array(R), rr = new Float32Array(R);
  residuals.forEach((p, k) => { rw[k] = p.wt ?? 1; rr[k] = p.r; });
  for (let px = 0; px < OW; px++) {
    const lon = OVERLAY.lonMin + ((px + 0.5) / OW) * (OVERLAY.lonMax - OVERLAY.lonMin);
    for (let k = 0; k < R; k++) dx2[k * OW + px] = ((lon - residuals[k].lon) * cosLat * KM_PER_DEG) ** 2;
  }
  for (let py = 0; py < OH; py++) {
    const lat = OVERLAY.latMax - ((py + 0.5) / OH) * (OVERLAY.latMax - OVERLAY.latMin);
    for (let k = 0; k < R; k++) dy2[k * OH + py] = ((lat - residuals[k].lat) * KM_PER_DEG) ** 2;
  }

  // model base, bilinear: blend the two grid rows once per raster row,
  // then only interpolate along x per pixel
  const rowVals = new Float32Array(GRID_NLON);
  const colIdx = new Int32Array(OW), colT = new Float32Array(OW);
  for (let px = 0; px < OW; px++) {
    const fx = ((px + 0.5) / OW) * (GRID_NLON - 1);
    colIdx[px] = Math.min(GRID_NLON - 2, Math.floor(fx));
    colT[px] = fx - colIdx[px];
  }
  for (let py = 0; py < OH; py++) {
    const lat = OVERLAY.latMax - ((py + 0.5) / OH) * (OVERLAY.latMax - OVERLAY.latMin);
    if (grid) {
      const fy = ((py + 0.5) / OH) * (GRID_NLAT - 1);
      const cy = Math.min(GRID_NLAT - 2, Math.floor(fy)), ty = fy - cy;
      const r0 = (GRID_NLAT - 1 - cy) * GRID_NLON, r1 = r0 - GRID_NLON;
      for (let ix = 0; ix < GRID_NLON; ix++) rowVals[ix] = grid[r0 + ix] + (grid[r1 + ix] - grid[r0 + ix]) * ty;
    }
    for (let px = 0; px < OW; px++) {
      const lon = OVERLAY.lonMin + ((px + 0.5) / OW) * (OVERLAY.lonMax - OVERLAY.lonMin);
      const i = py * OW + px;
      if (grid) {
        const c = colIdx[px], a = rowVals[c], b = rowVals[c + 1];
        const base = a + (b - a) * colT[px];
        if (base !== base) { fieldCache[i] = NaN; continue; } // NaN
        let wSum = 0, rSum = 0;
        for (let k = 0; k < R; k++) {
          const w = rw[k] / (dx2[k * OW + px] + dy2[k * OH + py] + 0.05);
          wSum += w; rSum += w * rr[k];
        }
        fieldCache[i] = base + rSum / (wSum + RESIDUAL_LAMBDA);
        // soft fade only at the raster's outer edges
        const edge = Math.min(px, OW - 1 - px, py, OH - 1 - py) / edgePx;
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

/* Colour pass over the cached field, through a 256-step lookup table over
   the current scale (colour + extremeness alpha) and a reused buffer —
   per-pixel colour arrays made this the slowest part of a scrub frame. */
let overlayImg = null;
const OV_LUT_N = 256;
const ovLut = new Uint8ClampedArray(OV_LUT_N * 4);

function paintOverlay() {
  if (!fieldCache || !overlayCanvas || typeof overlayCanvas.getContext !== "function") return;
  const ctx = overlayCanvas.getContext("2d");
  const OW = overlayCanvas.width, OH = overlayCanvas.height;
  overlayImg ??= ctx.createImageData(OW, OH);
  const data = overlayImg.data;
  const span = scaleHi - scaleLo || 1;
  for (let k = 0; k < OV_LUT_N; k++) {
    const v = scaleLo + (k / (OV_LUT_N - 1)) * span;
    const [r, g, b] = tempRGB(v);
    ovLut[k * 4] = r; ovLut[k * 4 + 1] = g; ovLut[k * 4 + 2] = b;
    ovLut[k * 4 + 3] = Math.round(255 * OVERLAY_MAX_ALPHA * extremeness(v));
  }
  const n = OW * OH, scale = (OV_LUT_N - 1) / span;
  for (let i = 0; i < n; i++) {
    const v = fieldCache[i], o = i * 4;
    if (v !== v) { data[o + 3] = 0; continue; } // NaN
    const k = Math.min(OV_LUT_N - 1, Math.max(0, Math.round((v - scaleLo) * scale))) * 4;
    data[o] = ovLut[k]; data[o + 1] = ovLut[k + 1]; data[o + 2] = ovLut[k + 2];
    data[o + 3] = ovLut[k + 3] * fadeCache[i];
  }
  ctx.putImageData(overlayImg, 0, 0);
  // the canvas itself is the map layer (svgOverlay takes any element): no
  // PNG encode/decode per frame, which made scrubbing stutter
  overlayLayer ??= L.svgOverlay(overlayCanvas,
    [[OVERLAY.latMin, OVERLAY.lonMin], [OVERLAY.latMax, OVERLAY.lonMax]],
    { opacity: 1, interactive: false, className: "canvas-layer" }).addTo(map);
}

function renderTimebar(t, light = false) {
  const slider = document.getElementById("time-slider");
  const label = document.getElementById("time-label");
  const liveBtn = document.getElementById("live-btn");
  slider.max = Math.max(0, sliderTicks.length - 1);
  if (sliderDragging) {
    // the thumb is under the finger: never move it from here
  } else if (displayedT === null) {
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
    wrap.classList.toggle("future", future);
    const max = Number(slider.max);
    if (wrap.style.setProperty) {
      wrap.style.setProperty("--live-frac", max > 0 ? (Math.max(0, sliderLiveIdx) / max).toFixed(4) : "1");
    }
    if (!light) renderRainTrack(wrap);
  }
  const f = dayFactor(t ?? Date.now());
  document.getElementById("sky-icon").textContent = f > 0.8 ? "☀️" : f < 0.2 ? "🌙" : "🌅";
  liveBtn.classList.toggle("active", displayedT === null && scrubTarget === null);
}

/* Scrubbing glide: the slider (or LIVE) sets a target time, and the shown
   time eases toward it every animation frame (exponential, ~90 ms time
   constant). A drag that jumps several 5-minute ticks per input event
   plays as continuous motion instead of snapping from state to state. */
let scrubTarget = null;   // null = live
let scrubAnim = false, scrubLast = 0, sliderDragging = false;
const SCRUB_TAU_MS = 90;

function liveTime() {
  return timeline.length ? timeline[timeline.length - 1] : Date.now();
}

function scrubTo(target) {
  scrubTarget = target;
  if (scrubAnim) return;
  scrubAnim = true;
  scrubLast = typeof performance !== "undefined" ? performance.now() : Date.now();
  requestAnimationFrame(scrubStep);
}

function scrubStep(now) {
  const dt = Math.min(64, Math.max(1, now - scrubLast));
  scrubLast = now;
  const cur = displayedT ?? liveTime();
  const tgt = scrubTarget ?? liveTime();
  const d = tgt - cur;
  const landing = Math.abs(d) < 15_000; // within 15 s: land exactly, full render
  displayedT = landing ? scrubTarget : cur + d * (1 - Math.exp(-dt / SCRUB_TAU_MS));
  // A render error must never leave the glide half-running: scrubAnim
  // stuck at true made scrubTo() ignore every later slider move. Say what
  // broke on screen, and keep the glide alive.
  try {
    renderAll(!landing);
  } catch (e) {
    console.error("[sgtemp] render failed while scrubbing", e);
    showError(`Display error while scrubbing: ${e.message} — please report (v${APP_VERSION})`);
  }
  if (landing) scrubAnim = false;
  else requestAnimationFrame(scrubStep);
}

// light = mid-glide frame: skip the station list, detail panel and slider
// track (heavy DOM work that nobody reads while the map is moving)
function renderAll(light = false) {
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
  if (!light) {
    renderList(values);
    renderDetail(values, t);
  }
  renderSummary(values);
  renderOverlay(values, grid, light);
  renderTimebar(t, light);
  renderWindStatus();
  renderWindPins();
  renderRain(); // rain follows the scrubber (24h series)
  applyRadarFrame(light); // radar, nowcast and model rain follow it too
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
    if (!budget) {
      // no field here (e.g. a past hour with no observations): show nothing
      // rather than leaving the last frame frozen on screen
      windCtx.clearRect(0, 0, windCanvas.width, windCanvas.height);
      last = ts;
      return;
    }
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
  const radarPane = map.createPane("radar"); // RainViewer tiles (fallback only)
  radarPane.style.zIndex = 430; // above the shading (400), below markers (600)
  radarPane.style.pointerEvents = "none";
  const cloudPane = map.createPane("clouds"); // decoded radar / nowcast / model rain
  cloudPane.style.zIndex = 432;
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
  const basemap = L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png" +
    (CARTO_KEY ? `?key=${encodeURIComponent(CARTO_KEY)}` : ""), tileOpts).addTo(map);
  if (basemap.on) {
    basemap.on("loading", () => setLoading("tiles", "map"));
    basemap.on("load", () => setLoading("tiles", null));
  }
  // the watermarked tiles load "fine", so say it out loud
  const baseEl = document.getElementById("basemap-status");
  if (baseEl) baseEl.textContent = CARTO_KEY ? "CARTO" : "CARTO — no API key, tiles watermarked";
  if (!CARTO_KEY) console.warn("[sgtemp] CARTO_KEY is empty: basemap tiles will show an API KEY REQUIRED watermark");

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

{
  const slider = document.getElementById("time-slider");
  slider.addEventListener("input", (e) => {
    const idx = Number(e.target.value);
    scrubTo(idx === sliderLiveIdx ? null : sliderTicks[idx]);
  });
  const down = () => { sliderDragging = true; };
  const up = () => { sliderDragging = false; };
  for (const ev of ["pointerdown", "touchstart", "mousedown"]) slider.addEventListener(ev, down);
  for (const ev of ["pointerup", "pointercancel", "touchend", "touchcancel", "mouseup", "change"]) slider.addEventListener(ev, up);
}

document.getElementById("live-btn").addEventListener("click", () => scrubTo(null));

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
    hideClouds();
    setRadarStatus("off");
  } else {
    for (const ly of radarLayers.values()) ly.addTo(map);
    radarShown = null;
    if (!radarFrames.length) pollRadar();
    applyRadarFrame();
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
// loading indicator hooks (first loads and archives; routine polls stay quiet)
loadHistory = withLoading("hist", "24h history", loadHistory);
loadWindHistory = withLoading("windhist", () => (windDayLoaded ? null : "wind history"), loadWindHistory);
loadRainHistory = withLoading("rainhist", () => (rainDayLoaded ? null : "rain history"), loadRainHistory);
seedRainRecent = withLoading("rainseed", "recent rain", seedRainRecent);
refresh = withLoading("temp", () => (latestReadingT == null ? "temperatures" : null), refresh);
refreshModel = withLoading("model", () => (model ? null : "forecast"), refreshModel);
fetchRadar = withLoading("radar", "radar", fetchRadar);

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
  pollRadar();
  if (!TEST_RAIN) {
    setTimeout(() => seedRainRecent().catch(() => {}), 3000);
    setTimeout(() => loadRainHistory().catch(() => {}), 6000);
  }
});
if (typeof localStorage !== "undefined") seedWindFromCache();
pollWind();
setInterval(pollRain, RAIN_POLL_MS);
setInterval(pollRadar, RADAR_POLL_MS);
setInterval(pollWind, POLL_MS);
refreshModel();
setInterval(refresh, POLL_MS);
setInterval(refreshModel, MODEL_REFRESH_MS);
setInterval(tickStatus, 1000);
setInterval(pollCommunity, CIV_POLL_MS);
setInterval(renderLive, 1500); // live numbers drift slightly between polls
