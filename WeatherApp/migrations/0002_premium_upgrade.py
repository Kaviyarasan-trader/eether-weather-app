from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("WeatherApp", "0001_initial"),
    ]

    operations = [
        migrations.AlterField(
            model_name="city",
            name="name",
            field=models.CharField(default="", max_length=120),
        ),
        migrations.AddField(
            model_name="city",
            name="country",
            field=models.CharField(blank=True, default="", max_length=10),
        ),
        migrations.AddField(
            model_name="city",
            name="is_default",
            field=models.BooleanField(default=False),
        ),
        migrations.AddField(
            model_name="city",
            name="lat",
            field=models.FloatField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="city",
            name="lon",
            field=models.FloatField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="city",
            name="created_at",
            field=models.DateTimeField(auto_now_add=True, null=True),
        ),
        migrations.CreateModel(
            name="Preference",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("key", models.CharField(max_length=64, unique=True)),
                ("value", models.TextField(default="{}")),
            ],
        ),
    ]
