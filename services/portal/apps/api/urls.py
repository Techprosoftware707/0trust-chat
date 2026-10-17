"""/api/v1/ — mounted by lumen/urls_public.py (public surface only).

Each Nexus app's ``api_urls.py`` is mounted at ``workspaces/<workspace_id>/<app>/``
automatically (apps.core.extensions); views receive ``workspace_id`` and resolve it with
``@api_endpoint``.
"""

from django.conf import settings
from django.urls import include, path, re_path

from apps.core.extensions import app_label, has_module

from . import views
from .decorators import not_found_view

app_name = "api"

urlpatterns = [
    path("me", views.me, name="me"),
    path("workspaces/<uuid:workspace_id>", views.workspace_detail, name="workspace"),
    path("workspaces/<uuid:workspace_id>/settings", views.workspace_settings, name="workspace_settings"),
    path("workspaces/<uuid:workspace_id>/members", views.members, name="members"),
]
for _app in settings.NEXUS_APPS:
    if has_module(_app, "api_urls"):
        urlpatterns.append(path(f"workspaces/<uuid:workspace_id>/{app_label(_app)}/", include(f"{_app}.api_urls")))
urlpatterns.append(re_path(r"^.*$", not_found_view))
