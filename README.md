# SG Temp

A live temperature map of Singapore with a rolling 24-hour view — a single
static page, no backend, no hosting costs.

## How it works

- The page is plain HTML/CSS/JS served by **GitHub Pages**.
- Your browser fetches readings directly from the public
  [data.gov.sg real-time air temperature API](https://data.gov.sg) (NEA
  weather stations, updated every minute, no API key, CORS-enabled). The v2
  API is used first with automatic fallback to v1.
- On load, the page backfills the last 24 hours (one sample per hour) for the
  per-station sparklines, then polls for the latest reading every minute.
  History older than 24 hours is dropped client-side — the API is the
  database, so nothing is stored in this repo.

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
