"""Billing: lifecycle, entitlement resolution and Stripe webhook handling.

Webhook tests sign payloads with Stripe's documented scheme
(HMAC-SHA256 over "<timestamp>.<payload>" with the endpoint secret) so the real
verification code path in the official `stripe` library is exercised. No
network calls are made and no fake provider responses are used.
"""

import hashlib
import hmac
import json
import time
from datetime import timedelta

import pytest
from django.test import Client
from django.utils import timezone
from hypothesis import HealthCheck, given, settings as hsettings, strategies as st

from apps.billing.models import Plan, Subscription, WebhookEvent
from apps.billing.services import effective_plan, ensure_subscription, mark_payment_failed, run_lifecycle, user_entitlements
from apps.workspaces import services as ws_services

from .factories import ensure_plans, make_user

pytestmark = pytest.mark.django_db
SECRET = "whsec_test_secret_for_unit_tests"
S = Subscription.Status


@pytest.fixture(autouse=True)
def plans():
    ensure_plans()
    Plan.objects.filter(code="pro").update(stripe_price_monthly="price_pro_m", stripe_price_yearly="price_pro_y")


def sign(payload: bytes, secret=SECRET, ts=None) -> str:
    ts = ts or int(time.time())
    sig = hmac.new(secret.encode(), f"{ts}.".encode() + payload, hashlib.sha256).hexdigest()
    return f"t={ts},v1={sig}"


def event(etype, obj, eid=None):
    return json.dumps({"id": eid or f"evt_{time.time_ns()}", "object": "event", "type": etype, "data": {"object": obj}, "api_version": "2025-09-30"}).encode()


def post(payload, sig):
    return Client().post("/billing/webhooks/stripe/", payload, content_type="application/json", HTTP_STRIPE_SIGNATURE=sig)


@pytest.fixture
def stripe_settings(settings):
    settings.BILLING_PROVIDER = "stripe"
    settings.STRIPE_SECRET_KEY = "sk_test_unit"
    settings.STRIPE_WEBHOOK_SECRET = SECRET


def workspace():
    owner = make_user()
    return ws_services.create_workspace(owner, "Paying Co")


def sub_obj(ws, status="active", price="price_pro_m", period_end=None, cancel=False):
    return {
        "id": "sub_123",
        "object": "subscription",
        "customer": "cus_123",
        "status": status,
        "cancel_at_period_end": cancel,
        "metadata": {"workspace_id": str(ws.pk)},
        "items": {"data": [{"price": {"id": price, "recurring": {"interval": "month"}}, "current_period_end": period_end or int(time.time()) + 30 * 86400}]},
    }


class TestLifecycle:
    def test_free_by_default(self):
        ws = workspace()
        assert effective_plan(ensure_subscription(ws)).code == "free"

    def test_past_due_grace_then_free(self):
        ws = workspace()
        sub = ensure_subscription(ws)
        sub.plan = Plan.objects.get(code="pro"); sub.status = S.ACTIVE; sub.provider = "stripe"; sub.save()
        mark_payment_failed(sub)
        sub.refresh_from_db()
        assert sub.status == S.PAST_DUE and sub.grace_until > timezone.now()
        assert effective_plan(sub).code == "pro"
        Subscription.objects.filter(pk=sub.pk).update(grace_until=timezone.now() - timedelta(seconds=1))
        run_lifecycle()
        sub.refresh_from_db()
        assert sub.status == S.UNPAID and effective_plan(sub).code == "free"

    def test_cancel_at_period_end(self):
        ws = workspace()
        sub = ensure_subscription(ws)
        sub.plan = Plan.objects.get(code="pro"); sub.status = S.ACTIVE; sub.cancel_at_period_end = True
        sub.current_period_end = timezone.now() - timedelta(minutes=1); sub.save()
        run_lifecycle()
        sub.refresh_from_db()
        assert sub.status == S.CANCELED and effective_plan(sub).code == "free"

    def test_user_entitlements_best_of_memberships(self):
        ws = workspace()
        member = make_user()
        from apps.workspaces.models import Membership

        Membership.objects.create(workspace=ws, user=member)
        assert user_entitlements(member).upload_max_mb == Plan.objects.get(code="free").entitlement("upload_max_mb")
        sub = ensure_subscription(ws)
        sub.plan = Plan.objects.get(code="pro"); sub.status = S.ACTIVE; sub.save()
        assert user_entitlements(member).upload_max_mb == Plan.objects.get(code="pro").entitlement("upload_max_mb")


@pytest.mark.usefixtures("stripe_settings")
class TestStripeWebhooks:
    def test_rejects_bad_signature(self):
        ws = workspace()
        payload = event("customer.subscription.updated", sub_obj(ws))
        r = post(payload, sign(payload, secret="whsec_wrong"))
        assert r.status_code == 400
        assert WebhookEvent.objects.filter(outcome="rejected").exists()
        assert effective_plan(ensure_subscription(ws)).code == "free"

    def test_rejects_missing_and_stale_signature(self):
        ws = workspace()
        payload = event("customer.subscription.updated", sub_obj(ws))
        assert post(payload, "").status_code == 400
        assert post(payload, sign(payload, ts=int(time.time()) - 3600)).status_code == 400  # replay outside tolerance

    def test_rejects_tampered_payload(self):
        ws = workspace()
        payload = event("customer.subscription.updated", sub_obj(ws))
        sig = sign(payload)
        tampered = payload.replace(b"price_pro_m", b"price_xxx_m")
        assert post(tampered, sig).status_code == 400

    def test_subscription_activation_and_idempotency(self):
        ws = workspace()
        payload = event("customer.subscription.created", sub_obj(ws), eid="evt_once")
        assert post(payload, sign(payload)).status_code == 200
        sub = Subscription.objects.get(workspace=ws)
        assert sub.status == S.ACTIVE and sub.plan.code == "pro" and sub.provider == "stripe"
        assert sub.provider_subscription_id == "sub_123" and sub.current_period_end
        r = post(payload, sign(payload))
        assert r.status_code == 200 and r.json()["outcome"] == "duplicate"
        assert WebhookEvent.objects.filter(event_id="evt_once").count() == 1

    def test_payment_failed_then_paid(self):
        ws = workspace()
        p = event("customer.subscription.created", sub_obj(ws))
        post(p, sign(p))
        inv = {"id": "in_1", "object": "invoice", "customer": "cus_123", "subscription": "sub_123", "status": "open", "currency": "usd", "amount_due": 600, "amount_paid": 0}
        p = event("invoice.payment_failed", inv)
        post(p, sign(p))
        sub = Subscription.objects.get(workspace=ws)
        assert sub.status == S.PAST_DUE and sub.grace_until
        inv.update(status="paid", amount_paid=600)
        p = event("invoice.paid", inv)
        post(p, sign(p))
        sub.refresh_from_db()
        assert sub.status == S.ACTIVE and sub.grace_until is None
        assert sub.invoices.get(provider_invoice_id="in_1").amount_paid == 600

    def test_deleted_subscription_falls_back_to_free(self):
        ws = workspace()
        p = event("customer.subscription.created", sub_obj(ws))
        post(p, sign(p))
        p = event("customer.subscription.deleted", sub_obj(ws, status="canceled"))
        post(p, sign(p))
        sub = Subscription.objects.get(workspace=ws)
        assert sub.status == S.CANCELED and effective_plan(sub).code == "free"

    def test_unknown_workspace_ignored(self):
        obj = sub_obj(workspace())
        obj["metadata"] = {"workspace_id": "00000000-0000-0000-0000-000000000000"}
        obj["customer"] = "cus_unknown"; obj["id"] = "sub_unknown"
        p = event("customer.subscription.updated", obj)
        r = post(p, sign(p))
        assert r.status_code == 200 and r.json()["outcome"] == "ignored"

    @hsettings(max_examples=60, deadline=None, suppress_health_check=[HealthCheck.function_scoped_fixture])
    @given(st.dictionaries(st.text(max_size=12), st.one_of(st.none(), st.integers(), st.text(max_size=20), st.booleans()), max_size=8),
           st.sampled_from(["customer.subscription.updated", "invoice.paid", "checkout.session.completed", "invoice.payment_failed", "x.y"]))
    def test_fuzz_signed_garbage_never_500s_silently(self, obj, etype):
        """Validly signed but malformed objects are either ignored or recorded as failed."""
        p = event(etype, obj)
        r = post(p, sign(p))
        assert r.status_code in (200, 500)
        if r.status_code == 500:
            assert WebhookEvent.objects.filter(outcome="failed").exists()


class TestNoProvider:
    def test_webhook_endpoint_disabled_without_stripe(self):
        assert Client().post("/billing/webhooks/stripe/", b"{}", content_type="application/json").status_code == 404

    def test_checkout_unavailable_message(self):
        ws = workspace()
        owner = ws.memberships.get().user
        c = Client(); c.force_login(owner)
        r = c.post(f"/portal/workspaces/{ws.pk}/billing/checkout/", {"plan": "pro", "interval": "month"}, follow=True)
        assert "not enabled" in r.content.decode() or "cannot be purchased" in r.content.decode()
        assert effective_plan(ensure_subscription(ws)).code == "free"
