"""JSON API consumed by the frontend. All provider keys stay server-side."""
import json

from django.http import HttpResponse, JsonResponse
from django.utils.cache import patch_cache_control
from django.views.decorators.http import require_http_methods

from .models import City, Preference
from .services import openrouter as assistant_service
from .services.weather import (
    WeatherUnavailable,
    get_dashboard,
    owm_tile,
    radar_frames,
    resolve_location,
    search_cities,
)

DEFAULT_SETTINGS = {
    "temperature_unit": "C",
    "distance_unit": "km",
    "hour_format": "24",
    "theme": "light",
    "notifications": {"rain": True, "alerts": True, "air": False},
    "language": "en",
    "refresh_minutes": 10,
}


def _json_body(request):
    try:
        return json.loads(request.body or b"{}")
    except (ValueError, UnicodeDecodeError):
        return {}


def _settings():
    try:
        pref = Preference.objects.get(key="user_settings")
        stored = json.loads(pref.value)
    except (Preference.DoesNotExist, ValueError):
        stored = {}
    if not isinstance(stored, dict):
        stored = {}
    # Legacy keys are stripped: location and theme choices are browser-owned.
    stored.pop("auto_location", None)
    stored.pop("default_city", None)
    stored.pop("theme", None)
    merged = dict(DEFAULT_SETTINGS)
    merged.update(stored)
    merged["notifications"] = {**DEFAULT_SETTINGS["notifications"], **stored.get("notifications", {})}
    return merged


def _cached(response, max_age, public=False):
    """Let the browser and ConditionalGetMiddleware reuse unchanged responses."""
    patch_cache_control(
        response,
        public=public,
        private=not public,
        max_age=max_age,
        stale_while_revalidate=max_age * 2,
    )
    return response


@require_http_methods(["GET"])
def weather(request):
    city = request.GET.get("city")
    lat, lon = request.GET.get("lat"), request.GET.get("lon")
    hour_format = request.GET.get("hour_format")
    if hour_format is None:
        hour_format = _settings()["hour_format"]
    hour12 = hour_format == "12"
    try:
        data = get_dashboard(city, float(lat) if lat else None,
                             float(lon) if lon else None, hour12=hour12)
    except (WeatherUnavailable, ValueError, TypeError) as exc:
        return JsonResponse({"ok": False, "error": str(exc)}, status=503)
    if not data.get("ok"):
        return JsonResponse(data, status=404)
    return _cached(JsonResponse(data), 60)


@require_http_methods(["GET"])
def search(request):
    query = request.GET.get("q", "")
    return _cached(JsonResponse({"results": search_cities(query)}), 300)


@require_http_methods(["GET", "POST"])
def locations(request):
    if request.method == "GET":
        items = list(City.objects.all().values("id", "name", "lat", "lon", "country"))
        return _cached(JsonResponse({"locations": items}), 60)

    body = _json_body(request)
    name = str(body.get("name", "")).strip()
    lat, lon = body.get("lat"), body.get("lon")
    if not name:
        return JsonResponse({"ok": False, "error": "A city name is required."}, status=400)

    if City.objects.filter(name__iexact=name).exists():
        return JsonResponse({"ok": False, "error": "This city is already saved."}, status=409)

    try:
        location = resolve_location(name, float(lat) if lat is not None else None,
                                    float(lon) if lon is not None else None)
    except (WeatherUnavailable, ValueError, TypeError):
        location = None
    if not location:
        return JsonResponse({"ok": False, "error": "City not found. Please try another search."}, status=404)

    # Saved cities are shared bookmarks, never a visitor's selected city.
    city = City.objects.create(
        name=location["name"],
        lat=location["lat"],
        lon=location["lon"],
        country=location["country"],
    )
    return JsonResponse({"ok": True, "location": city.as_dict()}, status=201)


@require_http_methods(["DELETE", "POST"])
def location_detail(request, pk):
    try:
        city = City.objects.get(pk=pk)
    except City.DoesNotExist:
        return JsonResponse({"ok": False, "error": "Saved location not found."}, status=404)

    if request.method == "DELETE":
        name = city.name
        city.delete()
        return JsonResponse({"ok": True, "name": name})

    # Any legacy ``is_default`` payload is ignored. Selection is browser-owned.
    return JsonResponse({"ok": True, "location": city.as_dict()})


@require_http_methods(["GET", "POST"])
def settings_api(request):
    if request.method == "GET":
        return _cached(JsonResponse({"settings": _settings()}), 60)

    body = _json_body(request)
    current = _settings()
    allowed = set(DEFAULT_SETTINGS)
    allowed.discard("theme")  # theme is stored per browser, not in the shared row
    for key, value in body.items():
        if key in allowed:
            current[key] = value
    Preference.objects.update_or_create(
        key="user_settings",
        defaults={"value": json.dumps(current)},
    )
    return JsonResponse({"ok": True, "settings": current})


@require_http_methods(["POST"])
def assistant(request):
    body = _json_body(request)
    question = str(body.get("question", ""))[:300]
    if not question.strip():
        return JsonResponse({"ok": False, "error": "Please enter a question."}, status=400)
    history = body.get("history") or []
    if not isinstance(history, list):
        history = []
    try:
        data = get_dashboard(body.get("city"),
                             float(body["lat"]) if body.get("lat") else None,
                             float(body["lon"]) if body.get("lon") else None)
    except (WeatherUnavailable, ValueError, TypeError) as exc:
        return JsonResponse({"ok": False, "error": str(exc)}, status=503)
    return JsonResponse(assistant_service.answer_question(question, data, history))


@require_http_methods(["GET"])
def radar_index(request):
    data = radar_frames()
    if not data:
        return JsonResponse({"ok": False, "error": "Radar feed is temporarily unavailable."}, status=503)
    return _cached(JsonResponse({**data, "ok": True}), 60)


@require_http_methods(["GET"])
def tile(request, layer, z, x, y):
    content = owm_tile(layer, int(z), int(x), int(y))
    if not content:
        return HttpResponse(status=502)
    response = HttpResponse(content, content_type="image/png")
    return _cached(response, 600, public=True)
