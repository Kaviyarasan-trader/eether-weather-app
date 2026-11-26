from django.db import models


class City(models.Model):
    """Saved locations. Existing rows from the original app are preserved."""

    name = models.CharField(max_length=120, default="")
    lat = models.FloatField(null=True, blank=True)
    lon = models.FloatField(null=True, blank=True)
    country = models.CharField(max_length=10, blank=True, default="")
    # Legacy column retained for schema compatibility. It is no longer used to
    # decide which city a visitor sees; that choice lives in browser localStorage.
    is_default = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["created_at"]

    def __str__(self):
        return self.name

    def as_dict(self):
        return {
            "id": self.id,
            "name": self.name,
            "lat": self.lat,
            "lon": self.lon,
            "country": self.country,
        }


class Preference(models.Model):
    """Small key/value store for user settings (single-user installation)."""

    key = models.CharField(max_length=64, unique=True)
    value = models.TextField(default="{}")

    def __str__(self):
        return self.key
