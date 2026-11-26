from django.db import migrations, models
from django.utils import timezone


def fill_missing_created_at(apps, schema_editor):
    City = apps.get_model("WeatherApp", "City")
    City.objects.filter(created_at__isnull=True).update(created_at=timezone.now())


class Migration(migrations.Migration):

    dependencies = [
        ("WeatherApp", "0002_premium_upgrade"),
    ]

    operations = [
        migrations.RunPython(fill_missing_created_at, migrations.RunPython.noop),
        migrations.AlterField(
            model_name="city",
            name="created_at",
            field=models.DateTimeField(auto_now_add=True),
        ),
        migrations.AlterModelOptions(
            name="city",
            options={"ordering": ["created_at"]},
        ),
    ]
