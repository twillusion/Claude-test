# SG Temp

A live temperature map of Singapore with a rolling 24-hour view — a single
static page, no backend, no hosting costs.

## How it works

- The page is plain HTML/CSS/JS served by **GitHub Pages**.
- Your browser fetches readings directly from the public
  [data.gov.sg real-time air temperature API](https://data.gov.sg) (NEA
  weather stations, updated every minute, no API key, CORS-enabled). The v2
  API is used first with automatic fallback to v1.
- Startup is sequenced for perceived speed: map and live readings first,
  then today's temperature archive, then yesterday's, then (deferred) the
  wind archive — one download at a time at full bandwidth. The processed
  24h series are cached in localStorage (a few hundred KB), so reloads
  within 15 minutes skip every archive download and restore instantly.
- Open-Meteo is queried as a ~10km grid (matching the model's native
  resolution) in small chunked requests, and the result is cached in
  localStorage for 30 minutes — reloads don't re-hit the API, which
  protects the free-tier rate limit. If the model fetch fails, the footer
  shows the error and shading falls back to station-only.
- On load, the page bulk-fetches the last 24 hours at per-minute resolution
  (the API returns a whole calendar day per request), then polls for the
  latest reading every minute. History older than 24 hours is dropped
  client-side — the API is the database, so nothing is stored in this repo.
- Colours are normalized to the temperatures currently on screen (the legend
  shows what the ramp endpoints mean at that moment), with a minimum 2°C
  span so sensor noise can't masquerade as contrast. The map is locked to
  the data window: panning is bounded and you can't zoom out past Singapore.
- The map shading (light blue = cool, orange = hot) blends two sources: a
  ~5 km grid of hourly 2m-temperature from the
  [Open-Meteo](https://open-meteo.com) forecast API (free, CC-BY, no key)
  as the smooth base field, corrected by the NEA station readings — where a
  real sensor disagrees with the model, the field is nudged to match it,
  with the correction decaying over ~12 km. If Open-Meteo is unreachable,
  it falls back to station-only IDW shading that fades out away from
  sensors. The model grid refreshes every 30 minutes (the models themselves
  update hourly) and covers the full 24h scrubber window.
- Forecast: the slider extends 24 hours past LIVE (5-minute steps that
  interpolate the hourly model). Future
  pills show the Open-Meteo model field at each station, bias-corrected by
  the station's current offset from the model, and render dashed with a
  "≈" time label to mark them as forecast; the shading, wind socks, and
  particles all follow the model into the future, and radar shows
  RainViewer's ~30-minute nowcast. The model is fetched primarily from
  `data/model.json`, committed every 3 hours by a GitHub Action
  (`scripts/fetch-model.mjs`) so the page reads it same-origin — run the
  "Refresh forecast model" workflow once manually after merging to seed it.
- The time slider runs from 24h ago to 24h ahead in 5-minute steps
  (`SLIDER_STEP_MIN` in `assets/app.js`), with LIVE at the centre marked by
  a dotted line; the LIVE button snaps back to the newest reading. Displayed series use a centered 15-minute rolling mean so
  per-minute sensor jitter doesn't flash colours while scrubbing, and the
  colour scale eases toward its target rather than jumping.
- The basemap follows the sun: daytime lifts the dark basemap's
  brightness by up to 40% (a CSS filter on the tile pane — no second tile
  set, no hue clash with the temperature ramp) through two-hour dawn/dusk
  ramps at the displayed time, with a sun/moon icon next to the clock.
- Wind particles (WIND button toggles them, remembered in localStorage):
  up to 400 particles (scaled to how much of the map has sensor coverage)
  advect along the wind field, each carrying its recent path as geographic
  points — the canvas redraws those tails every frame and follows Leaflet's
  zoom animation, so streaks stay glued to the land while panning and
  zooming. Live
  data comes from NEA's observed wind stations (data.gov.sg
  wind-speed/wind-direction). Per-station wind history is built from the
  day files at startup and appended by the per-minute polls, so the time
  scrubber replays observed wind — socks, pins, and the particle field all
  follow the displayed time, falling back to the Open-Meteo field only
  where history doesn't reach. The footer shows the island-average wind
  and the station count feeding it.
- On the live view each station's displayed value drifts by up to ±0.09°
  so the numbers tick like a real-time feed between the actual per-minute
  polls. Only the number displays refresh (no overlay re-rasterization),
  and it pauses when the tab is hidden.
- Rain: drawn as neutral grey-white cloud — colour on the map is reserved
  for temperature — with 🌧️ glyphs at NEA's ~60 rain gauges underneath.
  Past and live, the cloud is RainViewer's radar (decoded from its
  dBZ-encoded tiles, ~0.6 km pixels) and the glyphs are real 5-minute gauge
  readings (radar from LibreWXR's MET Malaysia composite, RainViewer as
  fallback). Further back than the ~2 h radar archive, the clouds are an
  estimate: the model's own rain for that time, corrected toward what the
  gauges measured, drawn lighter and labelled "estimated" in the footer. Into the future, the site runs its own nowcast: it measures
  how the rain is moving, then applies ANVIL (Pulkkinen et al. 2020, as in
  pySTEPS) — each spatial scale's recent growth or decay is extrapolated
  with an autoregressive model, locally, so cells keep intensifying or
  fading as they drift — blending into the Open-Meteo model from +45 min
  to +2 h; beyond that it's the model (ECMWF, ~8 km cells). Forecast glyphs appear at gauges the cloud
  reaches at ≥1 mm/h, dimmer and dashed-ringed. The footer shows the
  source, lead time and rain motion; model rain hours are marked on the
  slider track. If the browser can't read radar pixels, RainViewer's own
  coloured tiles are shown instead (no nowcast) and the footer says so.
  The RADAR button toggles the cloud layer.
- The wind field is precomputed onto a 24×16 grid once per change, so
  particles and rain sample it with one bilinear lookup per tick instead
  of per-particle IDW.
- Citizen sensors from [Sensor.Community](https://sensor.community) (open
  API, no key) appear as small pins with a modest temperature chip and
  sharpen the shading via reduced-weight residuals. They're sanity-filtered (range check, plus a
  ±4°C check against the NEA median to drop sun-baked balcony sensors),
  kept out of the headline stats and colour scale, and live-only — there's
  no archive, so readings accumulate client-side while the page is open.
- Overlay opacity scales with distance from the middle of the colour scale:
  near-average areas stay transparent so the basemap reads clearly, and
  only genuine hot/cold anomalies get painted.

## Setting it up

1. Make this repository **public** (GitHub Pages on private repos requires a
   paid plan).
2. In the repo: **Settings → Pages → Build and deployment**, set Source to
   **Deploy from a branch**, pick `main` and `/ (root)`, and save.
3. The site appears at `https://<username>.github.io/<repo>/` within a few
   minutes.

To preview locally instead: `python3 -m http.server` in the repo root, then
open <http://localhost:8000>. Run `node tests/smoke.js` to check the data
paths against mocked APIs. Development notes live in `CLAUDE.md`.

## Data attribution

Contains information from the National Environment Agency accessed via
[data.gov.sg](https://data.gov.sg), made available under the
[Singapore Open Data Licence](https://data.gov.sg/open-data-licence).
