from django.contrib import admin
from django.urls import path

from WeatherApp import api, views

urlpatterns = [
    path("admin/", admin.site.urls),

    # Original routes — preserved.
    path("", views.home, name="Home"),
    path("delete/<CName>", views.delete_city, name="DCity"),

    # Premium pages.
    path("forecast/", views.forecast, name="Forecast"),
    path("radar/", views.radar, name="Radar"),
    path("air-quality/", views.air_quality, name="AirQuality"),
    path("settings/", views.settings, name="Settings"),
    path("insights/", views.insights, name="Insights"),
    path("astronomy/", views.astronomy, name="Astronomy"),
    path("alerts/", views.alerts, name="Alerts"),
    path("uv/", views.uv_and_sun, name="UVSun"),

    # JSON API.
    path("api/weather/", api.weather, name="APIWeather"),
    path("api/search/", api.search, name="APISearch"),
    path("api/locations/", api.locations, name="APILocations"),
    path("api/locations/<int:pk>/", api.location_detail, name="APILocationDetail"),
    path("api/settings/", api.settings_api, name="APISettings"),
    path("api/assistant/", api.assistant, name="APIAssistant"),
    path("api/radar/", api.radar_index, name="APIRadar"),
    path("api/tiles/<str:layer>/<int:z>/<int:x>/<int:y>.png", api.tile, name="APITile"),
]
