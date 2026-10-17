"""Workspace feature flags of this app: {key: fn(workspace, plan, org_settings) -> bool}.

Automation and in-app notifications come with the business workspace (the ``crm`` flag);
their actions are internal only in this phase."""

from apps.crm.features import crm


def automation(workspace, plan, org) -> bool:
    return crm(workspace, plan, org)


FEATURES: dict = {
    "automation": automation,
    "notifications": automation,
}
