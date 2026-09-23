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
  (every 3h, also manually runnable) that fetches the Open-Meteo forecast
  and commits `data/model.json`. Do not hand-edit `data/model.json`.
- `tests/smoke.js` — runs app.js in Node with stubbed DOM/Leaflet/fetch.

## Every change: the release routine

1. Develop on the designated `claude/...` branch. The model bot commits to
   `main` every 3h, so **sync first**: `git fetch origin main && git merge
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
- **Open-Meteo** (hourly temperature, wind, precipitation on a 6×9 grid,
  past 1 day + 2 forecast days). **Blocked from the owner's browser**, so the
  page reads the same-origin `data/model.json` first, then a localStorage
  cache (`sgtemp-model-v2`), then a direct fetch. Grid constants in
  `fetch-model.mjs` must match `OVERLAY`/`GRID_NLAT`/`GRID_NLON` in app.js.
- **RainViewer** radar composite (smoothed NEXRAD palette, scheme 6). Free
  tier: URL zoom capped at 7 (beyond → a literal "Zoom Level Not Supported"
  tile); we use 512px tiles + `zoomOffset -1`. ~2h past frames + ~30min
  nowcast. Its satellite product is retired ("no frames").
- **CARTO basemap** (`dark_all`): since Aug 2026 keyless requests get
  HTTP 200 tiles with "API KEY REQUIRED" burned in — no tileerror, so it
  fails silently. Key goes in `CARTO_KEY` (app.js, public by design; free
  at carto.com/basemaps/apikey). Footer "basemap" item says when it's missing.
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
- **Rain**: glyph + intensity-coloured circle per wet gauge (24h series,
  scrubbable); future = one bicubic-interpolated model-precipitation raster
  (`renderForecastRain`, CSS-striped `.rain-forecast`), suppressed while a
  radar nowcast frame covers the time. Never go back to a marker per grid
  node: widespread-rain hours wet 40-54 of the 54 nodes and the map turns
  into a lattice of circles. `?testrain` URL param injects
  synthetic gauges for visual testing.
- **Radar**: one persistent preloaded Leaflet layer per frame; scrubbing only
  flips opacity (anything that reloads tiles on scrub causes visible fading).
- **Mobile**: `invalidateSize()` after layout settles (else the map stays
  blank); the timebar wraps so the slider gets its own full-width row.
- **Day/night**: brightness filter on the dark tile pane via `--day-boost`.

## Owner's preferences

- Dislikes anything flashing, pulsing, or "goofy" (removed: pill glow pulse,
  gull, waves, travelling ripple, playback timelapse, cloud sprites).
- Wants honest data: forecast/estimates visibly marked, gaps shown as gaps.
- Dark map; subtle, low-opacity overlays; real-looking imagery.
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
