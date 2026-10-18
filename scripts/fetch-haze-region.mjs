// Fetches the CAMS PM2.5 forecast (Copernicus, via the Open-Meteo Air
// Quality API) for the whole haze region — Sumatra, the Malay Peninsula's
// south, Singapore, West Kalimantan — into data/haze-region.json for the
// page's regional haze view. Same Action as fetch-model.mjs.
//
// Points sit exactly on CAMS's native 0.4° cell centres (multiples of 0.4°),
// so every request hits a distinct cell. ~880 locations per run; CAMS only
// updates every 12 h, so a run is skipped while the file is younger than
// 5.5 h — that keeps the repo inside Open-Meteo's free daily call budget
// alongside the hourly weather/air fetches.
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";

const REGION = { lat0: -4.0, lon0: 97.6, step: 0.4, nlat: 26, nlon: 34 }; // to 6.0°N, 110.8°E
const OUT = "data/haze-region.json", CHUNK = 50, MIN_AGE_H = 5.5;
const KEEP = { pastH: 30, aheadH: 40 }; // the slider spans -24 h … +24 h

try {
  const old = JSON.parse(readFileSync(OUT, "utf8"));
  const age = (Date.now() - old.generated) / 3600_000;
  if (age < MIN_AGE_H && !process.env.FORCE) {
    console.log(`${OUT} is ${age.toFixed(1)} h old: fresh enough (CAMS updates every 12 h), skipping`);
    process.exit(0);
  }
} catch { /* no file yet */ }

const lats = [], lons = [];
for (let iy = 0; iy < REGION.nlat; iy++) {
  for (let ix = 0; ix < REGION.nlon; ix++) {
    lats.push((REGION.lat0 + iy * REGION.step).toFixed(1));
    lons.push((REGION.lon0 + ix * REGION.step).toFixed(1));
  }
}

async function fetchRetry(url, attempts = 5) {
  let lastErr;
  for (let a = 1; a <= attempts; a++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(45_000) });
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
    `&hourly=pm2_5&domains=cams_global&past_days=2&forecast_days=3&timeformat=unixtime&timezone=UTC`;
  const j = await fetchRetry(url);
  results.push(...(Array.isArray(j) ? j : [j]));
  await new Promise((r) => setTimeout(r, 1500));
}
if (results.length !== lats.length) throw new Error(`result count mismatch (${results.length}/${lats.length})`);

const allTimes = results[0].hourly.time;
const now = Date.now() / 1000;
const keep = allTimes.map((t, k) => [t, k]).filter(([t]) => t >= now - KEEP.pastH * 3600 && t <= now + KEEP.aheadH * 3600);
if (keep.length < 24) throw new Error(`only ${keep.length} hours in range`);
let valid = 0;
const pm = keep.map(([, k]) => results.map((r) => {
  const v = r.hourly.pm2_5?.[k];
  if (v == null) return -1; // gap: the page draws nothing there
  valid++;
  return Math.round(v);
}));
if (!valid) throw new Error("no PM2.5 values in the response");

mkdirSync("data", { recursive: true });
writeFileSync(OUT, JSON.stringify({
  generated: Date.now(), source: "CAMS global via Open-Meteo", grid: REGION,
  times: keep.map(([t]) => t), pm,
}));
console.log(`wrote ${OUT}: ${REGION.nlat}x${REGION.nlon} cells, ${keep.length} hours, ${valid} values`);
