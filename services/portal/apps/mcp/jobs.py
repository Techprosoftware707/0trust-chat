"""Background jobs of the MCP connector (run by manage.py lumen_worker)."""

from __future__ import annotations

from datetime import timedelta

from django.conf import settings
from django.utils import timezone


def cleanup_registrations() -> int:
    """Deletes dynamically registered clients that never obtained a token within
    NEXUS_MCP_DCR_UNUSED_DAYS, and those whose last token expired that long ago."""
    from allauth.idp.oidc.models import Client, Token

    from .models import McpGrant
    from .oauth import unused_dcr_clients

    cutoff = timezone.now() - timedelta(days=settings.NEXUS_MCP_DCR_UNUSED_DAYS)
    n, _ = unused_dcr_clients().filter(created_at__lt=cutoff).delete()
    live = Token.objects.filter(expires_at__gt=cutoff).values("client_id")
    idle = Client.objects.filter(data__dcr=True, data__mcp=True, created_at__lt=cutoff).exclude(pk__in=live)
    idle = idle.exclude(pk__in=McpGrant.objects.filter(last_used_at__gt=cutoff).values("client_id"))
    m, _ = idle.delete()
    return n + m


def purge_rotated_refresh_tokens() -> int:
    from .models import RotatedRefreshToken

    n, _ = RotatedRefreshToken.objects.filter(expires_at__lt=timezone.now()).delete()
    return n


def purge_idle_grants() -> int:
    """Connections without any valid token for longer than the refresh lifetime."""
    from allauth.idp.oidc.models import Token

    from .models import McpGrant

    cutoff = timezone.now() - timedelta(seconds=settings.NEXUS_MCP_REFRESH_TOKEN_SECONDS) - timedelta(days=1)
    removed = 0
    for grant in McpGrant.objects.filter(updated_at__lt=cutoff).select_related("client"):
        if not Token.objects.filter(user_id=grant.user_id, client_id=grant.client_id, expires_at__gt=timezone.now()).exists():
            grant.delete()
            removed += 1
    return removed


JOBS = [
    ("cleanup_registrations", 3600, cleanup_registrations),
    ("purge_rotated_refresh_tokens", 3600, purge_rotated_refresh_tokens),
    ("purge_idle_grants", 6 * 3600, purge_idle_grants),
]
