// Smoke test: runs assets/app.js in Node with stubbed DOM/Leaflet/fetch and
// asserts the main data paths. Usage: node tests/smoke.js
// Any "Assertion failed" line or "SMOKE FAIL" in the output means a problem.
const fs = require("fs");
const path = require("path");

function makeEl() {
  const children = {};
  return {
    textContent: "", innerHTML: "", style: {}, value: "0", max: "0",
    width: 0, height: 0,
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {},
    setAttribute() {}, getAttribute() { return ""; },
    appendChild() {},
    querySelector(sel) { return (children[sel] ||= makeEl()); },
    getContext: () => ({
      createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
      putImageData() {},
    }),
    toDataURL: () => "data:image/png;base64,stub",
  };
}
const els = {};
global.document = {
  getElementById: (id) => (els[id] ||= makeEl()),
  createElement: () => makeEl(),
};
global.L = {
  map: () => ({
    setView() { return this; }, panTo() {}, on() {}, invalidateSize() {},
    fitBounds() { return this; }, getBoundsZoom: () => 11, setMinZoom() {},
    getSize: () => ({ x: 800, y: 600 }),
    container: { style: { setProperty(k, v) { this[k] = v; } } },
    getContainer() { return this.container; },
    panes: {},
    createPane(n) { return (this.panes[n] ??= { style: {}, appendChild() {} }); },
    getPane(n) { return this.panes[n]; },
  }),
  latLngBounds: () => ({ pad() { return this; } }),
  tileLayer: (url) => ({ url, addTo() { return this; }, on() {}, once(e, fn) { fn(); }, remove() {}, setUrl() {}, setOpacity(v) { this.opacity = v; } }),
  circle: () => ({ addTo() { return this; }, setRadius() {}, setStyle() {}, remove() {} }),
  divIcon: (o) => o,
  marker: () => ({ on() {}, addTo() { return this; }, setIcon() {}, bindTooltip() {}, remove() {} }),
  imageOverlay: () => ({ addTo() { return this; }, setUrl() {}, opacity: 1, setOpacity(v) { this.opacity = v; } }),
  svgOverlay: () => ({ addTo() { return this; }, opacity: 1, setOpacity(v) { this.opacity = v; } }),
};
const tileUrls = [];
{ const tl = global.L.tileLayer; global.L.tileLayer = (url, o) => { tileUrls.push(url); return tl(url, o); }; }
global.setInterval = () => {};
global.requestAnimationFrame = () => {}; // don't run the wind loop in tests

const STATIONS = [
  { id: "S109", name: "Ang Mo Kio", location: { latitude: 1.3764, longitude: 103.8492 } },
  { id: "S117", name: "Newton", location: { latitude: 1.3135, longitude: 103.8366 } },
  { id: "S24", name: "Changi", location: { latitude: 1.3678, longitude: 103.9826 } },
];
const MODEL_TEMP = 27.0;

function dayItems(dateStr) {
  const items = [];
  for (let m = 0; m < 1440; m++) {
    const hh = String(Math.floor(m / 60)).padStart(2, "0");
    const mm = String(m % 60).padStart(2, "0");
    // slow sine + alternating ±0.3 jitter, to exercise the smoothing
    const base = 26 + 5 * Math.sin((m / 1440) * Math.PI) + (m % 2 ? 0.3 : -0.3);
    items.push({ timestamp: `${dateStr}T${hh}:${mm}:00+08:00`,
      readings: STATIONS.map((s, i) => ({ station_id: s.id, value: base + i })) });
  }
  return items;
}

global.fetch = async (url) => {
  if (typeof url === "string" && url.startsWith("data/model.json")) {
    return { ok: false, status: 404 }; // force the direct Open-Meteo path
  }
  const u = new URL(url);
  const ok = (body) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => body });
  if (u.host === "data.sensor.community") {
    const mk = (sid, temp, agoMs, vt = "temperature") => ({
      timestamp: new Date(Date.now() - agoMs).toISOString().slice(0, 19).replace("T", " "),
      location: { latitude: "1.3200", longitude: "103.8500" },
      sensor: { id: sid }, sensordatavalues: [{ value_type: vt, value: String(temp) }],
    });
    return ok([mk(777, 29.5, 60_000), mk(888, 39.0, 60_000), mk(999, 55, 60_000, "humidity")]);
  }
  if (u.host === "api.rainviewer.com" || u.host === "api.librewxr.net") {
    const now = Math.floor(Date.now() / 1000);
    return ok({ host: "https://tilecache.rainviewer.com",
      radar: { past: [{ time: now - 600, path: "/v2/radar/a" }, { time: now, path: "/v2/radar/b" }] } });
  }
  if (u.pathname.includes("rainfall")) {
    return ok({
      metadata: { stations: [
        { id: "R1", location: { latitude: 1.3764, longitude: 103.8492 } },
        { id: "R2", location: { latitude: 1.3135, longitude: 103.8366 } },
      ] },
      items: [{ timestamp: new Date().toISOString(),
        readings: [{ station_id: "R1", value: 5 }, { station_id: "R2", value: 0 }] }],
    });
  }
  if (u.pathname.includes("wind-speed") || u.pathname.includes("wind-direction")) {
    const spd = u.pathname.includes("wind-speed");
    return ok({ metadata: { stations: STATIONS },
      items: [{ timestamp: new Date().toISOString(),
        readings: STATIONS.map((s) => ({ station_id: s.id, value: spd ? 10 : 90 })) }] });
  }
  if (u.host === "api.open-meteo.com") {
    const lats = u.searchParams.get("latitude").split(",");
    const start = Math.floor(Date.now() / 3600e3) * 3600 - 24 * 3600;
    const time = Array.from({ length: 72 }, (_, i) => start + i * 3600);
    return ok(lats.map(() => ({ hourly: {
      time,
      temperature_2m: time.map(() => MODEL_TEMP),
      wind_speed_10m: time.map(() => 10),
      wind_direction_10m: time.map(() => 90), // from the east
      precipitation: time.map(() => 2),
    } })));
  }
  const date = u.searchParams.get("date");
  if (date && date.length === 10) {
    // day archive; the v2 host is made to fail so the v1 path is exercised
    if (u.host !== "api.data.gov.sg") return { ok: false, status: 500, headers: { get: () => null } };
    return ok({ metadata: { stations: STATIONS }, items: dayItems(date) });
  }
  const ts = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 19) + "+08:00";
  if (u.host === "api.data.gov.sg") {
    return ok({ metadata: { stations: STATIONS },
      items: [{ timestamp: ts, readings: STATIONS.map((s, i) => ({ station_id: s.id, value: 29 + i })) }] });
  }
  return ok({ code: 0, data: {
    stations: STATIONS.map((s) => ({ id: s.id, name: s.name, location: s.location })),
    readings: [{ timestamp: ts, data: STATIONS.map((s, i) => ({ stationId: s.id, value: 29 + i })) }],
  } });
};

const src = fs.readFileSync(path.join(__dirname, "../assets/app.js"), "utf8");
const h = new Function(src + `
  ;return {
    run: async () => { await refresh(); await loadHistory(); await refreshModel(); },
    state: () => ({ stations, timeline, sliderTicks }),
    scrubTo: (i) => { displayedT = i === sliderLiveIdx ? null : sliderTicks[i]; renderAll(); return displayedValues(displayedTime()); },
    goLive: () => { displayedT = null; renderAll(); return displayedValues(displayedTime()); },
    liveIdx: () => sliderLiveIdx,
    futureView: () => isFutureView(),
    windVecAt, fetchWind, fetchRain, fetchRadar, fetchCommunity, extremeness, dayFactor,
    // entries fading out still exist for ~0.35 s; count what's shown
    rainCount: () => [...rainLayer.values()].filter((e) => e.show).length,
    fcRain: () => ({ icons: [...rainLayer].filter(([k, e]) => k.startsWith("fc-") && e.show).length, max: fcRainMax }),
    radarLayerCount: () => radarLayers.size,
    windGridOk: () => { ensureWindField(); return !!windGridU; },
    rainOutlookText, fcRainStrength,
    gaugeCount: () => rainLocs.size,
    loadingLeft: () => [...loadingItems.keys()].filter((k) => k !== "tiles"),
    // newest radar frame newer than the viewed future moment (radar and
    // temperature feeds update out of step): must render, not throw
    negativeLeadTest: () => {
      const now = Math.floor(Date.now() / 1000);
      for (const f of radarFrames) f.time += 1800;
      if (anvilCast) anvilCast.t0 += 1800;
      displayedT = (now + 15 * 60) * 1000;
      try {
        const ctx = rainContext(displayedT);
        const v = ctx.rate(rvLat(200), rvLon(330));
        renderAll(true);
        return { ok: Number.isFinite(v), future: isFutureView(), anvil: ctx.anvil };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    },
    // ANVIL: four frames 10 min apart, one cell intensifying, one fading,
    // both drifting east 1 px/min
    anvilTest: async () => {
      radarMode = "pixels";
      radarHost = "synthetic";
      const cells = (k) => [[300 + 10 * k, 200, 30 + 6 * k], [600 + 10 * k, 300, 48 - 6 * k]];
      const mk = (k) => {
        const g = new Uint8Array(RV_W * RV_H);
        for (const [cx, cy, dbz] of cells(k)) {
          for (let y = cy - 40; y <= cy + 40; y++) {
            for (let x = cx - 40; x <= cx + 40; x++) {
              const d = Math.hypot(x - cx, y - cy);
              if (d < 30) g[y * RV_W + x] = Math.round(dbz - 12 * (d / 30) ** 2) + 32;
            }
          }
        }
        return g;
      };
      const now = Math.floor(Date.now() / 1000);
      radarFrames = [0, 1, 2, 3].map((k) => ({ time: now - (3 - k) * 600, path: "q" + k }));
      radarGrids.clear();
      radarFrames.forEach((f, k) => radarGrids.set(f.path, mk(k)));
      radarMotion = null; anvilCast = null;
      updateMotion();
      await updateAnvil();
      displayedT = now * 1000 + 30 * 60_000;
      const ctx = rainContext(displayedT);
      const at = (x, y) => ctx.rate(rvLat(y), rvLon(x));
      const last = radarGrids.get("q3");
      return {
        anvil: ctx.anvil,
        growNow: RATE_LUT[last[200 * RV_W + 330]], growFc: at(360, 200),
        fadeNow: RATE_LUT[last[300 * RV_W + 630]], fadeFc: at(660, 300),
      };
    },
    // three synthetic radar frames: a round cell moving 1 px/min east
    nowcastTest: () => {
      radarMode = "pixels";
      radarHost = "synthetic";
      const mk = (cx, cy) => {
        const g = new Uint8Array(RV_W * RV_H);
        for (let y = cy - 40; y <= cy + 40; y++) {
          for (let x = cx - 40; x <= cx + 40; x++) if ((x - cx) ** 2 + (y - cy) ** 2 < 30 * 30) g[y * RV_W + x] = 32 + 40;
        }
        return g;
      };
      const now = Math.floor(Date.now() / 1000);
      radarFrames = [{ time: now - 1200, path: "p0" }, { time: now - 600, path: "p1" }, { time: now, path: "p2" }];
      radarGrids.clear();
      radarGrids.set("p0", mk(400, 270)); radarGrids.set("p1", mk(410, 270)); radarGrids.set("p2", mk(420, 270));
      radarMotion = null;
      updateMotion();
      const m = motionAt(420, 270);
      displayedT = now * 1000 + 30 * 60_000;
      const ctx = rainContext(displayedT);
      const at = (x) => ctx.rate(rvLat(270), rvLon(x));
      // halfway between the first two past frames: the cell glides to ~405
      displayedT = (now - 900) * 1000;
      const mid = rainContext(displayedT);
      const atm = (x) => mid.rate(rvLat(270), rvLon(x));
      return { vx: m.vx, vy: m.vy, kmh: radarMotion.kmh, src: ctx.src, ahead: at(465), behind: at(405),
        midPair: !!mid.pair, midCentre: atm(405), midWest: atm(372), midEast: atm(438) };
    },
  };`)();

(async () => {
  await h.run();
  const { stations, timeline, sliderTicks } = h.state();
  const nea = [...stations.values()].filter((s) => s.kind === "nea");
  console.assert(nea.length === 3, "3 NEA stations:", nea.length);
  console.assert(timeline.length > 1000, "24h history loaded:", timeline.length);
  console.assert(h.liveIdx() === 24 * 12, "LIVE tick at centre of 5-min lattice:", h.liveIdx());

  // smoothing kills the ±0.3 jitter
  const hist = stations.get("S109").history.slice(400, 500);
  const jump = Math.max(...hist.slice(1).map((p, i) => Math.abs(p.v - hist[i].v)));
  console.assert(jump < 0.1, "smoothed series:", jump);

  const live = h.goLive();
  console.assert([...live.keys()].filter((k) => !k.startsWith("civ-")).length === 3, "live NEA pills:", live.size);
  console.assert(h.extremeness(1e9) > 0.99, "extremes opaque");

  // wind: live from NEA stations (10 kn from E -> u ~ -18.5 km/h)
  await h.fetchWind();
  const w = h.windVecAt(1.35, 103.85);
  console.assert(w && Math.abs(w.u + 18.52) < 0.5, "live NEA wind:", w);

  // rain: one wet gauge -> one glyph at live
  await h.fetchRain();
  console.assert(h.rainCount() === 1, "one wet gauge rendered:", h.rainCount());

  // radar: frame layers created
  await h.fetchRadar();
  console.assert(h.radarLayerCount() >= 1, "radar frame layers:", h.radarLayerCount());

  // community: 1 kept, outlier and non-temperature dropped
  await h.fetchCommunity();
  console.assert(stations.has("civ-777") && !stations.has("civ-888") && !stations.has("civ-999"),
    "community filtering");

  // forecast half: model temp, model wind, model precipitation field
  console.assert(sliderTicks.length > h.liveIdx() + 100, "forecast ticks:", sliderTicks.length);
  const fut = h.scrubTo(sliderTicks.length - 1);
  console.assert(h.futureView(), "future view");
  for (const v of fut.values()) console.assert(Math.abs(v - MODEL_TEMP) < 3, "forecast temp:", v);
  const fw = h.windVecAt(1.35, 103.85);
  console.assert(fw && Math.abs(fw.u + 10) < 0.5, "future wind from model:", fw);
  // particles need a grid far into the future too (it used to go empty past
  // +90 min, freezing the animation on its last frame)
  console.assert(h.windGridOk(), "forecast wind grid exists at +24h");
  // forecast glyphs sit at the gauge positions the rain field reaches
  // (Node can't decode radar tiles, so this is the tile fallback: model
  // rain from the first future tick, 2 mm/h everywhere)
  const fr = h.fcRain();
  console.assert(fr.icons === h.gaugeCount() && Math.abs(fr.max - 2) < 0.01, "forecast gauge glyphs:", fr, h.gaugeCount());
  console.assert(h.rainCount() === fr.icons, "only forecast glyphs in the future:", h.rainCount());
  h.goLive();
  console.assert(h.rainCount() === 1, "back to observed rain at live:", h.rainCount());
  console.assert(h.fcRain().icons === 0, "forecast rain hidden at live");

  // forecast glyphs must register at typical model rates (a 10km
  // cell averages a shower down to ~0.3-1 mm/h), and show in the outlook
  console.assert(h.fcRainStrength(0.3) > 0.3 && h.fcRainStrength(1) > 0.55, "model rain visibility");
  console.assert(/^model: showers now–/.test(h.rainOutlookText()), "rain outlook:", h.rainOutlookText());

  // nowcast: motion from block matching, then the cell carried downstream
  const nc = h.nowcastTest();
  console.assert(Math.abs(nc.vx - 1) < 0.15 && Math.abs(nc.vy) < 0.15, "nowcast motion ~1 px/min east:", nc);
  console.assert(Math.abs(nc.kmh - 36.7) < 5, "nowcast speed ~37 km/h:", nc.kmh);
  console.assert(nc.src === "nowcast" && nc.ahead > 3 && nc.behind === 0, "cell advected east at +30 min:", nc);
  // between past frames rain moves (motion-compensated), no double image
  console.assert(nc.midPair && nc.midCentre > 8 && nc.midWest === 0 && nc.midEast === 0,
    "past frames interpolated along the motion:", nc);
  h.goLive();

  // ANVIL: growth and decay carry on along the motion
  const an = await h.anvilTest();
  console.assert(an.anvil, "ANVIL nowcast built:", an);
  console.assert(an.growFc > an.growNow * 1.15, "intensifying cell keeps growing:", an);
  console.assert(an.fadeFc < an.fadeNow * 0.85, "fading cell keeps decaying:", an);
  console.assert(an.growFc <= 1.5 * 36.5 + 5 + 0.01, "growth capped at 1.5x the observed peak:", an);
  const nl = h.negativeLeadTest();
  console.assert(nl.ok && nl.future && nl.anvil, "radar newer than the viewed moment renders:", nl);
  h.goLive();

  console.assert(h.loadingLeft().length === 0, "nothing left marked as loading:", h.loadingLeft());

  // CARTO serves watermarked tiles (HTTP 200, no error) without a key
  const baseUrl = tileUrls.find((u) => u.includes("basemaps.cartocdn.com"));
  console.assert(baseUrl && /[?&]key=[^&]+/.test(baseUrl), "CARTO basemap URL carries the key:", baseUrl);

  // day/night: noon SGT bright, midnight SGT dark
  const base = Math.floor(Date.now() / 86400e3) * 86400e3; // 00:00 UTC = 08:00 SGT
  console.assert(h.dayFactor(base + 4 * 3600e3) === 1, "noon is day");
  console.assert(h.dayFactor(base + 16 * 3600e3) === 0, "midnight is night");

  console.log("smoke done");
})().catch((e) => { console.error("SMOKE FAIL:", e); process.exit(1); });
