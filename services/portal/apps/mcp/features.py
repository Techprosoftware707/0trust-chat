"""Workspace feature flag of the MCP connector (see apps.api.features)."""

from __future__ import annotations

from django.conf import settings


def mcp(workspace, plan, org) -> bool:
    """On when the installation enabled the connector (NEXUS_MCP_ENABLED), the workspace is a
    business workspace and an owner/admin allowed it (AISettings.mcp_enabled, off by default)."""
    if not settings.NEXUS_MCP_ENABLED:
        return False
    from apps.assistant.models import AISettings
    from apps.crm.features import crm

    if not crm(workspace, plan, org):
        return False
    row = AISettings.objects.filter(workspace=workspace).only("mcp_enabled").first()
    return bool(row and row.mcp_enabled)


FEATURES = {"mcp": mcp}
