from django.urls import path

from . import internal_views

urlpatterns = [
    path("v1/media-limits", internal_views.media_limits, name="media_limits"),
    path("v1/healthz", internal_views.healthz, name="healthz"),
]
