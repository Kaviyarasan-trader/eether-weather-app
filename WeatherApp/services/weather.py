"""OpenWeatherMap data access layer.

Every value returned to the UI originates from a live API response or from an
explicitly-labelled mathematical derivation.  Nothing is invented here.
"""
from __future__ import annotations

import datetime as dt
import math
import threading
from collections import Counter
from concurrent.futures import ThreadPoolExecutor

import requests
from django.conf import settings
from django.core.cache import cache
from requests.adapters import HTTPAdapter

from .astronomy import solar_and_lunar

API_BASE = getattr(settings, "WEATHER_API_BASE", "https://api.openweathermap.org").rstrip("/")
TILE_BASE = getattr(settings, "WEATHER_TILE_BASE", "https://tile.openweathermap.org").rstrip("/")
API_KEY = getattr(settings, "WEATHER_API_KEY", "")
ONECALL_KEY = getattr(settings, "WEATHER_ONECALL_KEY", "")
TIMEOUT = 8

# Reuse HTTP connections across requests instead of opening a new TCP/TLS
# connection for every upstream feed. A thread-local session keeps concurrent
# dashboard fetches safe while still benefiting from connection pooling.
_thread_state = threading.local()
_FEED_EXECUTOR = ThreadPoolExecutor(max_workers=8, thread_name_prefix="weather-feed")


def _session():
    session = getattr(_thread_state, "session", None)
    if session is None:
        session = requests.Session()
        adapter = HTTPAdapter(pool_connections=16, pool_maxsize=16)
        session.mount("https://", adapter)
        session.mount("http://", adapter)
        _thread_state.session = session
    return session

AQI_LABELS = {
    1: ("Good", "#4ade80", "Air quality is satisfactory with little risk."),
    2: ("Fair", "#a3e635", "Acceptable; unusually sensitive people may be affected."),
    3: ("Moderate", "#fbbf24", "Sensitive groups should consider reducing prolonged outdoor activity."),
    4: ("Poor", "#fb923c", "Everyone may begin to experience health effects."),
    5: ("Very Poor", "#f87171", "Health alert: the risk of effects is increased for everyone."),
}

WIND_DIRS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
             "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"]


class WeatherUnavailable(Exception):
    """Raised when a required upstream call fails."""


def _request(path, params=None, cache_key=None, cache_timeout=600, base=None,
             headers=None, api_key="__default__"):
    """GET a JSON payload with short-term caching and stale-on-error recovery."""
    stale_key = cache_key + ":stale" if cache_key else None
    if cache_key:
        hit = cache.get(cache_key)
        if hit is not None:
            return hit
    url = (base or API_BASE) + path
    query = dict(params or {})
    key = API_KEY if api_key == "__default__" else api_key
    if key and (base is None or base == API_BASE):
        query.setdefault("appid", key)
    try:
        response = _session().get(url, params=query, timeout=TIMEOUT, headers=headers)
        response.raise_for_status()
        payload = response.json()
    except (requests.RequestException, ValueError) as exc:
        if stale_key:
            return cache.get(stale_key)
        raise WeatherUnavailable(str(exc)) from exc

    cod = payload.get("cod") if isinstance(payload, dict) else None
    if cod is not None and str(cod) not in ("200", "None"):
        if stale_key:
            return cache.get(stale_key)
        raise WeatherUnavailable(str(payload.get("message", "Upstream error")))
    if cache_key:
        cache.set(cache_key, payload, cache_timeout)
        cache.set(stale_key, payload, 86400)
    return payload


def _ok(payload):
    return payload is not None


def wind_direction(degrees):
    if degrees is None:
        return None
    return WIND_DIRS[int((float(degrees) + 11.25) % 360 // 22.5)]


def dew_point(temp_c, humidity):
    """Magnus formula — a standard derivation from temperature + humidity."""
    if temp_c is None or humidity is None:
        return None
    a, b = 17.62, 243.12
    gamma = math.log(max(humidity, 1) / 100.0) + a * temp_c / (b + temp_c)
    return round(b * gamma / (a - gamma), 1)


def _local(epoch, offset):
    if epoch is None:
        return None
    return dt.datetime.fromtimestamp(epoch + (offset or 0), dt.timezone.utc)


def _iso(epoch, offset):
    value = _local(epoch, offset)
    return value.isoformat() if value else None


def _hour_label(epoch, offset, hour12=True):
    value = _local(epoch, offset)
    if not value:
        return ""
    if hour12:
        h = value.hour % 12 or 12
        return f"{h} {'AM' if value.hour < 12 else 'PM'}"
    return value.strftime("%H:%M")


# ---------------------------------------------------------------------------
# Location resolution
# ---------------------------------------------------------------------------
def resolve_location(city=None, lat=None, lon=None):
    """Return a normalised location dict or ``None`` when nothing matches."""
    if lat is not None and lon is not None:
        try:
            reverse = _request(
                "/geo/1.0/reverse",
                {"lat": lat, "lon": lon, "limit": 1},
                cache_key=f"owm:rev:{lat:.3f}:{lon:.3f}",
                cache_timeout=86400,
            )
        except WeatherUnavailable:
            reverse = None
        item = (reverse or [{}])[0] if reverse else {}
        return {
            "name": item.get("name") or "Current location",
            "country": item.get("country", ""),
            "state": item.get("state", ""),
            "lat": float(lat),
            "lon": float(lon),
            "query": item.get("name") or city or "Current location",
        }

    if not city:
        return None
    city = str(city).strip()
    geo = _request(
        "/geo/1.0/direct",
        {"q": city, "limit": 1},
        cache_key=f"owm:geo:{city.lower()}",
        cache_timeout=86400,
    )
    if geo:
        item = geo[0]
        return {
            "name": item.get("name", city),
            "country": item.get("country", ""),
            "state": item.get("state", ""),
            "lat": float(item["lat"]),
            "lon": float(item["lon"]),
            "query": city,
        }

    # Fallback for cities the geocoder does not know: query weather by name.
    try:
        current = _request("/data/2.5/weather", {"q": city, "units": "metric"})
    except WeatherUnavailable:
        return None
    if not _ok(current):
        return None
    coords = current.get("coord", {})
    return {
        "name": current.get("name", city),
        "country": current.get("sys", {}).get("country", ""),
        "state": "",
        "lat": float(coords.get("lat", 0)),
        "lon": float(coords.get("lon", 0)),
        "query": city,
    }


def search_cities(query, limit=6):
    if not query or len(query.strip()) < 2:
        return []
    geo = _request(
        "/geo/1.0/direct",
        {"q": query.strip(), "limit": limit},
        cache_key=f"owm:search:{query.strip().lower()}:{limit}",
        cache_timeout=86400,
    )
    if not geo:
        return []
    return [
        {
            "name": item.get("name", ""),
            "country": item.get("country", ""),
            "state": item.get("state", ""),
            "lat": item.get("lat"),
            "lon": item.get("lon"),
        }
        for item in geo
        if item.get("lat") is not None and item.get("lon") is not None
    ]


# ---------------------------------------------------------------------------
# Core data
# ---------------------------------------------------------------------------
def get_current(lat, lon):
    return _request(
        "/data/2.5/weather",
        {"lat": lat, "lon": lon, "units": "metric"},
        cache_key=f"owm:current:{lat:.3f}:{lon:.3f}",
        cache_timeout=300,
    )


def get_forecast(lat, lon):
    return _request(
        "/data/2.5/forecast",
        {"lat": lat, "lon": lon, "units": "metric"},
        cache_key=f"owm:forecast:{lat:.3f}:{lon:.3f}",
        cache_timeout=900,
    )


def get_air(lat, lon):
    payload = _request(
        "/data/2.5/air_pollution",
        {"lat": lat, "lon": lon},
        cache_key=f"owm:air:{lat:.3f}:{lon:.3f}",
        cache_timeout=900,
    )
    if not _ok(payload) or not payload.get("list"):
        return None
    entry = payload["list"][0]
    aqi = entry.get("main", {}).get("aqi")
    label, color, advice = AQI_LABELS.get(aqi, ("Unknown", "#94a3b8", "Air quality data is provisional."))
    return {
        "aqi": aqi,
        "label": label,
        "color": color,
        "advice": advice,
        "components": entry.get("components", {}),
        "dt": entry.get("dt"),
        "units": "µg/m³ (CO in µg/m³)",
    }


def get_uv(lat, lon):
    payload = _request(
        "/data/2.5/uvi",
        {"lat": lat, "lon": lon},
        cache_key=f"owm:uv:{lat:.3f}:{lon:.3f}",
        cache_timeout=900,
    )
    if not _ok(payload) or payload.get("value") is None:
        return None
    value = float(payload["value"])
    if value < 3:
        level, color = "Low", "#4ade80"
    elif value < 6:
        level, color = "Moderate", "#fbbf24"
    elif value < 8:
        level, color = "High", "#fb923c"
    elif value < 11:
        level, color = "Very high", "#f87171"
    else:
        level, color = "Extreme", "#c084fc"
    return {"value": round(value, 1), "level": level, "color": color,
            "dt": payload.get("dt"), "hourly_available": False}


def get_alerts(lat, lon):
    """Real alerts only. Never fabricate a warning when no feed is available."""
    is_us = 24.0 <= lat <= 50.0 and -125.0 <= lon <= -66.0
    # Optional One Call 3.0 is skipped for US coordinates because the keyless
    # NOAA feed below is authoritative there and avoids a paid API call.
    if ONECALL_KEY and not is_us:
        try:
            payload = _request(
                "/data/3.0/onecall",
                {"lat": lat, "lon": lon, "exclude": "minutely,daily,hourly", "units": "metric"},
                cache_key=f"owm:alerts:{lat:.3f}:{lon:.3f}",
                cache_timeout=300,
                base=API_BASE,
                api_key=ONECALL_KEY,
            )
            if payload and payload.get("alerts"):
                return {
                    "supported": True,
                    "source": "OpenWeatherMap One Call 3.0",
                    "items": [
                        {"event": a.get("event", "Weather alert"),
                         "severity": a.get("severity", "Unknown"),
                         "description": a.get("description", "")[:420],
                         "start": a.get("start"), "end": a.get("end"),
                         "urgency": a.get("urgency", "")}
                        for a in payload["alerts"]
                    ],
                }
        except WeatherUnavailable:
            pass

    # NOAA / National Weather Service — real, keyless, US only.
    if is_us:
        try:
            payload = _request(
                "/alerts/active",
                {"point": f"{lat},{lon}", "limit": 20},
                cache_key=f"nws:alerts:{lat:.2f}:{lon:.2f}",
                cache_timeout=300,
                base="https://api.weather.gov",
                headers={"User-Agent": "PremiumWeatherApp/1.0 (weather dashboard)",
                         "Accept": "application/geo+json"},
            )
            if payload:
                items = []
                for feature in payload.get("features", []):
                    props = feature.get("properties", {})
                    items.append({
                        "event": props.get("event") or props.get("headline") or "Weather alert",
                        "severity": props.get("severity", "Unknown"),
                        "description": (props.get("description") or props.get("headline") or "")[:420],
                        "start": props.get("onset") or props.get("effective"),
                        "end": props.get("expires") or props.get("ends"),
                        "urgency": props.get("urgency", ""),
                        "area": props.get("areaDesc", ""),
                    })
                return {"supported": True, "source": "NOAA / National Weather Service", "items": items}
        except WeatherUnavailable:
            pass

    return {
        "supported": False,
        "source": None,
        "items": [],
        "reason": ("No severe-weather alert feed is available for this region with the "
                   "current data sources. NOAA alerts cover US locations only; global "
                   "alerts require an upgraded weather data plan."),
    }


# ---------------------------------------------------------------------------
# Shaping
# ---------------------------------------------------------------------------
def _weather_block(entry):
    w = (entry.get("weather") or [{}])[0]
    return {
        "id": w.get("id"),
        "main": w.get("main", ""),
        "description": w.get("description", ""),
        "icon": w.get("icon", ""),
    }


def build_hourly(current, forecast, offset, hour12=True):
    entries = []
    if current:
        main = current.get("main", {})
        wind = current.get("wind", {})
        entries.append({
            "dt": current.get("dt"),
            "label": "Now" if hour12 else "Now",
            "temp": main.get("temp"),
            "feels_like": main.get("feels_like"),
            "pop": None,
            "wind_speed": wind.get("speed"),
            "wind_deg": wind.get("deg"),
            "humidity": main.get("humidity"),
            "clouds": current.get("clouds", {}).get("all"),
            "weather": _weather_block(current),
            "is_now": True,
        })
    for item in (forecast or {}).get("list", []):
        main = item.get("main", {})
        wind = item.get("wind", {})
        entries.append({
            "dt": item.get("dt"),
            "label": _hour_label(item.get("dt"), offset, hour12),
            "temp": main.get("temp"),
            "feels_like": main.get("feels_like"),
            "pop": round((item.get("pop") or 0) * 100),
            "wind_speed": wind.get("speed"),
            "wind_deg": wind.get("deg"),
            "wind_gust": wind.get("gust"),
            "humidity": main.get("humidity"),
            "clouds": item.get("clouds", {}).get("all"),
            "weather": _weather_block(item),
            "is_now": False,
        })
    return entries[:25]


def build_daily(forecast, offset):
    groups = {}
    for item in (forecast or {}).get("list", []):
        day = _local(item.get("dt"), offset).date().isoformat()
        groups.setdefault(day, []).append(item)

    days = []
    for day, items in sorted(groups.items()):
        temps = [i["main"]["temp"] for i in items if "main" in i]
        if not temps:
            continue
        mids = items[len(items) // 2]
        conditions = Counter((i.get("weather") or [{}])[0].get("id") for i in items)
        dominant_id = conditions.most_common(1)[0][0] if conditions else None
        dominant = next((i for i in items if (i.get("weather") or [{}])[0].get("id") == dominant_id), mids)
        days.append({
            "date": day,
            "label": _local(items[0]["dt"], offset).strftime("%a"),
            "long_label": _local(items[0]["dt"], offset).strftime("%A, %d %b"),
            "temp_max": round(max(i["main"].get("temp_max", i["main"]["temp"]) for i in items), 1),
            "temp_min": round(min(i["main"].get("temp_min", i["main"]["temp"]) for i in items), 1),
            "pop": round(max((i.get("pop") or 0) for i in items) * 100),
            "wind_speed": round(max((i.get("wind") or {}).get("speed") or 0 for i in items), 1),
            "wind_deg": (mids.get("wind") or {}).get("deg"),
            "wind_gust": max(((i.get("wind") or {}).get("gust") or 0) for i in items) or None,
            "humidity": round(sum(i["main"].get("humidity", 0) for i in items) / len(items)),
            "weather": _weather_block(dominant),
            "samples": len(items),
        })
    return days


def get_dashboard(city=None, lat=None, lon=None, hour12=True):
    location = resolve_location(city, lat, lon)
    if not location:
        return {"ok": False, "error": "Location not found. Please check the city name."}

    lat, lon = location["lat"], location["lon"]
    dashboard_key = "owm:dashboard:{:.3f}:{:.3f}:{}".format(
        lat, lon, "12" if hour12 else "24")
    cached = cache.get(dashboard_key)
    if cached is not None:
        return cached

    # These feeds are independent. Fetching them concurrently removes the
    # serial 5 x timeout worst case without changing the dashboard payload.
    futures = {
        "current": _FEED_EXECUTOR.submit(get_current, lat, lon),
        "forecast": _FEED_EXECUTOR.submit(get_forecast, lat, lon),
        "air": _FEED_EXECUTOR.submit(get_air, lat, lon),
        "uv": _FEED_EXECUTOR.submit(get_uv, lat, lon),
        "alerts": _FEED_EXECUTOR.submit(get_alerts, lat, lon),
    }

    def feed_value(name):
        try:
            return futures[name].result()
        except WeatherUnavailable:
            return None

    feeds = {name: feed_value(name) for name in futures}
    current, forecast = feeds["current"], feeds["forecast"]
    if not _ok(current):
        raise WeatherUnavailable("Current weather data is temporarily unavailable.")
    if not _ok(forecast):
        raise WeatherUnavailable("Forecast data is temporarily unavailable.")

    tz_offset = forecast.get("city", {}).get("timezone", current.get("timezone", 0))
    main, wind = current.get("main", {}), current.get("wind", {})
    city_meta = forecast.get("city", {})
    sunrise = main.get("sunrise") or current.get("sys", {}).get("sunrise") or city_meta.get("sunrise")
    sunset = main.get("sunset") or current.get("sys", {}).get("sunset") or city_meta.get("sunset")
    apparent = _local(current.get("dt"), tz_offset)

    hourly = build_hourly(current, forecast, tz_offset, hour12)
    daily = build_daily(forecast, tz_offset)
    astro = solar_and_lunar(apparent.date(), lat, lon, sunrise, sunset, tz_offset)

    # Rain/sunshine totals for the day from the 3-hourly feed.
    today_key = apparent.date().isoformat()
    precipitation = 0.0
    for item in forecast.get("list", []):
        if _local(item.get("dt"), tz_offset).date().isoformat() == today_key:
            precipitation += (item.get("rain") or {}).get("3h", 0) or 0
            precipitation += (item.get("snow") or {}).get("3h", 0) or 0

    result = {
        "ok": True,
        "location": {**location, "timezone_offset": tz_offset,
                     "local_time": apparent.isoformat() if apparent else None,
                     "population": city_meta.get("population")},
        "current": {
            "temp": main.get("temp"),
            "feels_like": main.get("feels_like"),
            "temp_min": main.get("temp_min"),
            "temp_max": main.get("temp_max"),
            "pressure": main.get("pressure"),
            "humidity": main.get("humidity"),
            "dew_point": dew_point(main.get("temp"), main.get("humidity")),
            "dew_point_source": "calculated from temperature and humidity",
            "visibility": current.get("visibility"),
            "clouds": current.get("clouds", {}).get("all"),
            "wind_speed": wind.get("speed"),
            "wind_deg": wind.get("deg"),
            "wind_dir": wind_direction(wind.get("deg")),
            "wind_gust": hourly[1].get("wind_gust") if len(hourly) > 1 else None,
            "wind_gust_source": "nearest 3-hour forecast" if len(hourly) > 1 else None,
            "weather": _weather_block(current),
            "sunrise": sunrise,
            "sunset": sunset,
            "dt": current.get("dt"),
            "precipitation_today": round(precipitation, 2),
            "precipitation_source": "sum of 3-hour totals from forecast",
        },
        "hourly": hourly,
        "daily": daily,
        "air": None,
        "uv": None,
        "alerts": {"supported": False, "items": [], "reason": "Not loaded"},
        "astronomy": astro,
        "meta": {
            "forecast_days_available": len(daily),
            "forecast_days_requested": 14,
            "forecast_limitation": ("This plan supplies a rolling 5-day forecast in 3-hour "
                                    "steps. Depending on the current time, that covers today "
                                    "plus up to five further calendar dates. No longer-range "
                                    "data is shown because it is not available from this source."),
            "hourly_interval_hours": 3,
            "sources": ["OpenWeatherMap Current Weather", "OpenWeatherMap 5-day Forecast",
                        "OpenWeatherMap UV", "OpenWeatherMap Air Pollution"],
            "generated_at": (_local(current.get("dt"), 0).isoformat()
                             if current.get("dt") else
                             dt.datetime.now(dt.timezone.utc).replace(second=0, microsecond=0).isoformat()),
        },
    }

    # Optional feeds were fetched alongside the required ones; a failure here
    # simply leaves the corresponding card in its "unavailable" state.
    if feeds["air"] is not None:
        result["air"] = feeds["air"]
    if feeds["uv"] is not None:
        result["uv"] = feeds["uv"]
    if feeds["alerts"] is not None:
        result["alerts"] = feeds["alerts"]

    cache.set(dashboard_key, result, 300)
    return result


def radar_frames():
    """Real radar timestamps from RainViewer (public, keyless)."""
    payload = _request(
        "/public/weather-maps.json",
        cache_key="rainviewer:index",
        cache_timeout=300,
        base="https://api.rainviewer.com",
    )
    if not payload:
        return None
    radar = payload.get("radar", {})
    frames = []
    for group in (radar.get("past") or [])[-12:]:
        frames.append({"time": group.get("time"), "path": group.get("path"), "type": "past"})
    for group in (radar.get("nowcast") or [])[:6]:
        frames.append({"time": group.get("time"), "path": group.get("path"), "type": "nowcast"})
    return {"host": payload.get("host"), "frames": frames,
            "generated": payload.get("generated")}


def owm_tile(layer, z, x, y):
    """Fetch a weather overlay tile server-side so the API key stays private."""
    allowed = {"precipitation_new", "clouds_new", "wind_new", "temp_new", "pressure_new"}
    if layer not in allowed:
        return None
    if not (0 <= int(z) <= 18 and 0 <= int(x) < 2 ** int(z) and 0 <= int(y) < 2 ** int(z)):
        return None
    cache_key = f"owm:tile:{layer}:{z}:{x}:{y}"
    hit = cache.get(cache_key)
    if hit is not None:
        return hit or None
    url = f"{TILE_BASE}/map/{layer}/{z}/{x}/{y}.png"
    try:
        response = _session().get(url, params={"appid": API_KEY}, timeout=TIMEOUT)
        response.raise_for_status()
        content = response.content
        cache.set(cache_key, content, 600)
        return content
    except requests.RequestException:
        # A short negative cache prevents repeated failing upstream calls while
        # a tile is temporarily unavailable.
        cache.set(cache_key, b"", 60)
        return None
