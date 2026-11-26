"""Rule-based insight cards for the dashboard.

The chat assistant is handled by the OpenRouter service.  This module keeps
the small, local insight cards shown on the home and assistant pages; those
cards are generated strictly from the live weather payload and never invent
values.  The legacy question helpers below remain for compatibility only.
"""
from __future__ import annotations

import datetime as dt
import re

from .weather import _local, wind_direction


def _temp(value, unit="C"):
    if value is None:
        return "unavailable"
    return f"{round(value)}°{unit}"


def _max_pop(data):
    values = [h.get("pop") for h in data.get("hourly", []) if h.get("pop") is not None]
    return max(values) if values else None


def build_insights(data):
    insights = []
    current = data.get("current", {})
    hourly = data.get("hourly", [])
    daily = data.get("daily", [])
    temp = current.get("temp")
    unit = "C"
    pop = _max_pop(data)
    wind = current.get("wind_speed")
    visibility = current.get("visibility")
    desc = current.get("weather", {}).get("description", "")

    if pop is not None:
        if pop >= 70:
            insights.append({"icon": "umbrella", "tone": "rain", "title": "Rain is likely today",
                             "text": f"Peak rain probability in the next 24 hours is {pop}%. An umbrella is a good idea."})
        elif pop >= 35:
            insights.append({"icon": "cloud-rain", "tone": "caution", "title": "Possible showers",
                             "text": f"Rain probability reaches {pop}%. Keep a light layer handy."})
        else:
            insights.append({"icon": "sun", "tone": "good", "title": "Dry conditions ahead",
                             "text": f"Rain probability stays around {pop}% over the next 24 hours."})

    if temp is not None:
        if temp >= 30:
            insights.append({"icon": "temperature-high", "tone": "warn", "title": "Hot conditions",
                             "text": f"It is {_temp(temp, unit)} now. Stay hydrated and avoid prolonged midday sun."})
        elif temp <= 5:
            insights.append({"icon": "snowflake", "tone": "rain", "title": "Cold conditions",
                             "text": f"It is {_temp(temp, unit)} now. Dress in warm layers, especially in the evening."})
        else:
            insights.append({"icon": "check", "tone": "good", "title": "Comfortable temperature",
                             "text": f"Current temperature is {_temp(temp, unit)}, comfortable for most outdoor activity."})

    if wind is not None:
        if wind >= 40:
            insights.append({"icon": "wind", "tone": "warn", "title": "Strong winds",
                             "text": f"Winds are around {round(wind)} m/s. Secure loose objects and take care cycling."})
        elif wind >= 20:
            insights.append({"icon": "wind", "tone": "caution", "title": "Breezy",
                             "text": f"Wind speed is {round(wind)} m/s. A windbreaker would help."})

    if visibility is not None and visibility < 3000:
        insights.append({"icon": "eye", "tone": "caution", "title": "Reduced visibility",
                         "text": f"Visibility is about {round(visibility / 1000, 1)} km. Allow extra travel time."})

    candidates = [h for h in hourly if h.get("temp") is not None and h.get("pop") is not None]
    if candidates:
        def score(h):
            t = h["temp"]
            comfort = -abs(t - 21) / 4
            return comfort - h["pop"] / 12 - (h.get("wind_speed") or 0) / 10
        best = max(candidates, key=score)
        insights.append({"icon": "clock", "tone": "good", "title": "Best time outdoors",
                         "text": f"Around {best['label']}, with {_temp(best['temp'])} and {best['pop']}% rain chance."})

    if len(daily) >= 2:
        today, tomorrow = daily[0], daily[1]
        delta = tomorrow["temp_max"] - today["temp_max"]
        if abs(delta) >= 1:
            direction = "hotter" if delta > 0 else "cooler"
            insights.append({"icon": "calendar", "tone": "caution" if delta > 3 else "neutral",
                             "title": f"Tomorrow is {direction}",
                             "text": f"Maximum temperature changes by {abs(round(delta))}°C, from {_temp(today['temp_max'])} to {_temp(tomorrow['temp_max'])}."})

    if desc:
        insights.append({"icon": "sparkles", "tone": "neutral", "title": "Current conditions",
                         "text": f"Skies are described as {desc.capitalize()} right now."})

    return insights[:6]


# ---------------------------------------------------------------------------
# Question parsing
# ---------------------------------------------------------------------------
_TOPIC_PATTERNS = (
    ("rain", r"\b(rain|rains|raining|rainfall|umbrella|wet|shower|showers|drizzle|precipitation|downpour|snow|snowfall)\b"),
    ("temperature", r"\b(temp|temps|temperature|hot|hotter|warm|warmer|cold|colder|cool|cooler|degree|degrees|heat|chilly|freezing|high|low)\b"),
    ("humidity", r"\b(humid|humidity|muggy|sticky|dew\s*point|moist)\b"),
    ("wind", r"\b(wind|winds|windy|breeze|breezy|gust|gusts)\b"),
    ("uv", r"\b(uv|ultraviolet|sunburn|sunscreen|sun\s*cream|sun\s*protection|sun\s*strength)\b"),
    ("air", r"\b(air\s*quality|aqi|pollution|polluted|smog|breathing|breath)\b"),
    ("sunrise", r"\b(sunrise|sun\s*rise|dawn|sun\s*up)\b"),
    ("sunset", r"\b(sunset|sun\s*set|dusk|sun\s*down)\b"),
    ("daylight", r"\b(daylight|day\s*length|hours\s*of\s*sun|sun\s*hours)\b"),
    ("alerts", r"\b(alert|alerts|warning|warnings|advisory|severe\s*weather|watch)\b"),
    ("outside", r"\b(outside|outdoor|outdoors|go\s*out|walking|walk|hike|picnic|good\s*time)\b"),
    ("travel", r"\b(travel|travelling|traveling|drive|driving|road|trip|commute|journey)\b"),
    ("clothing", r"\b(wear|wearing|jacket|coat|clothes|clothing|dress|layer|layers|sweater)\b"),
    ("forecast", r"\b(weather|forecast|conditions|outlook|look\s*like|looking\s*like|how\s*will)\b"),
)

# Phrases that explicitly point back to the previous answer.  A question with
# its own topic (for example "Why is it so hot?") is a new question and should
# not silently inherit an earlier time frame such as tomorrow.
_CONTEXT_CARRY_RE = re.compile(
    r"^(and\b|also\b|too\b|what\s+about\b|how\s+about\b|same\b|then\b|"
    r"there\b|it\b|that\b|this\b|anything\s+else\b|tell\s+me\s+more\b)"
)


def _normalize(text):
    text = (text or "").lower().replace("’", "'")
    text = re.sub(r"[^a-z0-9'\s]", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def _detect_topics(q):
    found = []
    for topic, pattern in _TOPIC_PATTERNS:
        if re.search(pattern, q):
            found.append(topic)
    return found


def _detect_when(q):
    if re.search(r"\b(tomorrow|tmrw|next\s+day|day\s+after\s+today)\b", q):
        return "tomorrow"
    if re.search(r"\b(tonight|this\s+evening|after\s+dark)\b", q):
        return "tonight"
    if re.search(r"\b(later|this\s+afternoon|this\s+morning|next\s+hour|next\s+few\s+hours|coming\s+hours)\b", q):
        return "later"
    if re.search(r"\b(today|now|right\s+now|currently|at\s+the\s+moment|present|current)\b", q):
        return "today"
    return None


def _history_questions(history):
    out = []
    if not isinstance(history, (list, tuple)):
        return out
    for item in history[-6:]:
        if isinstance(item, dict):
            text = item.get("question") or item.get("text") or item.get("content") or item.get("message") or ""
        else:
            text = item
        text = _normalize(text)
        if text:
            out.append(text)
    return out


def _merge_context(q, topics, when, history):
    if not history:
        return topics, when or "today"

    has_own_topic = bool(topics)
    prev_topics, prev_when = [], None
    for old in reversed(history):
        old_topics = _detect_topics(old)
        for topic in old_topics:
            if topic not in prev_topics:
                prev_topics.append(topic)
        old_when = _detect_when(old)
        if old_when:
            prev_when = old_when
            break
        # A standalone question with no time word establishes "now" as the
        # active frame. Keep walking back only for short elaborations such as
        # "and humidity?" so they can reuse the last real anchor.
        if old_topics and not _CONTEXT_CARRY_RE.search(old):
            prev_when = "today"
            break

    if not topics and prev_topics:
        topics = prev_topics[:1]
    if not when and prev_when and (not has_own_topic or _CONTEXT_CARRY_RE.search(q)):
        when = prev_when
    return topics, when or "today"


# ---------------------------------------------------------------------------
# Data helpers
# ---------------------------------------------------------------------------
def _place(data):
    return (data.get("location") or {}).get("name") or "this location"


def _condition_text(entry):
    return ((entry or {}).get("weather") or {}).get("description", "").strip()


def _daily(data, when):
    days = data.get("daily") or []
    if not days:
        return None
    return days[1] if when == "tomorrow" and len(days) > 1 else days[0]


def _hourly_for_day(data, when):
    hours = data.get("hourly") or []
    if not hours:
        return []
    offset = (data.get("location") or {}).get("timezone_offset") or 0
    days = data.get("daily") or []
    target = None
    if when == "tomorrow":
        if len(days) > 1:
            target = days[1].get("date")
    else:
        local_time = (data.get("location") or {}).get("local_time")
        if local_time:
            target = str(local_time)[:10]
        elif days:
            target = days[0].get("date")
    if not target:
        return hours
    return [h for h in hours if h.get("dt") is not None
            and _local(h["dt"], offset).date().isoformat() == target]


def _peak_pop(hours):
    values = [(h.get("pop"), h.get("label")) for h in hours if h.get("pop") is not None]
    return max(values, key=lambda pair: pair[0]) if values else (None, None)


def _chance_phrase(pop):
    if pop is None:
        return "the rain chance is unavailable"
    if pop >= 70:
        return f"rain is likely ({pop}% chance)"
    if pop >= 35:
        return f"there is a chance of rain ({pop}% chance)"
    return f"rain looks unlikely ({pop}% chance)"


def _wind_phrase(speed, direction=None, gust=None):
    if speed is None:
        return "wind information is unavailable"
    speed = float(speed)
    if speed < 2:
        label = "calm"
    elif speed < 5:
        label = "light"
    elif speed < 10:
        label = "moderate"
    elif speed < 15:
        label = "breezy"
    else:
        label = "strong"
    text = f"{label} wind at {round(speed, 1)} m/s"
    if direction:
        text += f" from {direction}"
    if gust is not None:
        text += f", gusting to {round(float(gust), 1)} m/s"
    return text


def _direction(value):
    if value is None:
        return None
    if isinstance(value, str):
        return value
    try:
        return wind_direction(float(value))
    except (TypeError, ValueError):
        return None


def _uv_level(value):
    if value is None:
        return None
    if value < 3:
        return "Low"
    if value < 6:
        return "Moderate"
    if value < 8:
        return "High"
    if value < 11:
        return "Very high"
    return "Extreme"


def _comfort_score(h):
    score = 0.0
    if h.get("temp") is not None:
        score -= abs(float(h["temp"]) - 21) / 4
    if h.get("pop") is not None:
        score -= float(h["pop"]) / 12
    if h.get("wind_speed") is not None:
        score -= float(h["wind_speed"]) / 10
    return score


def _best_window_sentence(data, when):
    hours = [h for h in _hourly_for_day(data, when)
             if h.get("temp") is not None and h.get("pop") is not None]
    if not hours:
        return "Hourly comfort details are not available for that period."
    best = max(hours, key=_comfort_score)
    return (f"the most comfortable window is around {best.get('label', 'later')}, "
            f"with {_temp(best['temp'])} and {best['pop']}% rain chance.")


# ---------------------------------------------------------------------------
# Topic answers
# ---------------------------------------------------------------------------
def _answer_rain(data, when, q):
    place = _place(data)
    wants_umbrella = bool(re.search(r"\b(umbrella|carry|brolly)\b", q))
    if when == "tomorrow":
        day = _daily(data, "tomorrow")
        if not day or day.get("pop") is None:
            return f"Tomorrow's rain probability is not available for {place} from the current data."
        pop = day["pop"]
        answer = f"Tomorrow in {place}, {_chance_phrase(pop)}."
        if wants_umbrella:
            answer += " Take an umbrella." if pop >= 40 else " You probably will not need one."
        return answer

    hours = _hourly_for_day(data, "today") or (data.get("hourly") or [])
    pop, label = _peak_pop(hours)
    parts = []
    if pop is None:
        parts.append(f"Today's rain probability is not available for {place}.")
    else:
        timing = f", peaking around {label}" if label and label != "Now" else ""
        parts.append(f"Today in {place}, {_chance_phrase(pop)}{timing}.")
    precip = (data.get("current") or {}).get("precipitation_today")
    if precip is not None:
        parts.append(f"Forecast precipitation for today is {round(float(precip), 1)} mm.")
    if wants_umbrella and pop is not None:
        parts.append("Take an umbrella." if pop >= 40 else "You probably will not need an umbrella.")
    return " ".join(parts)


def _answer_temperature(data, when, q):
    place = _place(data)
    why = bool(re.search(r"\b(why|because|so\s+hot|so\s+cold|how\s+come)\b", q))
    day = _daily(data, when)
    if when == "tomorrow":
        if not day or (day.get("temp_max") is None and day.get("temp_min") is None):
            return f"Tomorrow's temperature forecast is not available for {place}."
        answer = (f"Tomorrow in {place}, the high is {_temp(day.get('temp_max'))} "
                  f"and the low is {_temp(day.get('temp_min'))}.")
        desc = _condition_text(day)
        if desc:
            answer += f" Conditions are forecast to be {desc}."
        today = _daily(data, "today")
        if today and day.get("temp_max") is not None and today.get("temp_max") is not None:
            delta = round(day["temp_max"] - today["temp_max"])
            if abs(delta) >= 1:
                answer += f" That is {abs(delta)}° {'warmer' if delta > 0 else 'cooler'} than today."
        return answer

    current = data.get("current") or {}
    temp = current.get("temp")
    if temp is None:
        return f"Current temperature is not available for {place}."
    feels = current.get("feels_like")
    if why:
        factors = []
        humidity = current.get("humidity")
        uv = data.get("uv") or {}
        desc = _condition_text(current)
        if humidity is not None and humidity >= 60:
            factors.append(f"humidity is {humidity}%")
        elif humidity is not None and humidity <= 30:
            factors.append(f"the air is dry at {humidity}% humidity")
        if uv.get("value") is not None and float(uv["value"]) >= 6:
            factors.append(f"the UV index is {uv['value']}")
        if desc:
            factors.append(f"conditions are {desc}")
        corrected = False
        if float(temp) < 25 and re.search(r"\b(hot|hotter|high)\b", q):
            answer = f"It is actually {_temp(temp)} in {place}, so the live data does not show unusually high heat"
            corrected = True
        elif float(temp) > 18 and re.search(r"\b(cold|colder|low)\b", q):
            answer = f"It is actually {_temp(temp)} in {place}, so the live data does not show unusually cold conditions"
            corrected = True
        else:
            answer = "The live data shows why it feels this way"
        if factors:
            answer += ("; nearby details: " if corrected else ": ") + "; ".join(factors)
        answer += f". It is {_temp(temp)} and feels like {_temp(feels)}."
        return answer

    answer = f"It is {_temp(temp)} in {place}"
    if feels is not None:
        answer += f", feeling like {_temp(feels)}"
    answer += "."
    source_day = day or {}
    if current.get("temp_max") is not None or source_day.get("temp_max") is not None:
        answer += (f" Today's high is {_temp(current.get('temp_max') if current.get('temp_max') is not None else source_day.get('temp_max'))} "
                   f"and the low is {_temp(current.get('temp_min') if current.get('temp_min') is not None else source_day.get('temp_min'))}.")
    return answer


def _answer_humidity(data, when, q):
    place = _place(data)
    day = _daily(data, when)
    if when == "tomorrow":
        value = (day or {}).get("humidity")
        if value is None:
            return f"Tomorrow's humidity is not available for {place} from the current data."
        label = "muggy" if value >= 70 else "dry" if value <= 30 else "moderate"
        return f"Average humidity tomorrow in {place} is forecast at {value}% ({label})."
    current = data.get("current") or {}
    value = current.get("humidity")
    if value is None:
        return f"Humidity data is not available for {place} right now."
    label = "muggy" if value >= 70 else "dry" if value <= 30 else "moderate"
    answer = f"Humidity in {place} is {value}% right now ({label})."
    if current.get("dew_point") is not None:
        answer += f" The dew point is {round(current['dew_point'])}°C."
    if value >= 70:
        answer += " It may feel sticky."
    elif value <= 30:
        answer += " The air is quite dry."
    return answer


def _answer_wind(data, when, q):
    place = _place(data)
    day = _daily(data, when)
    if when == "tomorrow":
        speed = (day or {}).get("wind_speed")
        if speed is None:
            return f"Tomorrow's wind forecast is not available for {place}."
        return f"Tomorrow in {place}, expect {_wind_phrase(speed, _direction((day or {}).get('wind_deg')), (day or {}).get('wind_gust'))}."
    current = data.get("current") or {}
    if current.get("wind_speed") is None:
        return f"Wind information is not available for {place} right now."
    return f"Wind in {place} is {_wind_phrase(current['wind_speed'], current.get('wind_dir'), current.get('wind_gust'))}."


def _answer_uv(data, when, q):
    place = _place(data)
    uv = data.get("uv") or {}
    value = uv.get("value")
    if value is None:
        return f"UV index data is not available for {place} right now."
    level = uv.get("level") or _uv_level(float(value)) or "Unknown"
    answer = f"The current UV index in {place} is {value} ({level})."
    if when == "tomorrow":
        answer += " Tomorrow's UV forecast is not provided by this data source, so I cannot give a reliable number for tomorrow."
    if re.search(r"\b(sunscreen|sun\s*cream|protection|sunburn)\b", q):
        if float(value) >= 6:
            answer += " Use sunscreen and seek shade if you will be outside for long."
        elif float(value) >= 3:
            answer += " Sunscreen is sensible for a long stay outdoors."
        else:
            answer += " Sun protection is not urgent at this level."
    return answer


def _answer_air(data, when, q):
    place = _place(data)
    air = data.get("air")
    if not air or air.get("aqi") is None:
        return f"Air quality data is not available for {place} right now."
    answer = f"Air quality in {place} is {air.get('label', 'unknown')} with an AQI of {air['aqi']}."
    if air.get("advice"):
        answer += f" {air['advice']}"
    if when == "tomorrow":
        answer += " An air-quality forecast for tomorrow is not available from this data source."
    return answer


def _answer_sun(data, topic, when):
    place = _place(data)
    astro = data.get("astronomy") or {}
    if when == "tomorrow":
        return (f"{topic.capitalize()} time for tomorrow is not provided by this data source. "
                f"Today's local times are sunrise {astro.get('sunrise_label') or 'unavailable'} "
                f"and sunset {astro.get('sunset_label') or 'unavailable'}.")
    if topic == "daylight":
        hours = astro.get("daylight_hours")
        if hours is None:
            return f"Daylight duration is not available for {place} right now."
        return f"Today in {place}, there are about {hours} hours of daylight."
    label = astro.get(f"{topic}_label")
    if not label:
        return f"{topic.capitalize()} time is not available for {place} right now."
    return f"{topic.capitalize()} in {place} is at {label} local time today."


def _answer_alerts(data, when):
    place = _place(data)
    alerts = data.get("alerts") or {}
    if not alerts.get("supported"):
        reason = alerts.get("reason") or "No alert feed is available for this region."
        return f"Weather alert information is not available for {place}. {reason}"
    items = alerts.get("items") or []
    if not items:
        return f"There are no active weather alerts for {place} in the available alert feed."
    count = len(items)
    lead = f"There {'is' if count == 1 else 'are'} {count} active weather alert{'s' if count != 1 else ''} for {place}: "
    details = []
    for item in items[:3]:
        detail = item.get("event") or "Weather alert"
        if item.get("severity") and item.get("severity") != "Unknown":
            detail += f" ({item['severity']})"
        details.append(detail)
    suffix = "" if count <= 3 else f", plus {count - 3} more in the alert feed"
    return lead + ", ".join(details) + suffix + "."


def _answer_outside(data, when, q):
    place = _place(data)
    current = data.get("current") or {}
    temp = current.get("temp")
    hours = _hourly_for_day(data, "today") or (data.get("hourly") or [])
    pop, _ = _peak_pop(hours)
    wind = current.get("wind_speed")
    uv = (data.get("uv") or {}).get("value")
    aqi = (data.get("air") or {}).get("aqi")
    issues = []
    if temp is not None and (float(temp) < 5 or float(temp) > 32):
        issues.append(f"the temperature is {_temp(temp)}")
    if pop is not None and pop >= 50:
        issues.append(f"rain chance is {pop}%")
    if wind is not None and float(wind) >= 10:
        issues.append(f"wind is {round(float(wind), 1)} m/s")
    if uv is not None and float(uv) >= 8:
        issues.append(f"UV index is {uv}")
    if aqi is not None and int(aqi) >= 4:
        issues.append(f"air quality AQI is {aqi}")
    best = _best_window_sentence(data, when)
    if re.search(r"\b(best\s+time|when\s+is|later)\b", q):
        return f"For {place}, {best}"

    facts = []
    if temp is not None:
        facts.append(f"it is {_temp(temp)}")
    humidity = current.get("humidity")
    if humidity is not None:
        facts.append(f"humidity is {humidity}%")
    if wind is not None:
        facts.append(f"wind is {round(float(wind), 1)} m/s")
    if pop is not None:
        facts.append(f"rain chance peaks at {pop}% today")
    prefix = (f"Right now in {place}, " + "; ".join(facts) + ". ") if facts else f"Here is the latest for {place}. "
    if issues:
        prefix += "It is not ideal to head out just now: " + ", ".join(issues) + ". "
    else:
        prefix += "Conditions are workable for a short outing. "
    return prefix + best[:1].upper() + best[1:]


def _answer_travel(data, when, q):
    place = _place(data)
    current = data.get("current") or {}
    hours = _hourly_for_day(data, when) or (data.get("hourly") or [])
    pop, label = _peak_pop(hours)
    wind = current.get("wind_speed")
    visibility = current.get("visibility")
    problems = []
    if pop is not None and pop >= 60:
        problems.append(f"rain chance reaches {pop}%" + (f" around {label}" if label else ""))
    if wind is not None and float(wind) >= 10:
        problems.append(f"wind is {round(float(wind), 1)} m/s")
    if visibility is not None and visibility < 3000:
        problems.append(f"visibility is about {round(visibility / 1000, 1)} km")
    if problems:
        return f"Travel near {place} needs some care: {', '.join(problems)}. Check conditions again before leaving."
    return f"Conditions look suitable for travel around {place} right now, with no major rain, wind or visibility issues in the data."


def _answer_clothing(data, when, q):
    place = _place(data)
    current = data.get("current") or {}
    temp = current.get("temp")
    if temp is None:
        return f"I need the current temperature to advise on clothing in {place}."
    if float(temp) < 10:
        answer = f"Take a warm coat — it is {_temp(temp)} in {place}."
    elif float(temp) < 18:
        answer = f"A light jacket is a good idea at {_temp(temp)}."
    else:
        answer = f"A jacket is probably unnecessary at {_temp(temp)}."
    hours = _hourly_for_day(data, "today") or (data.get("hourly") or [])
    pop, _ = _peak_pop(hours)
    if pop is not None and pop >= 40:
        answer += " Rain is possible, so a compact umbrella would help."
    return answer


def _answer_forecast(data, when, q):
    place = _place(data)
    day = _daily(data, when)
    if not day:
        label = "Tomorrow's" if when == "tomorrow" else "Today's"
        return f"{label} forecast is not available for {place} from the current data."
    label = "Tomorrow" if when == "tomorrow" else "Today"
    desc = _condition_text(day)
    answer = f"{label} in {place}, {desc or 'the outlook'} with a high of {_temp(day.get('temp_max'))} and a low of {_temp(day.get('temp_min'))}."
    if day.get("pop") is not None:
        answer += f" {_chance_phrase(day['pop']).capitalize()}."
    if day.get("wind_speed") is not None:
        answer += f" Expect {_wind_phrase(day['wind_speed'], _direction(day.get('wind_deg')))}."
    if when != "tomorrow":
        current = data.get("current") or {}
        if current.get("temp") is not None:
            answer += f" Right now it is {_temp(current['temp'])}."
    return answer


_TOPIC_ANSWERS = {
    "rain": _answer_rain,
    "temperature": _answer_temperature,
    "humidity": _answer_humidity,
    "wind": _answer_wind,
    "uv": _answer_uv,
    "air": _answer_air,
    "alerts": _answer_alerts,
    "outside": _answer_outside,
    "travel": _answer_travel,
    "clothing": _answer_clothing,
    "forecast": _answer_forecast,
}


def answer_question(question, data, history=None):
    """Answer a natural-language weather question using the live dashboard payload."""
    if not data or not data.get("ok"):
        return {"answer": "I need live weather data first. Search for a city and try again.",
                "source": "no live data available", "ok": False}

    q = _normalize(question)
    if not q:
        return {"answer": "Please ask me a weather question and I will use the live data for your selected city.",
                "source": "question not understood", "ok": False}

    topics = _detect_topics(q)
    when = _detect_when(q)
    topics, when = _merge_context(q, topics, when, _history_questions(history))
    if "forecast" in topics and len(topics) > 1:
        topics = [t for t in topics if t != "forecast"] or ["forecast"]

    place = _place(data)
    if not topics:
        return {
            "answer": (f"I can help with temperature, rain, humidity, wind, UV, air quality, "
                       f"sunrise and sunset, alerts, and whether it is a good time to go outside "
                       f"using live data for {place}. Try asking in your own words."),
            "source": f"Live data for {place}", "ok": True,
        }

    parts = []
    for topic in topics:
        if topic in ("sunrise", "sunset", "daylight"):
            parts.append(_answer_sun(data, topic, when))
            continue
        handler = _TOPIC_ANSWERS.get(topic)
        if not handler:
            continue
        if topic in ("alerts",):
            parts.append(handler(data, when))
        else:
            parts.append(handler(data, when, q))

    if not parts:
        return {"answer": f"I do not have enough live data to answer that for {place}.",
                "source": f"Live data for {place}", "ok": True}

    answer = " ".join(part.strip() for part in parts if part and part.strip())
    return {"answer": answer, "source": f"Live data for {place}", "ok": True}
