"""Astronomical values that are derived mathematically, never invented.

Sunrise / sunset come from the live weather feed.  Moon phase and illumination
use the standard synodic-month calculation.  Moonrise / moonset are marked as
estimates because the available API plan does not provide them directly.
"""
from __future__ import annotations

import datetime as dt
import math

KNOWN_NEW_MOON = 2451550.26  # 2000-01-06 18:14 UTC
SYNODIC_MONTH = 29.530588853


def _julian_day(date):
    y, m, d = date.year, date.month, date.day
    if m <= 2:
        y -= 1
        m += 12
    a = y // 100
    b = 2 - a + a // 4
    return math.floor(365.25 * (y + 4716)) + math.floor(30.6001 * (m + 1)) + d + b - 1524.5


def moon_info(date):
    jd = _julian_day(date) + 0.5
    age = (jd - KNOWN_NEW_MOON) % SYNODIC_MONTH
    phase = age / SYNODIC_MONTH
    illumination = (1 - math.cos(2 * math.pi * phase)) / 2

    if phase < 0.03 or phase >= 0.97:
        name, short = "New Moon", "new"
    elif phase < 0.22:
        name, short = "Waxing Crescent", "waxing-crescent"
    elif phase < 0.28:
        name, short = "First Quarter", "first-quarter"
    elif phase < 0.47:
        name, short = "Waxing Gibbous", "waxing-gibbous"
    elif phase < 0.53:
        name, short = "Full Moon", "full"
    elif phase < 0.72:
        name, short = "Waning Gibbous", "waning-gibbous"
    elif phase < 0.78:
        name, short = "Last Quarter", "last-quarter"
    else:
        name, short = "Waning Crescent", "waning-crescent"

    return {
        "phase": round(phase, 4),
        "age_days": round(age, 2),
        "illumination": round(illumination * 100),
        "name": name,
        "short": short,
        "waxing": phase < 0.5,
        "source": "calculated from synodic lunar cycle",
    }


def _clock(epoch, offset):
    if epoch is None:
        return None
    value = dt.datetime.fromtimestamp(epoch + (offset or 0), dt.timezone.utc)
    return value.strftime("%H:%M")


def solar_and_lunar(date, lat, lon, sunrise, sunset, offset):
    moon = moon_info(date)

    daylight_seconds = (sunset - sunrise) if (sunrise and sunset) else None
    daylight_hours = round(daylight_seconds / 3600, 2) if daylight_seconds else None
    golden_start = sunset - 3600 if sunset else None

    # Approximate relationship: the moon rises ~50 min later each day, i.e.
    # ~24 h later over one synodic cycle (new moon rises with the sun).
    moonrise = sunrise + moon["phase"] * 86400 if sunrise else None
    moonset = moonrise + 12.4 * 3600 if moonrise else None

    return {
        "sunrise": sunrise,
        "sunset": sunset,
        "sunrise_label": _clock(sunrise, offset),
        "sunset_label": _clock(sunset, offset),
        "daylight_hours": daylight_hours,
        "golden_hour_start": golden_start,
        "golden_hour_label": f"{_clock(golden_start, offset)} – {_clock(sunset, offset)}" if golden_start else None,
        "golden_hour_estimated": True,
        "moon": {
            **moon,
            "moonrise_label": _clock(moonrise, offset),
            "moonset_label": _clock(moonset, offset),
            "rise_set_estimated": True,
        },
        "latitude": lat,
        "longitude": lon,
    }
