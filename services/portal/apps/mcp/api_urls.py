"""Mounted at /api/v1/workspaces/<workspace_id>/mcp/ (see apps.mcp.api_views)."""

from django.urls import path

from . import api_views as v

app_name = "mcp_api"

urlpatterns = [
    path("status", v.status, name="status"),
    path("connections", v.connections, name="connections"),
    path("connections/<uuid:grant_id>", v.connection_detail, name="connection"),
]
