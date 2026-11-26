# Aether Weather

Premium weather dashboard built on the existing Django app. Live data comes from
OpenWeatherMap, with RainViewer radar and NOAA alerts for US locations.

## Setup

1. Install dependencies:

   ```bash
   .venv\Scripts\python.exe -m pip install -r requirements.txt
   ```

2. Copy `.env.example` to `.env` and set your keys:

   ```bash
   copy .env.example .env
   ```

   - `WEATHER_API_KEY` — OpenWeatherMap API key (required).
   - `DJANGO_SECRET_KEY` — long random Django secret (required).
   - `WEATHER_ONECALL_KEY` — optional, only for paid One Call access.

   The `.env` file is gitignored. Secrets are read on the server and are never
   exposed to the browser.

3. Apply migrations and run the server:

   ```bash
   .venv\Scripts\python.exe manage.py migrate
   .venv\Scripts\python.exe manage.py runserver
   ```

Open `http://127.0.0.1:8000/`.

## Notes

- The current OpenWeatherMap plan provides a rolling 5-day forecast in 3-hour
  steps. The UI shows the real forecast depth and never invents longer-range data.
- Radar frames are real RainViewer observations; satellite overlays are proxied
  through Django so the API key stays private.
- Official severe alerts are shown only where NOAA coverage exists. Other regions
  get an explicit unavailable message.
- Location is opt-in. Nothing is detected on page load, and no weather request
  is made until the visitor clicks **Enable Location** or explicitly searches
  for a city.
- The Enable Location button uses only the browser Geolocation API. The returned
  latitude and longitude are sent to the existing weather API; there is no
  IP-based geolocation and no server-side location fallback.
- If permission is denied or coordinates are unavailable, the app explains how
  to change the site's Location permission in browser settings and leaves city
  search available.
- Each browser profile owns its selected city, theme, and saved cities in
  namespaced `localStorage` keys. Light mode is the default; the theme toggle
  switches to dark mode and back. None of these choices are written to SQLite or
  the shared preferences row.
- Saved cities are added, de-duplicated, removed, and restored entirely in the
  browser, so they survive refreshes and browser restarts without leaking between
  visitors. Units and other non-location settings persist in SQLite. Notification
  rules stay on the device.
