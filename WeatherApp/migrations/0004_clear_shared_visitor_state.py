"""Remove legacy shared city-selection state.

Selected cities and location preferences are now stored in each browser's
localStorage. This migration clears the old server-side defaults so no visitor
can inherit another visitor's city after upgrading.
"""
import json

from django.db import migrations


def clear_shared_selection(apps, schema_editor):
    City = apps.get_model("WeatherApp", "City")
    Preference = apps.get_model("WeatherApp", "Preference")

    # The column stays for schema compatibility but no longer means anything.
    City.objects.all().update(is_default=False)

    try:
        pref = Preference.objects.get(key="user_settings")
    except Preference.DoesNotExist:
        return

    try:
        settings = json.loads(pref.value)
    except (TypeError, ValueError):
        return
    if not isinstance(settings, dict):
        return

    changed = False
    for key in ("auto_location", "default_city"):
        if key in settings:
            settings.pop(key)
            changed = True
    if changed:
        pref.value = json.dumps(settings)
        pref.save(update_fields=["value"])


class Migration(migrations.Migration):

    dependencies = [
        ("WeatherApp", "0003_city_created_at_ordering"),
    ]

    operations = [
        migrations.RunPython(clear_shared_selection, migrations.RunPython.noop),
    ]
