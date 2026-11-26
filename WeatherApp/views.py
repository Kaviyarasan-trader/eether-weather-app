"""Page views.

The original ``home`` / ``delete_city`` behaviour is preserved while the UI is
now powered by the JSON API in ``api.py``.
"""
from django.conf import settings as django_settings
from django.contrib import messages
from django.http import HttpResponse
from django.shortcuts import redirect, render
from django.template.loader import render_to_string

from .form import CityForm
from .models import City
from .services.weather import WeatherUnavailable, search_cities


def _base_context(page, title):
    return {
        "page": page,
        "page_title": title,
        "carto_api_key": django_settings.CARTO_API_KEY,
    }


PAGE_VIEW_START = "<!-- PAGE_VIEW_START -->"
PAGE_VIEW_END = "<!-- PAGE_VIEW_END -->"


def _page_fragment(html):
    """Return only the main page view from a fully rendered Django template."""
    start = html.find(PAGE_VIEW_START)
    end = html.find(PAGE_VIEW_END)
    if start < 0 or end < 0:
        return html
    return html[start:end + len(PAGE_VIEW_END)]


def _render_page(request, template, page, title, extra=None):
    context = _base_context(page, title)
    if extra:
        context.update(extra)
    if request.GET.get("partial") == "1":
        html = render_to_string(template, context, request=request)
        response = HttpResponse(_page_fragment(html))
        # Page fragments are static per route; the browser can reuse them while
        # the SPA only swaps the active page view.
        response["Cache-Control"] = "public, max-age=300"
        return response
    return render(request, template, context)


def home(request):
    """Dashboard. Keeps the original POST add-city flow as a no-JS fallback."""
    if request.method == "POST":
        form = CityForm(request.POST)
        if form.is_valid():
            name = form.cleaned_data["name"].strip().title()
            if not City.objects.filter(name__iexact=name).exists():
                try:
                    matches = search_cities(name, 1)
                    if matches:
                        City.objects.create(
                            name=name,
                            lat=matches[0]["lat"],
                            lon=matches[0]["lon"],
                            country=matches[0].get("country", ""),
                        )
                        messages.success(request, f"{name} added successfully.")
                    else:
                        messages.error(request, "City not found. Please check the spelling.")
                except WeatherUnavailable:
                    messages.error(request, "Network error. Please try again.")
            else:
                messages.error(request, "City is already in your saved locations.")
    return _render_page(request, "weatherapp.html", "home", "Weather overview", {"form": CityForm()})


def delete_city(request, CName):
    """Original route retained for backwards compatibility."""
    City.objects.filter(name__iexact=CName).delete()
    messages.success(request, f"{CName} removed from saved locations.")
    return redirect("Home")


def forecast(request):
    return _render_page(request, "forecast.html", "forecast", "Forecast")


def radar(request):
    return _render_page(request, "radar.html", "radar", "Weather radar")


def air_quality(request):
    return _render_page(request, "air-quality.html", "air", "Air quality")


def settings(request):
    return _render_page(request, "settings.html", "settings", "Settings")


def insights(request):
    return _render_page(request, "insights.html", "insights", "Weather assistant")


def astronomy(request):
    return _render_page(request, "astronomy.html", "astronomy", "Astronomy")


def alerts(request):
    return _render_page(request, "alerts.html", "alerts", "Weather alerts")


def uv_and_sun(request):
    return _render_page(request, "uv.html", "uv", "UV & Sun")
