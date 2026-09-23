# SG Temp — context for Claude sessions

Live Singapore weather map: a single static page (no build step, no
backend) served by GitHub Pages at https://twillusion.github.io/Claude-test/.
The owner works mostly from the Claude Code **Android app** (cloud sessions)
and tests on desktop and phone browsers. The README describes features for
humans; this file is the working knowledge for continuing development.

## Files

- `index.html` — layout: header stats, map + legend + timebar (LIVE / WIND /
  RADAR buttons, time slider), collapsible station panel, footer status line.
- `assets/app.js` (~2.3k lines, plain JS, no modules) — everything.
- `assets/style.css` — dark theme; mobile breakpoint at 760px (end of file).
- `assets/vendor/leaflet/` — Leaflet 1.9.4, vendored on purpose (unpkg
  rate-limited the CSS once and broke the whole layout).
- `scripts/fetch-model.mjs` + `.github/workflows/model.yml` — GitHub Action
  (hourly at :37 — GitHub skips many scheduled runs, a 3h cron really ran
  every 5-7h; also manually runnable) that fetches the Open-Meteo forecast
  and commits `data/model.json`. Do not hand-edit `data/model.json`.
- `tests/smoke.js` — runs app.js in Node with stubbed DOM/Leaflet/fetch.

## Every change: the release routine

1. Develop on the designated `claude/...` branch. The model bot commits to
   `main` hourly, so **sync first**: `git fetch origin main && git merge
   origin/main` (the cloud clone is shallow — if git says "unrelated
   histories", run `git fetch --unshallow origin` first).
2. `node --check assets/app.js && node tests/smoke.js` — output must contain
   no `Assertion failed` / `SMOKE FAIL`. Update the smoke test when you
   change behaviour it covers.
3. **Bump the version in three places together** (format `YYYYMMDDx`):
   `APP_VERSION` in app.js and both `?v=` stamps in index.html, e.g.
   `sed -i 's/OLD/NEW/g' index.html assets/app.js`. Mismatched cached
   HTML/JS caused a very confusing "broken hybrid" page once; the stamps
   and the footer `v…` label exist to prevent and diagnose that.
4. Commit, push, then **open a PR to `main` and merge it yourself** via the
   GitHub MCP tools (`create_pull_request` + `merge_pull_request`, merge
   method "merge") — the owner prefers this over merging manually.
5. If the change touches the model pipeline, trigger the workflow:
   `actions_run_trigger` → `run_workflow`, `workflow_id: model.yml`, ref `main`.
6. Tell the owner the new version string; the footer shows it, so they can
   confirm the deploy (phones: fully close and reopen the tab).

Visual checks: Playwright + the pre-installed Chromium work in the sandbox.
For radar, generate scheme-0 PNG tiles in the harness (grey R=G=B =
dBZ+32, moving cells) and serve them with `access-control-allow-origin`;
note `route.fulfill` bypasses CORS, so simulate blocked pixels with
`route.abort()`.
Serve the repo locally and `page.route` every external host to mocks (the
smoke test's fixtures are a good start); screenshot desktop and a 390px
phone viewport, live and scrubbed into the forecast.

The sandbox **cannot reach** data.gov.sg, Open-Meteo, RainViewer, GitHub
Pages or githack (proxy allowlist). All API behaviour is verified via the
smoke test's mocks plus the owner's reports — ask them to read the footer.

## Data sources and their quirks (hard-won)

- **NEA via data.gov.sg** (temperature, wind speed/direction, rainfall).
  The "latest" snapshot of every feed can be **sparse** — sometimes one
  station. This caused three separate bugs. Rule: accumulate history and
  show each station's *last-known reading* on the live view (temp ≤2h;
  wind persists until replaced; rain uses a 30-min recency window). Day
  files (`?date=YYYY-MM-DD`) are multi-MB; they're loaded sequentially /
  deferred, and processed series are cached in localStorage
  (`sgtemp-hist-v2`, 15-min freshness; wind seeds from it up to 12h old).
  data.gov.sg rate-limits bursts (HTTP 429) — use the `fetch429` wrapper.
- **Open-Meteo** (hourly temperature, wind, precipitation on an 8×12 grid,
  past 1 day + 2 forecast days). It serves ECMWF IFS here: native cells
  ~0.07° (~8 km; the snapped lat/lon in each response show the grid), so
  8×12 (~0.067°) hits every cell — the old 6×9 skipped rows. **Blocked from the owner's browser**, so the
  page reads the same-origin `data/model.json` first, then a localStorage
  cache (`sgtemp-model-v3`), then a direct fetch. `fetch-model.mjs` writes
  the grid dimensions into the file (`grid: {nlat, nlon}`) and the page
  adopts them (`GRID_NLAT/NLON` are `let`); a file without `grid` is the
  legacy 6×9. `OVERLAY` must match in both files.
- **RainViewer** radar. Free tier since Jan 2026: ~2h of past frames only
  (**no nowcast frames**), zoom ≤ 7, possibly a single colour scheme, PNG.
  We fetch colour scheme 0 (dBZ in red: `(R & 127) − 32`) as two z7 512px
  tiles per frame (x 100–101, y 63: lon 101.25–106.9, lat 0–2.8, ~0.6 km
  px) and **decode the pixels** (`loadRadarGrid`). If the tiles come back
  in another palette, intensity is flagged "approx." in the footer. If
  pixels can't be read at all (CORS/network), `radarMode = "tiles"`: the
  old coloured tile layers, no nowcast, footer says why.
- **CARTO basemap** (`dark_all`): since Aug 2026 keyless requests get
  HTTP 200 tiles with "API KEY REQUIRED" burned in — no tileerror, so it
  fails silently. The owner's free key is in `CARTO_KEY` (app.js; public by
  design, free tier 5M tiles/month); the smoke test asserts the tile URL
  carries it, and the footer "basemap" item says when it's missing.
- **Sensor.Community**: wired in, but has no sensors in Singapore
  (footer: "community none in range").
- NASA GIBS Himawari IR was tried for clouds and abandoned (2km blocks,
  inverted polarity, never looked right). The owner prefers radar.

## How the page works (key mechanisms)

- **Time slider**: uniform 5-minute lattice −24h … +24h, LIVE at the centre
  (`sliderLiveIdx`, marked by a dotted green line on `.slider-wrap::after`).
  `displayedT === null` means live. `isFutureView()` switches pills to the
  model (bias-corrected by each station's current offset, dashed `.fc`
  pills, "≈" time label), wind to the model field (`buildModelWindGrid`,
  from the first future tick), rain to the model raster. Every view must
  yield a wind grid or an empty canvas — an empty grid once left the
  particle canvas frozen on its last frame past +90 min.
- **Temperature shading**: model grid + IDW station residuals, rasterized to
  a canvas image overlay; colour ramp normalized to on-screen min/max with a
  2°C minimum span; alpha is ~0 near the scale midpoint (transparent middle).
- **Wind particles**: canvas in its own Leaflet pane; particle tails stored
  as lat/lon and redrawn each frame; `zoomanim` hook keeps them fluid during
  zoom. Wind field precomputed onto a 24×16 grid (`buildWindGrid`); particle
  count scales with covered grid cells (so no "swarm" at low coverage).
- **Hybrid markers**: NEA stations reporting both temp and wind get a
  temperature-coloured "windsock" wedge on the pill.
- **Rain clouds** (`renderClouds`, pane `clouds`): one neutral grey-white
  raster aligned to the radar pixels, from `rainContext(t)`:
  past/live = the decoded radar frame; future = **our own nowcast** —
  block-matching the latest frame against the one ~20 min earlier
  (`blockMotion`/`motionField`, 4× downsampled) and advecting the latest
  frame along it (`nowcastRate`, semi-Lagrangian, e-folding 100 min),
  blended into the model from +45 min to +2h, then model only (bicubic,
  `gridSampleCubic`). It can't create new storms — that's the model's job.
  The owner wants to *see rain roll over the island*: this is the feature.
- **Rain glyphs**: 🌧️ at the real gauge positions, **no rain colour**
  (owner's rule: colour means temperature). Past/live = observed gauges
  (glyph + neutral grey ring). Future = gauges the cloud field reaches at
  ≥1 mm/h (`forecastGaugeRain`), dimmer, dashed ring. Rejected along the
  way: a marker per model node (lattice), pale-blue raster (read as
  "cool"), radar-palette raster (colour rule), sparse greedy glyphs
  ("didn't like it"). `rainOutlook()` marks model rain hours on the slider
  track (neutral grey) and in the footer. `?testrain` injects gauges.
- **Radar tiles (fallback only)**: one persistent preloaded Leaflet layer per
  frame; scrubbing only flips opacity (reloading tiles on scrub fades).
- **Mobile**: `invalidateSize()` after layout settles (else the map stays
  blank); the timebar wraps so the slider gets its own full-width row.
- **Day/night**: brightness filter on the dark tile pane via `--day-boost`.

## Owner's preferences

- Dislikes anything flashing, pulsing, or "goofy" (removed: pill glow pulse,
  gull, waves, travelling ripple, playback timelapse, cloud sprites).
- Wants honest data: forecast/estimates visibly marked, gaps shown as gaps.
- Dark map; subtle, low-opacity overlays; real-looking imagery.
- **Colour on the map means temperature, strictly.** Rain is grey-white
  cloud + glyphs, wind pins and list wind rows are neutral grey. (Only
  the tile fallback shows RainViewer's own palette.)
- Uses the site a lot on a phone — check the mobile layout for UI changes.
  The phone timebar's first row must fit the "≈ Wed 06:05 pm" forecast
  label, or the bar grows a row whenever you scrub into the future.
- Iterates via screenshots; give a short explanation of *why* something
  broke along with the fix.

## Open ideas (not started)

- Higher-res radar from NEA's own rain-area PNGs (weather.gov.sg, 5-min).
  Needs manual geo-registration (corner coordinates) calibrated against
  real storms with the owner — do it as its own careful task.
- Denser civilian temperature data (e.g. Netatmo) would need an
  authenticated fetch in the GitHub Action, not in the browser.
- Forecast horizon could go to +48h (data already fetched; `FORECAST_HOURS`).
