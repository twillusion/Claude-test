// Fetches the Open-Meteo forecast for the same grid the page uses and saves
// the raw responses to data/model.json. Run by the scheduled GitHub Action,
// so the page can read the model same-origin even when browsers can't reach
// Open-Meteo directly. Keep the grid constants in sync with assets/app.js.
import { writeFileSync, mkdirSync } from "node:fs";

const OVERLAY = { latMin: 1.09, latMax: 1.56, lonMin: 103.48, lonMax: 104.22 };
const NLAT = 6, NLON = 9, CHUNK = 27;

const lats = [], lons = [];
for (let iy = 0; iy < NLAT; iy++) {
  for (let ix = 0; ix < NLON; ix++) {
    lats.push((OVERLAY.latMin + (iy * (OVERLAY.latMax - OVERLAY.latMin)) / (NLAT - 1)).toFixed(4));
    lons.push((OVERLAY.lonMin + (ix * (OVERLAY.lonMax - OVERLAY.lonMin)) / (NLON - 1)).toFixed(4));
  }
}

// Fetch with retries + a generous per-attempt timeout, so a transient
// runner↔Open-Meteo hiccup (a connect timeout on one chunk) doesn't fail the
// whole refresh and email an error. Only gives up after several attempts.
async function fetchRetry(url, attempts = 5) {
  let lastErr;
  for (let a = 1; a <= attempts; a++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      const wait = Math.min(30_000, 2000 * 2 ** (a - 1)); // 2s,4s,8s,16s,30s
      console.warn(`attempt ${a}/${attempts} failed (${e.message}); retrying in ${wait / 1000}s`);
      if (a < attempts) await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw new Error(`all ${attempts} attempts failed: ${lastErr?.message}`);
}

const results = [];
for (let i = 0; i < lats.length; i += CHUNK) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lats.slice(i, i + CHUNK).join(",")}` +
    `&longitude=${lons.slice(i, i + CHUNK).join(",")}` +
    `&hourly=temperature_2m,wind_speed_10m,wind_direction_10m,precipitation` +
    `&past_days=1&forecast_days=2&timeformat=unixtime&timezone=UTC`;
  const j = await fetchRetry(url);
  results.push(...(Array.isArray(j) ? j : [j]));
  await new Promise((r) => setTimeout(r, 1500)); // be polite to the free tier
}

if (results.length !== lats.length) throw new Error("result count mismatch");
mkdirSync("data", { recursive: true });
writeFileSync("data/model.json", JSON.stringify({ generated: Date.now(), results }));
console.log(`wrote data/model.json: ${results.length} grid points, ${results[0].hourly.time.length} hours`);
