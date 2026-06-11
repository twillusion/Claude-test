/* SG Temp — live Singapore air temperature from data.gov.sg (NEA).
   No backend: the browser talks to the public API directly. The v2 API is
   primary; the v1 API is kept as a fallback since both are public and
   CORS-enabled. History is loaded in bulk (one request per calendar day
   returns the whole day at per-minute resolution), which powers the time
   scrubber and the interpolated shading overlay. */

const V2_URL = "https://api-open.data.gov.sg/v2/real-time/api/air-temperature";
const V1_URL = "https://api.data.gov.sg/v1/environment/air-temperature";
const OM_URL = "https://api.open-meteo.com/v1/forecast";
const POLL_MS = 60_000;
const MODEL_REFRESH_MS = 30 * 60_000; // Open-Meteo models update hourly
const HISTORY_HOURS = 24;
const SLIDER_STEP_MIN = 5; // scrubber granularity; underlying data is per-minute

// Geographic window and raster size for the shading overlay; the Open-Meteo
// sample grid shares the same bounds so the raster never extrapolates, and
// the map is hard-locked to this exact window.
const OVERLAY = { latMin: 1.09, latMax: 1.56, lonMin: 103.48, lonMax: 104.22, w: 240, h: 152 };
const GRID_NLAT = 9;
const GRID_NLON = 13;
const KM_PER_DEG = 111.32;
// Station residuals shrink toward zero away from stations; at ~12 km the
// correction is halved, so the model field dominates where there's no sensor.
const RESIDUAL_LAMBDA = 1 / (12 * 12);

// Sensor.Community citizen sensors (open API, no key). Civilian-grade:
// included at reduced weight, sanity-filtered, and live-only (no archive).
const CIV_URL = "https://data.sensor.community/airrohr/v1/filter/" +
  `box=${OVERLAY.latMin},${OVERLAY.lonMin},${OVERLAY.latMax},${OVERLAY.lonMax}`;
const CIV_POLL_MS = 120_000; // their readings update ~every 2.5 minutes
const CIV_RESIDUAL_WT = 0.35;

const stations = new Map(); // id -> {id, name, lat, lon, marker, listEl, series: Map t->v, history: [{t,v}], latest}
let timeline = [];    // sorted unique reading timestamps (ms) within the 24h window
let sliderTicks = []; // timeline thinned to SLIDER_STEP_MIN buckets
let displayedT = null; // null = live (latest reading)
let selectedId = null;
let map, overlayLayer, overlayCanvas, dayTiles, dayTilesOn = false;
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
    const res = await fetch(url);
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
    const res = await fetch(url);
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
    const res = await fetch(`${V1_URL}?date=${dateStr}`);
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
    const res = await fetch(url);
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
  const res = await fetch(CIV_URL);
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
  if (added) { rebuild(); renderAll(); }
}

// ---------- Open-Meteo model grid ----------

// One request fetches hourly 2m-temperature for the whole sample grid,
// covering yesterday through today (so the scrubber window is fully covered).
async function fetchModel() {
  const lats = [], lons = [];
  for (let iy = 0; iy < GRID_NLAT; iy++) {
    for (let ix = 0; ix < GRID_NLON; ix++) {
      lats.push((OVERLAY.latMin + (iy * (OVERLAY.latMax - OVERLAY.latMin)) / (GRID_NLAT - 1)).toFixed(4));
      lons.push((OVERLAY.lonMin + (ix * (OVERLAY.lonMax - OVERLAY.lonMin)) / (GRID_NLON - 1)).toFixed(4));
    }
  }
  const url = `${OM_URL}?latitude=${lats.join(",")}&longitude=${lons.join(",")}` +
    `&hourly=temperature_2m&past_days=1&forecast_days=1&timeformat=unixtime&timezone=UTC`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`open-meteo HTTP ${res.status}`);
  let results = await res.json();
  if (!Array.isArray(results)) results = [results];
  if (results.length !== lats.length) throw new Error("open-meteo result count mismatch");

  const times = results[0].hourly.time.map((s) => s * 1000);
  const grids = times.map((_, k) => {
    const g = new Float32Array(results.length);
    for (let i = 0; i < results.length; i++) {
      const v = results[i].hourly.temperature_2m[k];
      g[i] = v == null ? NaN : v;
    }
    return g;
  });
  model = { times, grids };
}

async function refreshModel() {
  try {
    await fetchModel();
    document.getElementById("shade-mode").textContent = "Open-Meteo model + station correction";
    scheduleRender();
  } catch {
    // keep whatever model we had; station-only IDW covers the gap
    if (!model) setTimeout(refreshModel, 3 * 60_000);
  }
}

// Model grid blended in time to the displayed moment.
function buildBlendedGrid(t) {
  if (!model) return null;
  const { times, grids } = model;
  let k = 0;
  while (k < times.length - 2 && times[k + 1] <= t) k++;
  const t0 = times[k], t1 = times[Math.min(k + 1, times.length - 1)];
  const f = t1 > t0 ? Math.min(1, Math.max(0, (t - t0) / (t1 - t0))) : 0;
  const a = grids[k], b = grids[Math.min(k + 1, grids.length - 1)];
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) {
    out[i] = Number.isNaN(a[i]) ? b[i] : Number.isNaN(b[i]) ? a[i] : a[i] + (b[i] - a[i]) * f;
  }
  return out;
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
  for (const info of result.stations) upsertStation(info);
  for (const item of result.items) {
    const t = new Date(item.timestamp).getTime();
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

  sliderTicks = [];
  let lastBucket = -1;
  for (const t of timeline) {
    const b = Math.floor(t / (SLIDER_STEP_MIN * 60_000));
    if (b !== lastBucket) { sliderTicks.push(t); lastBucket = b; }
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

function displayedValues(t, wobbleMs = null) {
  const out = new Map();
  if (t == null) return out;
  for (const s of stations.values()) {
    const v = valueAt(s, t);
    if (v != null) out.set(s.id, wobbleMs == null ? v : v + liveWobble(s.id, wobbleMs));
  }
  return out;
}

// Tiny per-station drift (±0.06°, ~20s periods, phase from the station id)
// shown only on the live view, so the last decimal ticks like a live feed.
const WOBBLE_AMP = 0.06;

function liveWobble(id, ms) {
  let p = 0;
  for (let i = 0; i < id.length; i++) p = (p * 31 + id.charCodeAt(i)) | 0;
  return WOBBLE_AMP * (0.6 * Math.sin(ms / 4700 + p) + 0.4 * Math.sin(ms / 1700 + p * 1.7));
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
// The ramps span two hours so the shift never feels like a switch, and the
// day layer is capped low (plus dimmed via CSS filter) so daytime reads as
// softly lit rather than bright — full brightness washed out the overlay.
const DAY_MAX_OPACITY = 0.45;

function smooth01(x) {
  x = Math.min(1, Math.max(0, x));
  return x * x * (3 - 2 * x);
}

function dayFactor(t) {
  const d = new Date(t + 8 * 3600_000); // SGT wall clock via UTC getters
  const h = d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600;
  return Math.min(smooth01((h - 6.0) / 2.0), 1 - smooth01((h - 18.2) / 2.0));
}

function renderMarker(s, v) {
  if (!s.marker) return;
  if (v == null) { s.marker.setIcon(L.divIcon({ className: "", html: "", iconSize: [0, 0] })); return; }
  let cls = "temp-pill";
  if (s.kind === "civ") cls += " civ";
  if (s.id === selectedId) cls += " selected";
  if (displayedT === null && s.kind !== "civ") cls += " live"; // gentle pulse on current readings
  s.marker.setIcon(L.divIcon({
    className: "",
    html: `<span class="${cls}" style="--pill:${tempColor(v)}">${fmt(v)}</span>`,
    iconSize: [0, 0],
  }));
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

function renderList(values) {
  const ul = document.getElementById("station-list");
  const sorted = [...stations.values()]
    .filter((s) => s.kind === "nea" && values.has(s.id))
    .sort((a, b) => values.get(b.id) - values.get(a.id));
  const civCount = [...stations.values()].filter((s) => s.kind === "civ" && values.has(s.id)).length;
  document.getElementById("station-count").textContent =
    civCount ? `(${sorted.length} + ${civCount} community)` : `(${sorted.length})`;

  for (const s of sorted) {
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
    ul.appendChild(s.listEl); // re-appending keeps the list in sorted order
  }
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
const OVERLAY_MAX_ALPHA = 0.55;

// Sub-linear curve: opacity arrives well before the extremes, so only a
// narrow band around the scale midpoint stays fully transparent.
function extremeness(val) {
  const f = Math.min(1, Math.max(0, (val - scaleLo) / (scaleHi - scaleLo || 1)));
  return Math.pow(Math.abs(f - 0.5) * 2, 0.75);
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
    slider.value = slider.max;
  } else {
    // keep the handle tracking the displayed time (it moves during playback)
    let lo = 0, hi = sliderTicks.length - 1, idx = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (sliderTicks[mid] <= displayedT) { idx = mid; lo = mid + 1; } else hi = mid - 1;
    }
    slider.value = idx;
  }
  label.textContent = t ? fmtTime(t) : "–";
  const f = dayFactor(t ?? Date.now());
  document.getElementById("sky-icon").textContent = f > 0.8 ? "☀️" : f < 0.2 ? "🌙" : "🌅";
  liveBtn.classList.toggle("active", displayedT === null);
}

function renderAll() {
  const t = displayedTime();
  const values = displayedValues(t);
  const grid = buildBlendedGrid(t ?? Date.now());
  updateScale(values, grid); // normalize colours before anything draws
  if (dayTiles) {
    const op = DAY_MAX_OPACITY * dayFactor(t ?? Date.now());
    if (op > 0.02) {
      if (!dayTilesOn) { dayTiles.addTo(map); dayTilesOn = true; }
      dayTiles.setOpacity(op);
    } else if (dayTilesOn) {
      dayTiles.remove();
      dayTilesOn = false;
    }
  }
  for (const s of stations.values()) renderMarker(s, values.get(s.id));
  renderList(values);
  renderSummary(values);
  renderDetail(values, t);
  renderOverlay(values, grid);
  renderTimebar(t);
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

// ---------- ambient decorations ----------

// Stylized waves bobbing on open water (coordinates chosen on sea, clear of land).
const WAVE_SPOTS = [
  [1.155, 103.62], [1.125, 103.78], [1.15, 103.95], [1.20, 104.10],
  [1.255, 103.55], [1.115, 104.16], [1.445, 103.715],
];
const WAVE_SVG = `<svg viewBox="0 0 28 10" width="26" height="9">
  <path d="M1 4 Q4.5 1 8 4 T15 4" fill="none" stroke="#9fd0ff" stroke-width="1.4" stroke-linecap="round"/>
  <path d="M13 8 Q16.5 5 20 8 T27 8" fill="none" stroke="#9fd0ff" stroke-width="1.4" stroke-linecap="round"/>
</svg>`;

function initDecor() {
  WAVE_SPOTS.forEach(([lat, lon], i) => {
    L.marker([lat, lon], {
      interactive: false,
      icon: L.divIcon({
        className: "",
        html: `<div class="wave-deco" style="animation-delay:-${(i * 0.9).toFixed(1)}s">${WAVE_SVG}</div>`,
        iconSize: [0, 0],
      }),
    }).addTo(map);
  });
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
  } catch (e) {
    showError(`Could not reach data.gov.sg (${e.message}). Retrying in a minute…`);
    setStatus("retrying…", true);
  }
}

// Bulk-load the 24h window: yesterday + today fetched in parallel, each
// rendered as soon as it lands so the scrubber becomes usable immediately.
async function loadHistory() {
  const now = Date.now();
  const days = [sgtDate(new Date(now)), sgtDate(new Date(now - 24 * 3600_000))];
  setStatus("loading 24h history…", true);
  await Promise.all(days.map((day) =>
    fetchDay(day)
      .then((r) => { ingest(r); rebuild(); renderAll(); })
      .catch(() => { /* a missing day just shortens the scrubber range */ })
  ));
  rebuild(now);
  renderAll();
  latestReadingT = timeline[timeline.length - 1] ?? null;
  statusPinned = false;
  tickStatus();
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
  // night base + day layer crossfaded by the sun at the displayed time;
  // the day layer is only attached while visible so it doesn't cost tile
  // downloads at night (or during initial load after dark)
  L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", tileOpts).addTo(map);
  dayTiles = L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
    { ...tileOpts, className: "day-tiles" });
}

document.getElementById("detail-close").addEventListener("click", () => selectStation(selectedId));

document.getElementById("time-slider").addEventListener("input", (e) => {
  const idx = Number(e.target.value);
  displayedT = idx >= sliderTicks.length - 1 ? null : sliderTicks[idx];
  scheduleRender();
});

document.getElementById("live-btn").addEventListener("click", () => {
  displayedT = null;
  renderAll();
});

initMap();
initDecor();
refresh().then(loadHistory).then(() => fetchCommunity().catch(() => {}));
refreshModel();
setInterval(refresh, POLL_MS);
setInterval(refreshModel, MODEL_REFRESH_MS);
setInterval(tickStatus, 1000);
setInterval(() => fetchCommunity().catch(() => {}), CIV_POLL_MS);
setInterval(renderLive, 2000); // live numbers drift slightly between polls
