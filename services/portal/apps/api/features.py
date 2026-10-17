"""Per-workspace feature flags, collected from each Nexus app's ``features.py``.

    # apps/<app>/features.py
    FEATURES = {"integrations": lambda workspace, plan, org: plan.entitlement("...") and ...}

Each function receives the workspace, its effective billing plan and its
``crm.OrgSettings`` row (or ``None``) and returns a bool. The SPA hides or shows areas from
these flags (``GET /api/v1/workspaces/<id>``), but the API checks them again on every call
(``@api_endpoint(feature=...)``).
"""

from __future__ import annotations

from apps.core.extensions import nexus_modules


def workspace_features(workspace) -> dict[str, bool]:
    from apps.billing.services import workspace_plan
    from apps.crm.models import OrgSettings

    plan = workspace_plan(workspace)
    org = OrgSettings.objects.filter(workspace=workspace).first()
    flags: dict[str, bool] = {}
    for _app, module in nexus_modules("features"):
        for key, fn in getattr(module, "FEATURES", {}).items():
            flags[key] = bool(fn(workspace, plan, org))
    return flags
