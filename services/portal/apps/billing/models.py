from __future__ import annotations

from django.conf import settings
from django.db import models
from django.utils import timezone

ENTITLEMENT_FIELDS: dict[str, type] = {
    "max_members": int,
    "max_pending_invites": int,
    "upload_max_mb": int,
    "media_quota_mb_30d": int,
    "can_require_mfa": bool,
    "priority_support": bool,
    # Nexus business workspace (apps.crm): contacts, pipelines, tasks, timeline, calendar.
    "crm_enabled": bool,
    "crm_max_contacts": int,
    # Real-estate and lending business profiles (vertical workflows).
    "vertical_profiles": bool,
}

ENTITLEMENT_LABELS = {
    "max_members": "Members per workspace",
    "max_pending_invites": "Open invitations",
    "upload_max_mb": "Largest file (MB)",
    "media_quota_mb_30d": "Uploads per member / 30 days (MB)",
    "can_require_mfa": "Can require MFA for members",
    "priority_support": "Priority support",
    "crm_enabled": "Business workspace (CRM, pipelines, tasks)",
    "crm_max_contacts": "Contacts per workspace",
    "vertical_profiles": "Real-estate and lending profiles",
}


class Plan(models.Model):
    code = models.SlugField(max_length=40, unique=True)
    name = models.CharField(max_length=80)
    tagline = models.CharField(max_length=200, blank=True)
    is_free = models.BooleanField(default=False)
    self_serve = models.BooleanField(default=True, help_text="Purchasable through checkout")
    is_public = models.BooleanField(default=True, help_text="Shown on the pricing page")
    active = models.BooleanField(default=True)
    price_monthly_cents = models.IntegerField(null=True, blank=True)
    price_yearly_cents = models.IntegerField(null=True, blank=True)
    currency = models.CharField(max_length=3, default="usd")
    stripe_price_monthly = models.CharField(max_length=100, blank=True)
    stripe_price_yearly = models.CharField(max_length=100, blank=True)
    entitlements = models.JSONField(default=dict)
    features = models.JSONField(default=list, blank=True)
    sort_order = models.IntegerField(default=100)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["sort_order", "id"]

    def __str__(self) -> str:
        return self.name

    def entitlement(self, key: str):
        cast = ENTITLEMENT_FIELDS[key]
        value = self.entitlements.get(key)
        if value is None:
            return False if cast is bool else 0
        return cast(value)

    def stripe_price_for(self, interval: str) -> str:
        return self.stripe_price_yearly if interval == "year" else self.stripe_price_monthly

    @property
    def contact_sales(self) -> bool:
        return self.price_monthly_cents is None and not self.is_free


class Subscription(models.Model):
    class Status(models.TextChoices):
        FREE = "free", "Free"
        TRIALING = "trialing", "Trial"
        ACTIVE = "active", "Active"
        PAST_DUE = "past_due", "Payment failed (grace period)"
        UNPAID = "unpaid", "Unpaid"
        CANCELED = "canceled", "Canceled"
        INCOMPLETE = "incomplete", "Awaiting first payment"

    class Provider(models.TextChoices):
        NONE = "none", "None"
        MANUAL = "manual", "Manual (operator assigned)"
        STRIPE = "stripe", "Stripe"

    workspace = models.OneToOneField("workspaces.Workspace", on_delete=models.CASCADE, related_name="subscription")
    plan = models.ForeignKey(Plan, on_delete=models.PROTECT, related_name="subscriptions")
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.FREE, db_index=True)
    provider = models.CharField(max_length=10, choices=Provider.choices, default=Provider.NONE)
    interval = models.CharField(max_length=5, default="month")
    provider_customer_id = models.CharField(max_length=120, blank=True, db_index=True)
    provider_subscription_id = models.CharField(max_length=120, blank=True, db_index=True)
    current_period_end = models.DateTimeField(null=True, blank=True)
    cancel_at_period_end = models.BooleanField(default=False)
    grace_until = models.DateTimeField(null=True, blank=True)
    canceled_at = models.DateTimeField(null=True, blank=True)
    manual_note = models.CharField(max_length=300, blank=True)
    created_at = models.DateTimeField(default=timezone.now)
    updated_at = models.DateTimeField(auto_now=True)
    last_reconciled_at = models.DateTimeField(null=True, blank=True)


class Invoice(models.Model):
    subscription = models.ForeignKey(Subscription, on_delete=models.CASCADE, related_name="invoices")
    provider_invoice_id = models.CharField(max_length=120, unique=True)
    number = models.CharField(max_length=60, blank=True)
    status = models.CharField(max_length=20)
    currency = models.CharField(max_length=3)
    amount_due = models.IntegerField(default=0)
    amount_paid = models.IntegerField(default=0)
    hosted_url = models.URLField(blank=True, max_length=500)
    period_start = models.DateTimeField(null=True, blank=True)
    period_end = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(default=timezone.now)

    class Meta:
        ordering = ["-created_at"]


class WebhookEvent(models.Model):
    """Idempotency + monitoring record for payment-provider webhooks.

    The raw payload is not stored (it contains customer PII); only the event
    identity, type, the object it referred to and the processing outcome.
    """

    class Outcome(models.TextChoices):
        PROCESSED = "processed"
        IGNORED = "ignored"
        FAILED = "failed"
        REJECTED = "rejected"

    provider = models.CharField(max_length=20)
    event_id = models.CharField(max_length=120)
    event_type = models.CharField(max_length=80, blank=True)
    object_id = models.CharField(max_length=120, blank=True)
    received_at = models.DateTimeField(default=timezone.now, db_index=True)
    outcome = models.CharField(max_length=10, choices=Outcome.choices)
    error = models.CharField(max_length=300, blank=True)

    class Meta:
        ordering = ["-received_at"]
        constraints = [
            models.UniqueConstraint(
                fields=["provider", "event_id"],
                condition=~models.Q(event_id=""),
                name="webhook_event_unique",
            )
        ]


class BillingAction(models.Model):
    """Customer-initiated billing actions (checkout starts, portal visits)."""

    at = models.DateTimeField(default=timezone.now)
    workspace = models.ForeignKey("workspaces.Workspace", on_delete=models.CASCADE, related_name="+")
    user = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL, related_name="+")
    action = models.CharField(max_length=40)
    detail = models.JSONField(default=dict, blank=True)
