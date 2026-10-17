from __future__ import annotations

import hashlib
import secrets
import uuid
from datetime import timedelta

from django.conf import settings
from django.db import models
from django.utils import timezone


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


class Workspace(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name = models.CharField(max_length=80)
    slug = models.SlugField(max_length=60, unique=True)
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL, related_name="+")
    created_at = models.DateTimeField(default=timezone.now)
    require_mfa = models.BooleanField(
        default=False, help_text="Members must have two-factor authentication enabled to sign in to chat."
    )
    allow_member_invites = models.BooleanField(default=False)

    class Meta:
        ordering = ["name"]

    def __str__(self) -> str:
        return self.name


class Role(models.TextChoices):
    """Workspace (organisation) roles, highest first.

    ``owner``, ``admin`` and ``member`` are the original Lumen roles; ``manager``, ``agent``
    and ``readonly`` were added for business workspaces (Nexus). What each role may do with
    business records is decided in one place, ``apps.crm.access``; workspace administration
    (members, settings, billing) stays with owner/admin (``Membership.can_manage``).
    """

    OWNER = "owner", "Owner"
    ADMIN = "admin", "Admin"
    MANAGER = "manager", "Manager"
    AGENT = "agent", "Agent / Broker"
    MEMBER = "member", "Team member"
    READONLY = "readonly", "Read-only"


#: Highest first; used to order members and to pick an owner's successor.
ROLE_RANK = {Role.OWNER: 0, Role.ADMIN: 1, Role.MANAGER: 2, Role.AGENT: 3, Role.MEMBER: 4, Role.READONLY: 5}

#: Roles each managing role may give through invitations or role changes. Nobody gives
#: ``owner`` this way (ownership is transferred explicitly).
ASSIGNABLE_ROLES = {
    Role.OWNER: [Role.ADMIN, Role.MANAGER, Role.AGENT, Role.MEMBER, Role.READONLY],
    Role.ADMIN: [Role.MANAGER, Role.AGENT, Role.MEMBER, Role.READONLY],
}


def assignable_roles(role: str) -> list[str]:
    return list(ASSIGNABLE_ROLES.get(role, []))


class Membership(models.Model):
    workspace = models.ForeignKey(Workspace, on_delete=models.CASCADE, related_name="memberships")
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="memberships")
    role = models.CharField(max_length=10, choices=Role.choices, default=Role.MEMBER)
    created_at = models.DateTimeField(default=timezone.now)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["workspace", "user"], name="membership_unique")]
        ordering = ["created_at"]

    @property
    def can_manage(self) -> bool:
        return self.role in {Role.OWNER, Role.ADMIN}


class InvitationQuerySet(models.QuerySet):
    def pending(self):
        return self.filter(accepted_at__isnull=True, revoked_at__isnull=True, expires_at__gt=timezone.now())

    def valid_for_token(self, token: str):
        if not token or len(token) > 200:
            return None
        return self.pending().filter(token_hash=hash_token(token)).select_related("workspace").first()


class Invitation(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    workspace = models.ForeignKey(Workspace, on_delete=models.CASCADE, related_name="invitations")
    email = models.EmailField()
    role = models.CharField(max_length=10, choices=Role.choices, default=Role.MEMBER)
    token_hash = models.CharField(max_length=64, unique=True)
    invited_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL, related_name="+")
    created_at = models.DateTimeField(default=timezone.now)
    expires_at = models.DateTimeField()
    accepted_at = models.DateTimeField(null=True, blank=True)
    accepted_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    revoked_at = models.DateTimeField(null=True, blank=True)

    objects = InvitationQuerySet.as_manager()

    class Meta:
        ordering = ["-created_at"]

    @classmethod
    def issue(cls, *, workspace, email, role, invited_by, days: int = 7) -> tuple["Invitation", str]:
        token = secrets.token_urlsafe(32)
        inv = cls.objects.create(
            workspace=workspace,
            email=email.lower(),
            role=role,
            token_hash=hash_token(token),
            invited_by=invited_by,
            expires_at=timezone.now() + timedelta(days=days),
        )
        return inv, token

    @property
    def state(self) -> str:
        if self.accepted_at:
            return "accepted"
        if self.revoked_at:
            return "revoked"
        if self.expires_at <= timezone.now():
            return "expired"
        return "pending"
