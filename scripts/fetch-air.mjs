// Fetches the CAMS PM2.5 forecast (Copernicus, served by the Open-Meteo Air
// Quality API) around Singapore and saves it to data/air.json for the haze
// layer. Run by the same scheduled GitHub Action as fetch-model.mjs: the
// owner's browser can't reach Open-Meteo, so the page reads this file
// same-origin.
//
// CAMS global is ~0.4° (~45 km), coarser than our map window, so we sample a
// wider 0.2° lattice and keep each distinct model cell once (Open-Meteo
// reports the snapped cell coordinates); the page interpolates between cell
// centres. OVERLAY must match assets/app.js.
import { writeFileSync, mkdirSync } from "node:fs";

const OVERLAY = { latMin: 1.09, latMax: 1.56, lonMin: 103.48, lonMax: 104.22 };
const PAD = 0.4, STEP = 0.2, CHUNK = 21;

const lats = [], lons = [];
for (let lat = OVERLAY.latMin - PAD; lat <= OVERLAY.latMax + PAD + 1e-9; lat += STEP) {
  for (let lon = OVERLAY.lonMin - PAD; lon <= OVERLAY.lonMax + PAD + 1e-9; lon += STEP) {
    lats.push(lat.toFixed(3));
    lons.push(lon.toFixed(3));
  }
}

async function fetchRetry(url, attempts = 5) {
  let lastErr;
  for (let a = 1; a <= attempts; a++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      const wait = Math.min(30_000, 2000 * 2 ** (a - 1));
      console.warn(`attempt ${a}/${attempts} failed (${e.message}); retrying in ${wait / 1000}s`);
      if (a < attempts) await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw new Error(`all ${attempts} attempts failed: ${lastErr?.message}`);
}

const results = [];
for (let i = 0; i < lats.length; i += CHUNK) {
  const url = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lats.slice(i, i + CHUNK).join(",")}` +
    `&longitude=${lons.slice(i, i + CHUNK).join(",")}` +
    `&hourly=pm2_5&domains=cams_global&past_days=1&forecast_days=3&timeformat=unixtime&timezone=UTC`;
  const j = await fetchRetry(url);
  results.push(...(Array.isArray(j) ? j : [j]));
  await new Promise((r) => setTimeout(r, 1500));
}
if (results.length !== lats.length) throw new Error(`result count mismatch (${results.length}/${lats.length})`);

const times = results[0].hourly.time;
const cells = new Map();
for (const r of results) {
  if (r.hourly.time.length !== times.length) throw new Error("inconsistent time axes");
  const key = `${r.latitude.toFixed(3)},${r.longitude.toFixed(3)}`;
  if (!cells.has(key)) cells.set(key, { lat: r.latitude, lon: r.longitude, pm2_5: r.hourly.pm2_5 });
}
const out = [...cells.values()];
const valid = out.reduce((n, c) => n + c.pm2_5.filter((v) => v != null).length, 0);
if (!valid) throw new Error("no PM2.5 values in the response");

mkdirSync("data", { recursive: true });
writeFileSync("data/air.json", JSON.stringify({
  generated: Date.now(), source: "CAMS global via Open-Meteo", times, cells: out,
}));
console.log(`wrote data/air.json: ${out.length} distinct CAMS cells (from ${results.length} samples), ${times.length} hours`);
