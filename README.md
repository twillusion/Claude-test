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
  newest reading.

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
