from __future__ import annotations

import uuid

from django.conf import settings
from django.contrib.auth.models import AbstractUser, UserManager
from django.db import models
from django.utils import timezone


class StaffRole(models.TextChoices):
    NONE = "", "No operator access"
    OWNER = "owner", "Owner"
    ADMIN = "admin", "Administrator"
    SUPPORT = "support", "Support"
    BILLING = "billing", "Billing"
    AUDITOR = "auditor", "Auditor (read-only)"


class AccountStatus(models.TextChoices):
    ACTIVE = "active", "Active"
    SUSPENDED = "suspended", "Suspended"
    PENDING_DELETION = "pending_deletion", "Deletion scheduled"
    DELETED = "deleted", "Deleted"


class LumenUserManager(UserManager):
    def create_superuser(self, *args, **kwargs):  # pragma: no cover - guard
        raise RuntimeError(
            "Lumen has no superuser accounts. Create an operator with "
            "`manage.py lumen_create_operator` instead."
        )


class User(AbstractUser):
    public_id = models.UUIDField(default=uuid.uuid4, unique=True, editable=False)
    display_name = models.CharField(max_length=80, blank=True)
    status = models.CharField(max_length=20, choices=AccountStatus.choices, default=AccountStatus.ACTIVE, db_index=True)
    status_reason = models.CharField(max_length=300, blank=True)
    status_changed_at = models.DateTimeField(null=True, blank=True)
    staff_role = models.CharField(max_length=16, choices=StaffRole.choices, default=StaffRole.NONE, blank=True, db_index=True)
    deletion_requested_at = models.DateTimeField(null=True, blank=True)
    deletion_scheduled_for = models.DateTimeField(null=True, blank=True)
    chat_first_login_at = models.DateTimeField(null=True, blank=True)
    chat_last_login_at = models.DateTimeField(null=True, blank=True)
    show_in_directory = models.BooleanField(
        default=True, help_text="Allow people on this server to find you by name in the chat directory."
    )

    objects = LumenUserManager()

    class Meta:
        indexes = [models.Index(fields=["date_joined"])]

    def save(self, *args, **kwargs):
        # Lumen never uses Django's superuser bypass; authorisation is explicit.
        self.is_superuser = False
        self.is_staff = bool(self.staff_role)
        if self.username:
            self.username = self.username.lower()
        super().save(*args, **kwargs)

    @property
    def matrix_id(self) -> str:
        return f"@{self.username}:{settings.MATRIX_SERVER_NAME}"

    @property
    def name(self) -> str:
        return self.display_name or self.username

    @property
    def is_operator(self) -> bool:
        return bool(self.staff_role) and self.status == AccountStatus.ACTIVE

    def set_status(self, status: str, reason: str = "") -> None:
        self.status = status
        self.status_reason = reason[:300]
        self.status_changed_at = timezone.now()


class RetiredUsername(models.Model):
    """Matrix user IDs are permanent; a deleted account's name is never reissued."""

    username = models.CharField(max_length=64, primary_key=True)
    retired_at = models.DateTimeField(default=timezone.now)


class OperatorSetupToken(models.Model):
    """One-time link used to let a newly created operator set password + MFA."""

    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name="setup_tokens")
    token_hash = models.CharField(max_length=64, unique=True)
    purpose = models.CharField(max_length=20, default="setup")  # setup | recovery
    created_at = models.DateTimeField(default=timezone.now)
    expires_at = models.DateTimeField()
    used_at = models.DateTimeField(null=True, blank=True)
    created_by = models.ForeignKey(User, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")

    @property
    def is_valid(self) -> bool:
        return self.used_at is None and self.expires_at > timezone.now()


def end_all_sessions(user) -> int:
    """End every portal session of ``user`` (Django session + tracking row)."""
    from allauth.usersessions.models import UserSession

    n = 0
    for s in UserSession.objects.filter(user=user):
        s.end()
        n += 1
    return n
