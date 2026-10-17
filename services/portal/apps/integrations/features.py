"""Workspace feature flags of this app: {key: fn(workspace, plan, org_settings) -> bool}."""

from __future__ import annotations


def integrations(workspace, plan, org) -> bool:
    # The inbox and integrations are part of the business workspace (CRM enabled).
    from apps.crm.features import crm

    return crm(workspace, plan, org)


FEATURES = {"integrations": integrations}
