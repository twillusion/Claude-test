# SG Temp

A live temperature map of Singapore with a rolling 24-hour view — a single
static page, no backend, no hosting costs.

## How it works

- The page is plain HTML/CSS/JS served by **GitHub Pages**.
- Your browser fetches readings directly from the public
  [data.gov.sg real-time air temperature API](https://data.gov.sg) (NEA
  weather stations, updated every minute, no API key, CORS-enabled). The v2
  API is used first with automatic fallback to v1.
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
- The time slider scrubs the 24-hour window in 5-minute steps
  (`SLIDER_STEP_MIN` in `assets/app.js`); the LIVE button snaps back to the
  newest reading. Displayed series use a centered 15-minute rolling mean so
  per-minute sensor jitter doesn't flash colours while scrubbing, and the
  colour scale eases toward its target rather than jumping.
- The basemap follows the sun: daytime lifts the dark basemap's
  brightness by up to 40% (a CSS filter on the tile pane — no second tile
  set, no hue clash with the temperature ramp) through two-hour dawn/dusk
  ramps at the displayed time, with a sun/moon icon next to the clock.
- Wind streaklines: ~170 particles advected by the Open-Meteo wind field
  (fetched in the same request as temperature) drift across the map with
  fading trails, and follow the time scrubber. Particles live in
  geographic space and re-project each frame, so pan/zoom stay correct.
- On the live view each station's displayed value drifts by up to ±0.09°
  so the numbers tick like a real-time feed between the actual per-minute
  polls. Only the number displays refresh (no overlay re-rasterization),
  and it pauses when the tab is hidden.
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
open <http://localhost:8000>.

## Data attribution

Contains information from the National Environment Agency accessed via
[data.gov.sg](https://data.gov.sg), made available under the
[Singapore Open Data Licence](https://data.gov.sg/open-data-licence).
