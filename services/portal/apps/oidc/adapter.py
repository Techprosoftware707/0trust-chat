from __future__ import annotations

from allauth.idp.oidc.adapter import DefaultOIDCAdapter
from django.conf import settings
from django.contrib.auth import get_user_model
from django.core.exceptions import ValidationError


class LumenOIDCAdapter(DefaultOIDCAdapter):
    """OIDC provider adapter used by the homeserver's SSO login.

    * ``iss`` is the public portal origin regardless of how the request
      arrived.
    * ``sub`` is the user's random ``public_id`` (stable, not enumerable).
    * ``preferred_username`` is the immutable Matrix localpart.
    """

    def get_issuer(self) -> str:
        return settings.PUBLIC_BASE_URL.rstrip("/")

    def get_user_sub(self, client, user) -> str:
        return str(user.public_id)

    def get_user_by_sub(self, client, sub: str):
        User = get_user_model()
        try:
            return User.objects.get(public_id=sub)
        except (User.DoesNotExist, ValueError, ValidationError):
            return None

    scope_display = {
        **DefaultOIDCAdapter.scope_display,
        "mcp:read": "Read the business records you can see (contacts, deals, tasks, calendar, timeline)",
        "mcp:write": "Prepare changes (tasks, notes, contact fields, deal stages) that you confirm in Nexus before they happen",
    }

    def populate_server_metadata(self, data):
        """RFC 8414 / MCP additions (iss parameter, PKCE, registration, CIMD, MCP scopes)."""
        from apps.mcp.oauth import extend_server_metadata

        extend_server_metadata(data)

    def validate_resource_uris(self, *, uris, **kwargs):
        """RFC 8707: only this portal's own protected resources can be requested."""
        from apps.mcp.oauth import canonical

        known = {canonical(settings.NEXUS_API_RESOURCE)}
        if settings.NEXUS_MCP_ENABLED:
            known.add(canonical(settings.NEXUS_MCP_RESOURCE))
        for uri in uris:
            if canonical(uri) not in known:
                raise ValidationError("Unknown resource.")

    def get_claims(self, purpose, user, client, scopes, email=None, **kwargs):
        claims = super().get_claims(purpose, user, client, scopes, email=email, **kwargs)
        if "profile" in scopes:
            claims["preferred_username"] = user.username
            claims["name"] = user.display_name or user.username
        return claims
