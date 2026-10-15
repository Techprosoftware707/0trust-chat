from __future__ import annotations

import hashlib
import json
import uuid

from django.conf import settings
from django.db import connection, models, transaction
from django.utils import timezone


class AuditEvent(models.Model):
    """Append-only, hash-chained record of security-relevant actions.

    A database trigger (migration 0002) rejects UPDATE/DELETE unless the
    retention job explicitly enables purging inside its own transaction, and
    each row stores ``hash = sha256(prev_hash || canonical(row))`` so that
    tampering is detectable with ``manage.py lumen_audit_verify``.
    Never put secrets, message content or keys in ``metadata``.
    """

    id = models.BigAutoField(primary_key=True)
    at = models.DateTimeField(default=timezone.now, db_index=True)
    actor = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    actor_label = models.CharField(max_length=200, blank=True)
    surface = models.CharField(max_length=16, blank=True)
    action = models.CharField(max_length=80, db_index=True)
    target_type = models.CharField(max_length=60, blank=True)
    target_id = models.CharField(max_length=120, blank=True)
    ip = models.GenericIPAddressField(null=True, blank=True)
    request_id = models.CharField(max_length=40, blank=True)
    metadata = models.JSONField(default=dict, blank=True)
    prev_hash = models.CharField(max_length=64, blank=True)
    hash = models.CharField(max_length=64, blank=True)

    class Meta:
        ordering = ["-id"]
        indexes = [models.Index(fields=["target_type", "target_id"])]

    def canonical(self) -> str:
        payload = {
            "at": self.at.isoformat(),
            "actor": self.actor_id,
            "actor_label": self.actor_label,
            "surface": self.surface,
            "action": self.action,
            "target_type": self.target_type,
            "target_id": self.target_id,
            "ip": self.ip,
            "request_id": self.request_id,
            "metadata": self.metadata,
        }
        return json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)

    def compute_hash(self) -> str:
        return hashlib.sha256((self.prev_hash + self.canonical()).encode("utf-8")).hexdigest()

    def save(self, *args, **kwargs):
        if self.pk:
            raise RuntimeError("Audit events are append-only")
        with transaction.atomic():
            if connection.vendor == "postgresql":
                with connection.cursor() as cur:
                    cur.execute("SELECT pg_advisory_xact_lock(%s)", [7_400_001])
            last = AuditEvent.objects.order_by("-id").values_list("hash", flat=True).first()
            self.prev_hash = last or ""
            self.hash = self.compute_hash()
            super().save(*args, **kwargs)


class SecurityEvent(models.Model):
    class Kind(models.TextChoices):
        LOGIN_SUCCESS = "login_success"
        LOGIN_FAILED = "login_failed"
        LOGOUT = "logout"
        MFA_ENABLED = "mfa_enabled"
        MFA_DISABLED = "mfa_disabled"
        MFA_FAILED = "mfa_failed"
        PASSWORD_CHANGED = "password_changed"
        PASSWORD_RESET = "password_reset"
        EMAIL_CHANGED = "email_changed"
        SESSION_REVOKED = "session_revoked"
        RATE_LIMITED = "rate_limited"
        OIDC_DENIED = "oidc_denied"
        OIDC_GRANTED = "oidc_granted"
        WEBHOOK_REJECTED = "webhook_rejected"
        OPS_ACCESS_DENIED = "ops_access_denied"
        ACCOUNT_SUSPENDED = "account_suspended"
        ACCOUNT_DELETION = "account_deletion"
        RECOVERY_LINK = "recovery_link"

    at = models.DateTimeField(default=timezone.now, db_index=True)
    kind = models.CharField(max_length=40, choices=Kind.choices, db_index=True)
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.CASCADE, related_name="security_events"
    )
    ip = models.GenericIPAddressField(null=True, blank=True)
    user_agent = models.CharField(max_length=200, blank=True)
    detail = models.JSONField(default=dict, blank=True)

    class Meta:
        ordering = ["-at"]
        indexes = [models.Index(fields=["kind", "at"]), models.Index(fields=["user", "at"])]


class RateLimitBucket(models.Model):
    """Fixed-window counters updated atomically with INSERT .. ON CONFLICT."""

    key = models.CharField(max_length=200)
    window_start = models.BigIntegerField()
    count = models.IntegerField(default=0)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["key", "window_start"], name="ratelimit_key_window")]


class RuntimeSetting(models.Model):
    """Operator-editable settings (maintenance mode, registration mode...)."""

    key = models.CharField(max_length=80, primary_key=True)
    value = models.JSONField()
    updated_at = models.DateTimeField(auto_now=True)
    updated_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )


class HealthSnapshot(models.Model):
    class Status(models.TextChoices):
        OK = "ok"
        DEGRADED = "degraded"
        FAILED = "failed"
        UNKNOWN = "unknown"

    at = models.DateTimeField(default=timezone.now, db_index=True)
    component = models.CharField(max_length=60, db_index=True)
    status = models.CharField(max_length=10, choices=Status.choices)
    summary = models.CharField(max_length=300, blank=True)
    detail = models.JSONField(default=dict, blank=True)
    latency_ms = models.IntegerField(null=True, blank=True)

    class Meta:
        ordering = ["-at"]
        indexes = [models.Index(fields=["component", "-at"])]


class SupportTicket(models.Model):
    class Priority(models.TextChoices):
        NORMAL = "normal"
        HIGH = "high"

    class Status(models.TextChoices):
        OPEN = "open"
        ANSWERED = "answered"
        CLOSED = "closed"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    created_at = models.DateTimeField(default=timezone.now, db_index=True)
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="tickets"
    )
    name = models.CharField(max_length=120)
    email = models.EmailField()
    topic = models.CharField(max_length=40)
    subject = models.CharField(max_length=160)
    message = models.TextField(max_length=5000)
    priority = models.CharField(max_length=10, choices=Priority.choices, default=Priority.NORMAL)
    status = models.CharField(max_length=10, choices=Status.choices, default=Status.OPEN)
    handled_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    internal_note = models.TextField(blank=True, max_length=5000)

    class Meta:
        ordering = ["-created_at"]


class OutboundEmail(models.Model):
    """Queue for mail sent by the worker (invitations, notices).

    Only rendered subject/body are stored and rows are deleted after sending.
    """

    created_at = models.DateTimeField(default=timezone.now)
    to = models.EmailField()
    subject = models.CharField(max_length=200)
    body = models.TextField()
    attempts = models.IntegerField(default=0)
    last_error = models.CharField(max_length=300, blank=True)
    sent_at = models.DateTimeField(null=True, blank=True)
