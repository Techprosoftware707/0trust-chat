"""Root-level routes of the MCP connector (included by lumen/urls_public.py before allauth's
OIDC routes, so the token endpoint wrapper shadows allauth's own)."""

from django.urls import path

from . import oauth, views

urlpatterns = [
    path("mcp", views.endpoint, name="mcp_endpoint"),
    path(".well-known/oauth-protected-resource", views.protected_resource_metadata, name="mcp_prm_root"),
    path(".well-known/oauth-protected-resource/mcp", views.protected_resource_metadata, name="mcp_prm"),
    path(".well-known/oauth-authorization-server", views.authorization_server_metadata, name="oauth_as_metadata"),
    path("identity/o/api/register", oauth.registration, name="mcp_dcr"),
    path("identity/o/api/token", oauth.token_view, name="mcp_token"),
]
