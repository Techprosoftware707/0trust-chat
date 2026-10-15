"""Test surface: everything mounted (public and ops) for the test-suite."""

from django.urls import include, path

from .urls_public import urlpatterns as public_patterns

urlpatterns = [
    path("internal/", include(("apps.ops.internal_urls", "internal"), namespace="internal")),
    path("ops/", include(("apps.ops.urls", "ops"), namespace="ops")),
    *public_patterns,
]
