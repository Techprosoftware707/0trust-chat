"""Workspace feature flags of the AI assistant (see apps.api.features)."""

from __future__ import annotations


def assistant(workspace, plan, org) -> bool:
    from apps.crm.features import crm

    from .models import AISettings

    if not crm(workspace, plan, org):
        return False
    row = AISettings.objects.filter(workspace=workspace).only("assistant_enabled").first()
    return row.assistant_enabled if row is not None else AISettings._meta.get_field("assistant_enabled").default


FEATURES = {"assistant": assistant}
