"""Workspace features owned by the CRM app (see apps.api.features)."""

from __future__ import annotations


def _profiles(org) -> set[str]:
    return set(org.business_profiles or []) if org is not None else set()


def crm(workspace, plan, org) -> bool:
    # A workspace becomes a business workspace when an owner/admin picks at least one
    # business profile and the plan includes it.
    return bool(_profiles(org)) and plan.entitlement("crm_enabled")


def real_estate(workspace, plan, org) -> bool:
    return crm(workspace, plan, org) and "real_estate" in _profiles(org) and plan.entitlement("vertical_profiles")


def lending(workspace, plan, org) -> bool:
    return crm(workspace, plan, org) and "lending" in _profiles(org) and plan.entitlement("vertical_profiles")


def save_to_record(workspace, plan, org) -> bool:
    # Policy toggle for the (later) user-initiated "Save to record" action: off by default.
    return crm(workspace, plan, org) and bool(org.save_to_record_enabled)


FEATURES = {
    "crm": crm,
    "real_estate": real_estate,
    "lending": lending,
    "save_to_record": save_to_record,
}
