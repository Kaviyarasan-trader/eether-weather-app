"""Remove the legacy shared theme preference.

The theme is now stored in each browser's localStorage. This migration drops the
old shared value so no visitor inherits another visitor's theme.
"""
import json

from django.db import migrations


def clear_shared_theme(apps, schema_editor):
    Preference = apps.get_model("WeatherApp", "Preference")
    try:
        pref = Preference.objects.get(key="user_settings")
    except Preference.DoesNotExist:
        return

    try:
        settings = json.loads(pref.value)
    except (TypeError, ValueError):
        return
    if not isinstance(settings, dict) or "theme" not in settings:
        return

    settings.pop("theme")
    pref.value = json.dumps(settings)
    pref.save(update_fields=["value"])


class Migration(migrations.Migration):

    dependencies = [
        ("WeatherApp", "0004_clear_shared_visitor_state"),
    ]

    operations = [
        migrations.RunPython(clear_shared_theme, migrations.RunPython.noop),
    ]
