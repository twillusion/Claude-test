/* SG Temp — live Singapore air temperature from data.gov.sg (NEA).
   No backend: the browser talks to the public API directly. The v2 API is
   primary; the v1 API is kept as a fallback since both are public and CORS-enabled. */

const V2_URL = "https://api-open.data.gov.sg/v2/real-time/api/air-temperature";
const V1_URL = "https://api.data.gov.sg/v1/environment/air-temperature";
const POLL_MS = 60_000;
const HISTORY_HOURS = 24;
const HISTORY_CONCURRENCY = 6;

const stations = new Map(); // id -> {id, name, lat, lon, marker, listEl, history: [{t, v}], latest}
let selectedId = null;
let lastUpdated = null;
let map;

// ---------- API ----------

// Returns SGT wall-clock "YYYY-MM-DDTHH:MM:SS" for a Date (API expects local SG time).
function sgtStamp(date) {
  return new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0, 19);
}

// Normalizes either API version to {timestamp: Date, stations: [...], readings: Map id->value}.
async function fetchReadings(atDate) {
  const errors = [];
  try {
    const url = atDate ? `${V2_URL}?date=${encodeURIComponent(sgtStamp(atDate))}` : V2_URL;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`v2 HTTP ${res.status}`);
    const json = await res.json();
    const d = json.data;
    const reading = d.readings[d.readings.length - 1];
    return {
      timestamp: new Date(reading.timestamp),
      stations: d.stations.map((s) => {
        const loc = s.location || s.labelLocation || {};
        return { id: s.id, name: s.name, lat: loc.latitude, lon: loc.longitude };
      }),
      readings: new Map(reading.data.map((r) => [r.stationId, r.value])),
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
      timestamp: new Date(item.timestamp),
      stations: json.metadata.stations.map((s) => ({
        id: s.id, name: s.name, lat: s.location.latitude, lon: s.location.longitude,
      })),
      readings: new Map(item.readings.map((r) => [r.station_id, r.value])),
    };
  } catch (e) {
    errors.push(e);
    throw new Error(errors.map(String).join("; "));
  }
}

// ---------- temperature colour scale (25°C cool blue -> 36°C hot red) ----------

function tempColor(v) {
  const t = Math.min(1, Math.max(0, (v - 25) / 11));
  const hue = 210 - 210 * t;
  return `hsl(${hue}, 85%, ${62 - 12 * t}%)`;
}

// ---------- rendering ----------

function fmt(v) {
  return v == null ? "–" : `${v.toFixed(1)}°`;
}

function upsertStation(info) {
  let s = stations.get(info.id);
  if (!s) {
    s = { ...info, history: [], latest: null, marker: null, listEl: null };
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

function renderMarker(s) {
  if (!s.marker || s.latest == null) return;
  const cls = s.id === selectedId ? "temp-pill selected" : "temp-pill";
  s.marker.setIcon(L.divIcon({
    className: "",
    html: `<span class="${cls}" style="--pill:${tempColor(s.latest)}">${fmt(s.latest)}</span>`,
    iconSize: [0, 0],
  }));
  s.marker.bindTooltip(s.name);
}

function sparkPoints(history, w, h, pad = 2) {
  if (history.length < 2) return null;
  const vs = history.map((p) => p.v);
  const lo = Math.min(...vs), hi = Math.max(...vs);
  const span = hi - lo || 1;
  const t0 = history[0].t, t1 = history[history.length - 1].t;
  const tSpan = t1 - t0 || 1;
  return history.map((p) => {
    const x = pad + ((p.t - t0) / tSpan) * (w - 2 * pad);
    const y = h - pad - ((p.v - lo) / span) * (h - 2 * pad);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
}

function renderList() {
  const ul = document.getElementById("station-list");
  const sorted = [...stations.values()]
    .filter((s) => s.latest != null)
    .sort((a, b) => b.latest - a.latest);
  document.getElementById("station-count").textContent = `(${sorted.length})`;

  for (const s of sorted) {
    if (!s.listEl) {
      s.listEl = document.createElement("li");
      s.listEl.innerHTML = `
        <span class="station-name"></span>
        <svg class="station-spark" viewBox="0 0 70 24" preserveAspectRatio="none"><polyline points=""/></svg>
        <span class="station-temp"></span>`;
      s.listEl.addEventListener("click", () => selectStation(s.id));
    }
    s.listEl.querySelector(".station-name").textContent = s.name;
    const temp = s.listEl.querySelector(".station-temp");
    temp.textContent = fmt(s.latest);
    temp.style.color = tempColor(s.latest);
    const line = s.listEl.querySelector("polyline");
    const pts = sparkPoints(s.history, 70, 24);
    if (pts) {
      line.setAttribute("points", pts);
      line.setAttribute("stroke", tempColor(s.latest));
    }
    s.listEl.classList.toggle("selected", s.id === selectedId);
    ul.appendChild(s.listEl); // re-appending keeps the list in sorted order
  }
}

function renderSummary() {
  const vals = [...stations.values()].map((s) => s.latest).filter((v) => v != null);
  const el = (id) => document.getElementById(id);
  if (!vals.length) return;
  el("stat-min").textContent = fmt(Math.min(...vals));
  el("stat-max").textContent = fmt(Math.max(...vals));
  el("stat-mean").textContent = fmt(vals.reduce((a, b) => a + b, 0) / vals.length);
}

function renderDetail() {
  const panel = document.getElementById("detail");
  const s = stations.get(selectedId);
  if (!s) { panel.classList.add("hidden"); return; }
  panel.classList.remove("hidden");
  document.getElementById("detail-name").textContent = s.name;
  document.getElementById("detail-temp").textContent = fmt(s.latest);
  document.getElementById("detail-temp").style.color = tempColor(s.latest ?? 30);
  document.getElementById("detail-when").textContent =
    lastUpdated ? `as of ${lastUpdated.toLocaleTimeString("en-SG", { timeZone: "Asia/Singapore" })} SGT` : "";

  const svg = document.getElementById("detail-spark");
  svg.innerHTML = "";
  const pts = sparkPoints(s.history, 320, 80, 6);
  if (pts) {
    const first = pts.split(" ")[0].split(",")[0];
    const last = pts.split(" ").at(-1).split(",")[0];
    svg.innerHTML =
      `<polygon class="spark-fill" points="${first},80 ${pts} ${last},80"/>` +
      `<polyline points="${pts}"/>`;
  }
  const vs = s.history.map((p) => p.v);
  document.getElementById("detail-low").textContent = vs.length ? fmt(Math.min(...vs)) : "–";
  document.getElementById("detail-high").textContent = vs.length ? fmt(Math.max(...vs)) : "–";
}

function selectStation(id) {
  const prev = stations.get(selectedId);
  selectedId = id === selectedId ? null : id;
  if (prev) renderMarker(prev);
  const s = stations.get(selectedId);
  if (s) {
    renderMarker(s);
    if (s.marker) map.panTo([s.lat, s.lon]);
  }
  renderDetail();
  renderList();
}

function renderAll() {
  for (const s of stations.values()) renderMarker(s);
  renderList();
  renderSummary();
  renderDetail();
}

function setStatus(text) {
  document.getElementById("refresh-status").textContent = text;
}

function showError(msg) {
  const b = document.getElementById("error-banner");
  if (!msg) { b.classList.add("hidden"); return; }
  b.textContent = msg;
  b.classList.remove("hidden");
}

// ---------- data flow ----------

function ingest(result) {
  for (const info of result.stations) upsertStation(info);
  const t = result.timestamp.getTime();
  for (const [id, value] of result.readings) {
    const s = stations.get(id);
    if (!s) continue;
    if (!s.history.some((p) => p.t === t)) {
      s.history.push({ t, v: value });
      s.history.sort((a, b) => a.t - b.t);
    }
  }
}

function pruneAndSetLatest(now) {
  const cutoff = now - HISTORY_HOURS * 3600_000;
  for (const s of stations.values()) {
    s.history = s.history.filter((p) => p.t >= cutoff);
    s.latest = s.history.length ? s.history[s.history.length - 1].v : null;
  }
}

async function refresh() {
  try {
    const result = await fetchReadings();
    ingest(result);
    lastUpdated = result.timestamp;
    pruneAndSetLatest(Date.now());
    renderAll();
    showError(null);
    setStatus(`updated ${result.timestamp.toLocaleTimeString("en-SG", { timeZone: "Asia/Singapore" })} SGT`);
  } catch (e) {
    showError(`Could not reach data.gov.sg (${e.message}). Retrying in a minute…`);
    setStatus("retrying…");
  }
}

// Backfill the 24h window with one sample per hour (sparkline resolution).
async function loadHistory() {
  const now = Date.now();
  const targets = [];
  for (let h = HISTORY_HOURS; h >= 1; h--) targets.push(new Date(now - h * 3600_000));

  let done = 0;
  const queue = [...targets];
  const worker = async () => {
    while (queue.length) {
      const t = queue.shift();
      try {
        ingest(await fetchReadings(t));
      } catch { /* a missing hour just leaves a gap in the sparkline */ }
      setStatus(`loading history ${++done}/${targets.length}`);
    }
  };
  await Promise.all(Array.from({ length: HISTORY_CONCURRENCY }, worker));
  pruneAndSetLatest(now);
  renderAll();
}

// ---------- init ----------

function initMap() {
  map = L.map("map", { zoomControl: true }).setView([1.3521, 103.8198], 12);
  L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
    maxZoom: 18,
  }).addTo(map);
}

document.getElementById("detail-close").addEventListener("click", () => selectStation(selectedId));

initMap();
refresh().then(loadHistory);
setInterval(refresh, POLL_MS);
