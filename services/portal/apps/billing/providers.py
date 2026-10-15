"""Payment provider abstraction.

* ``none``   — no payments. Free plan works; paid plans show as unavailable.
* ``manual`` — operators assign plans in the admin console (e.g. invoiced
  enterprise customers). No money moves through Lumen.
* ``stripe`` — Stripe Checkout + Billing Portal + signed webhooks.

Subscriptions only change state from a verified provider webhook (or an
explicit, audited operator action). A browser returning from checkout never
upgrades anything by itself.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import UTC, datetime

from django.conf import settings
from django.db import IntegrityError, transaction
from django.urls import reverse

from .models import BillingAction, Invoice, Plan, Subscription, WebhookEvent
from .services import ensure_subscription, mark_paid, mark_payment_failed

log = logging.getLogger(__name__)
S = Subscription.Status


class BillingUnavailable(Exception):
    pass


class WebhookRejected(Exception):
    pass


@dataclass
class WebhookResult:
    status: int
    outcome: str
    detail: str = ""


class BaseProvider:
    name = "none"
    label = "No payment provider"

    def is_configured(self) -> bool:
        return False

    def can_checkout(self, plan: Plan, interval: str) -> bool:
        return False

    def start_checkout(self, *, workspace, plan: Plan, interval: str, user) -> str:
        raise BillingUnavailable("Online payments are not enabled on this server.")

    def customer_portal_url(self, *, workspace, user) -> str | None:
        return None

    def reconcile(self, subscription: Subscription) -> bool:
        return False


class NoneProvider(BaseProvider):
    pass


class ManualProvider(BaseProvider):
    name = "manual"
    label = "Manual billing (operator assigned)"

    def is_configured(self) -> bool:
        return True


def _ts(value) -> datetime | None:
    if not value:
        return None
    return datetime.fromtimestamp(int(value), tz=UTC)


_STRIPE_STATUS = {
    "active": S.ACTIVE,
    "trialing": S.TRIALING,
    "past_due": S.PAST_DUE,
    "unpaid": S.UNPAID,
    "canceled": S.CANCELED,
    "incomplete": S.INCOMPLETE,
    "incomplete_expired": S.CANCELED,
    "paused": S.UNPAID,
}


class StripeProvider(BaseProvider):
    name = "stripe"
    label = "Stripe"

    def __init__(self):
        self._client = None

    def is_configured(self) -> bool:
        return bool(settings.STRIPE_SECRET_KEY and settings.STRIPE_WEBHOOK_SECRET)

    @property
    def client(self):
        if not self.is_configured():
            raise BillingUnavailable("Stripe is selected but its keys are not configured.")
        if self._client is None:
            import stripe

            self._client = stripe.StripeClient(settings.STRIPE_SECRET_KEY, max_network_retries=2)
        return self._client

    def can_checkout(self, plan: Plan, interval: str) -> bool:
        return self.is_configured() and plan.self_serve and not plan.is_free and bool(plan.stripe_price_for(interval))

    def _ensure_customer(self, sub: Subscription, user) -> str:
        if sub.provider_customer_id:
            return sub.provider_customer_id
        customer = self.client.v1.customers.create(
            params={
                "email": user.email,
                "name": sub.workspace.name,
                "metadata": {"workspace_id": str(sub.workspace_id)},
            }
        )
        sub.provider_customer_id = customer.id
        sub.save(update_fields=["provider_customer_id", "updated_at"])
        return customer.id

    def start_checkout(self, *, workspace, plan: Plan, interval: str, user) -> str:
        if not self.can_checkout(plan, interval):
            raise BillingUnavailable("This plan cannot be purchased online.")
        sub = ensure_subscription(workspace)
        customer_id = self._ensure_customer(sub, user)
        base = settings.PUBLIC_BASE_URL + reverse("portal:workspace_billing", args=[workspace.pk])
        session = self.client.v1.checkout.sessions.create(
            params={
                "mode": "subscription",
                "customer": customer_id,
                "client_reference_id": str(workspace.pk),
                "line_items": [{"price": plan.stripe_price_for(interval), "quantity": 1}],
                "success_url": f"{base}?checkout=returned",
                "cancel_url": f"{base}?checkout=canceled",
                "metadata": {"workspace_id": str(workspace.pk), "plan_code": plan.code},
                "subscription_data": {"metadata": {"workspace_id": str(workspace.pk), "plan_code": plan.code}},
                "allow_promotion_codes": True,
            }
        )
        BillingAction.objects.create(
            workspace=workspace, user=user, action="checkout_started", detail={"plan": plan.code, "interval": interval}
        )
        return session.url

    def customer_portal_url(self, *, workspace, user) -> str | None:
        sub = ensure_subscription(workspace)
        if not sub.provider_customer_id or not self.is_configured():
            return None
        session = self.client.v1.billing_portal.sessions.create(
            params={
                "customer": sub.provider_customer_id,
                "return_url": settings.PUBLIC_BASE_URL + reverse("portal:workspace_billing", args=[workspace.pk]),
            }
        )
        BillingAction.objects.create(workspace=workspace, user=user, action="billing_portal_opened")
        return session.url

    # --- webhooks --------------------------------------------------------------

    def verify(self, payload: bytes, signature: str | None):
        import stripe

        if not self.is_configured():
            raise WebhookRejected("stripe not configured")
        try:
            return stripe.Webhook.construct_event(payload, signature, settings.STRIPE_WEBHOOK_SECRET, tolerance=300)
        except (ValueError, stripe.SignatureVerificationError) as exc:
            raise WebhookRejected(type(exc).__name__) from exc

    def handle_webhook(self, payload: bytes, signature: str | None) -> WebhookResult:
        try:
            event = self.verify(payload, signature)
        except WebhookRejected as exc:
            WebhookEvent.objects.create(provider="stripe", event_id="", outcome="rejected", error=str(exc)[:300])
            return WebhookResult(400, "rejected", str(exc))
        obj = event["data"]["object"]
        try:
            with transaction.atomic():
                record = WebhookEvent.objects.create(
                    provider="stripe",
                    event_id=event["id"],
                    event_type=event["type"],
                    object_id=str(obj.get("id", ""))[:120],
                    outcome=WebhookEvent.Outcome.PROCESSED,
                )
        except IntegrityError:
            return WebhookResult(200, "duplicate")
        try:
            with transaction.atomic():
                handled = self._dispatch(event["type"], obj)
            if not handled:
                record.outcome = WebhookEvent.Outcome.IGNORED
                record.save(update_fields=["outcome"])
            return WebhookResult(200, record.outcome)
        except Exception as exc:  # noqa: BLE001 - record and let Stripe retry
            log.exception("Stripe webhook %s failed", event["type"])
            record.outcome = WebhookEvent.Outcome.FAILED
            record.error = f"{type(exc).__name__}: {exc}"[:300]
            record.save(update_fields=["outcome", "error"])
            # Allow a retry by removing the idempotency marker's success meaning:
            # failed events are retried by Stripe and re-processed below.
            WebhookEvent.objects.filter(pk=record.pk).update(event_id=f"failed:{record.pk}:{event['id']}"[:120])
            return WebhookResult(500, "failed", str(exc))

    def _find_subscription(self, obj) -> Subscription | None:
        meta = obj.get("metadata") or {}
        ws_id = meta.get("workspace_id")
        if ws_id:
            sub = Subscription.objects.filter(workspace_id=ws_id).select_related("workspace").first()
            if sub:
                return sub
            from apps.workspaces.models import Workspace

            ws = Workspace.objects.filter(pk=ws_id).first()
            if ws:
                return ensure_subscription(ws)
        sub_id = obj.get("subscription") if obj.get("object") != "subscription" else obj.get("id")
        if isinstance(sub_id, dict):
            sub_id = sub_id.get("id")
        if sub_id:
            found = Subscription.objects.filter(provider_subscription_id=sub_id).first()
            if found:
                return found
        customer = obj.get("customer")
        if isinstance(customer, dict):
            customer = customer.get("id")
        if customer:
            return Subscription.objects.filter(provider_customer_id=customer).first()
        return None

    def _dispatch(self, event_type: str, obj) -> bool:
        if event_type == "checkout.session.completed":
            sub = self._find_subscription(obj)
            if sub is None:
                return False
            sub.provider = Subscription.Provider.STRIPE
            if obj.get("customer"):
                sub.provider_customer_id = obj["customer"]
            if obj.get("subscription"):
                sub.provider_subscription_id = obj["subscription"]
            sub.save()
            return True
        if event_type in {"customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted"}:
            sub = self._find_subscription(obj)
            if sub is None:
                return False
            self.apply_subscription_object(sub, obj, deleted=event_type.endswith("deleted"))
            return True
        if event_type in {"invoice.paid", "invoice.payment_succeeded", "invoice.payment_failed", "invoice.finalized"}:
            sub = self._find_subscription(obj)
            if sub is None:
                return False
            self._upsert_invoice(sub, obj)
            if event_type in {"invoice.paid", "invoice.payment_succeeded"}:
                mark_paid(sub)
            elif event_type == "invoice.payment_failed":
                mark_payment_failed(sub)
            return True
        return False

    def apply_subscription_object(self, sub: Subscription, obj, *, deleted: bool = False) -> None:
        items = ((obj.get("items") or {}).get("data")) or []
        price_id = ""
        period_end = obj.get("current_period_end")
        if items:
            price = items[0].get("price") or {}
            price_id = price.get("id", "")
            interval = (price.get("recurring") or {}).get("interval")
            if interval in {"month", "year"}:
                sub.interval = interval
            period_end = period_end or items[0].get("current_period_end")
        plan = None
        if price_id:
            plan = Plan.objects.filter(stripe_price_monthly=price_id).first() or Plan.objects.filter(
                stripe_price_yearly=price_id
            ).first()
        if plan is not None:
            sub.plan = plan
        elif price_id:
            log.warning("Stripe price %s does not match any plan; keeping plan %s", price_id, sub.plan.code)
        status = _STRIPE_STATUS.get(obj.get("status", ""), S.INCOMPLETE)
        if deleted:
            status = S.CANCELED
        previous = sub.status
        sub.provider = Subscription.Provider.STRIPE
        sub.provider_subscription_id = obj.get("id", sub.provider_subscription_id)
        customer = obj.get("customer")
        if isinstance(customer, str):
            sub.provider_customer_id = customer
        sub.status = status
        sub.cancel_at_period_end = bool(obj.get("cancel_at_period_end"))
        sub.current_period_end = _ts(period_end)
        if status == S.PAST_DUE and previous != S.PAST_DUE:
            from datetime import timedelta

            from django.utils import timezone

            sub.grace_until = timezone.now() + timedelta(days=settings.BILLING_GRACE_DAYS)
        elif status in {S.ACTIVE, S.TRIALING}:
            sub.grace_until = None
        if status == S.CANCELED and obj.get("canceled_at"):
            sub.canceled_at = _ts(obj.get("canceled_at"))
        sub.save()

    def _upsert_invoice(self, sub: Subscription, obj) -> None:
        if not obj.get("id"):
            return
        Invoice.objects.update_or_create(
            provider_invoice_id=obj["id"],
            defaults={
                "subscription": sub,
                "number": obj.get("number") or "",
                "status": obj.get("status") or "",
                "currency": (obj.get("currency") or settings.BILLING_CURRENCY)[:3],
                "amount_due": int(obj.get("amount_due") or 0),
                "amount_paid": int(obj.get("amount_paid") or 0),
                "hosted_url": obj.get("hosted_invoice_url") or "",
                "period_start": _ts(obj.get("period_start")),
                "period_end": _ts(obj.get("period_end")),
            },
        )

    def reconcile(self, subscription: Subscription) -> bool:
        if not subscription.provider_subscription_id or not self.is_configured():
            return False
        obj = self.client.v1.subscriptions.retrieve(subscription.provider_subscription_id)
        self.apply_subscription_object(subscription, obj.to_dict() if hasattr(obj, "to_dict") else dict(obj))
        from django.utils import timezone

        subscription.last_reconciled_at = timezone.now()
        subscription.save(update_fields=["last_reconciled_at"])
        return True


def get_provider() -> BaseProvider:
    name = settings.BILLING_PROVIDER
    if name == "stripe":
        return StripeProvider()
    if name == "manual":
        return ManualProvider()
    return NoneProvider()
