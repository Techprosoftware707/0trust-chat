"""Plan resolution, entitlements and subscription lifecycle.

All entitlement decisions are made here, server-side. Templates only display
the results; they never decide access.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta
from pathlib import Path

import yaml
from django.conf import settings
from django.db import transaction
from django.utils import timezone

from .models import ENTITLEMENT_FIELDS, Plan, Subscription

S = Subscription.Status
PAID_ACCESS_STATES = {S.ACTIVE, S.TRIALING}


class EntitlementError(Exception):
    """Raised when an action would exceed the workspace's plan."""

    def __init__(self, message: str, *, key: str = ""):
        super().__init__(message)
        self.key = key


def free_plan() -> Plan:
    plan = Plan.objects.filter(is_free=True, active=True).order_by("sort_order").first()
    if plan is None:
        raise RuntimeError("No active free plan configured; run `manage.py lumen_bootstrap`.")
    return plan


def effective_plan(subscription: Subscription | None) -> Plan:
    """The plan whose entitlements apply right now.

    * active / trialing                          -> subscribed plan
    * past_due while inside the grace period     -> subscribed plan
    * anything else (unpaid, canceled, incomplete, grace expired) -> free plan

    Data is never deleted on downgrade; only limits change.
    """
    if subscription is None:
        return free_plan()
    if subscription.plan.is_free:
        return subscription.plan
    if subscription.status in PAID_ACCESS_STATES:
        return subscription.plan
    if subscription.status == S.PAST_DUE:
        if subscription.grace_until is None or subscription.grace_until > timezone.now():
            return subscription.plan
    return free_plan()


def workspace_plan(workspace) -> Plan:
    try:
        sub = workspace.subscription
    except Subscription.DoesNotExist:
        sub = None
    return effective_plan(sub)


@dataclass
class UserEntitlements:
    upload_max_mb: int
    media_quota_mb_30d: int
    priority_support: bool
    source_plan: str


def user_entitlements(user) -> UserEntitlements:
    """Best entitlements across the workspaces the user belongs to."""
    from apps.workspaces.models import Membership

    plans = [free_plan()]
    memberships = Membership.objects.filter(user=user).select_related("workspace__subscription__plan")
    for m in memberships:
        plans.append(workspace_plan(m.workspace))
    best_upload = max(plans, key=lambda p: p.entitlement("upload_max_mb"))
    best_quota = max(plans, key=lambda p: p.entitlement("media_quota_mb_30d"))
    return UserEntitlements(
        upload_max_mb=best_upload.entitlement("upload_max_mb"),
        media_quota_mb_30d=best_quota.entitlement("media_quota_mb_30d"),
        priority_support=any(p.entitlement("priority_support") for p in plans),
        source_plan=best_upload.code,
    )


def validate_entitlements(data: dict) -> dict:
    clean: dict = {}
    for key, cast in ENTITLEMENT_FIELDS.items():
        if key not in data:
            raise ValueError(f"missing entitlement {key}")
        value = data[key]
        if cast is bool:
            if not isinstance(value, bool):
                raise ValueError(f"{key} must be true/false")
        else:
            if isinstance(value, bool) or not isinstance(value, int) or value < 0 or value > 10_000_000:
                raise ValueError(f"{key} must be a non-negative integer")
        clean[key] = value
    return clean


def seed_plans(path: Path | None = None) -> list[str]:
    """Create plans from the YAML catalogue if their code does not exist yet."""
    path = path or settings.PLANS_FILE
    data = yaml.safe_load(Path(path).read_text(encoding="utf-8")) or {}
    created = []
    for entry in data.get("plans", []):
        code = entry["code"]
        if Plan.objects.filter(code=code).exists():
            continue
        Plan.objects.create(
            code=code,
            name=entry["name"],
            tagline=entry.get("tagline", ""),
            is_free=bool(entry.get("is_free", False)),
            self_serve=bool(entry.get("self_serve", True)),
            is_public=bool(entry.get("is_public", True)),
            price_monthly_cents=entry.get("price_monthly_cents"),
            price_yearly_cents=entry.get("price_yearly_cents"),
            currency=entry.get("currency", settings.BILLING_CURRENCY),
            stripe_price_monthly=entry.get("stripe_price_monthly", "") or "",
            stripe_price_yearly=entry.get("stripe_price_yearly", "") or "",
            entitlements=validate_entitlements(entry.get("entitlements", {})),
            features=list(entry.get("features", [])),
            sort_order=int(entry.get("sort_order", 100)),
        )
        created.append(code)
    return created


def ensure_subscription(workspace) -> Subscription:
    try:
        return workspace.subscription
    except Subscription.DoesNotExist:
        return Subscription.objects.create(workspace=workspace, plan=free_plan(), status=S.FREE)


# --- Lifecycle transitions ------------------------------------------------------


@transaction.atomic
def mark_payment_failed(subscription: Subscription) -> None:
    subscription = Subscription.objects.select_for_update().get(pk=subscription.pk)
    if subscription.status != S.PAST_DUE:
        subscription.status = S.PAST_DUE
        subscription.grace_until = timezone.now() + timedelta(days=settings.BILLING_GRACE_DAYS)
        subscription.save(update_fields=["status", "grace_until", "updated_at"])


@transaction.atomic
def mark_paid(subscription: Subscription) -> None:
    subscription = Subscription.objects.select_for_update().get(pk=subscription.pk)
    if subscription.status in {S.PAST_DUE, S.UNPAID, S.INCOMPLETE}:
        subscription.status = S.ACTIVE
        subscription.grace_until = None
        subscription.save(update_fields=["status", "grace_until", "updated_at"])


def assign_manual_plan(workspace, plan: Plan, *, note: str = "", period_end=None) -> Subscription:
    sub = ensure_subscription(workspace)
    sub.plan = plan
    sub.provider = Subscription.Provider.MANUAL if not plan.is_free else Subscription.Provider.NONE
    sub.status = S.FREE if plan.is_free else S.ACTIVE
    sub.current_period_end = period_end
    sub.cancel_at_period_end = False
    sub.grace_until = None
    sub.manual_note = note[:300]
    sub.save()
    return sub


def run_lifecycle(now=None) -> dict[str, int]:
    """Periodic job: expire grace periods and finish scheduled cancellations.

    Manual subscriptions with an end date also expire. Returns counters.
    """
    now = now or timezone.now()
    counters = {"grace_expired": 0, "period_ended": 0, "manual_expired": 0}
    for sub in Subscription.objects.filter(status=S.PAST_DUE, grace_until__lte=now):
        sub.status = S.UNPAID
        sub.save(update_fields=["status", "updated_at"])
        counters["grace_expired"] += 1
    for sub in Subscription.objects.filter(cancel_at_period_end=True, current_period_end__lte=now).exclude(status=S.CANCELED):
        sub.status = S.CANCELED
        sub.canceled_at = now
        sub.save(update_fields=["status", "canceled_at", "updated_at"])
        counters["period_ended"] += 1
    for sub in Subscription.objects.filter(
        provider=Subscription.Provider.MANUAL, status=S.ACTIVE, current_period_end__isnull=False, current_period_end__lte=now
    ):
        sub.status = S.CANCELED
        sub.canceled_at = now
        sub.save(update_fields=["status", "canceled_at", "updated_at"])
        counters["manual_expired"] += 1
    return counters
