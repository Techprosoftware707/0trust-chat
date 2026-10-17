"""Workspace operations with server-side authorisation and plan limits.

Every function takes the acting user and re-checks their membership/role; views
must not pass objects they looked up without going through ``membership_for``.
"""

from __future__ import annotations

from django.conf import settings
from django.core.exceptions import PermissionDenied, ValidationError
from django.db import IntegrityError, transaction
from django.http import Http404
from django.utils import timezone
from django.utils.text import slugify

from apps.billing import services as billing
from apps.billing.models import Subscription

from .models import Invitation, Membership, Role, Workspace, assignable_roles


def membership_for(user, workspace_id) -> Membership:
    """Return the acting user's membership or 404 (never reveal existence)."""
    try:
        return Membership.objects.select_related("workspace").get(user=user, workspace_id=workspace_id)
    except (Membership.DoesNotExist, ValueError, ValidationError):  # malformed UUIDs too
        raise Http404("Workspace not found") from None


def require_manager(membership: Membership) -> None:
    if not membership.can_manage:
        raise PermissionDenied("Only workspace owners and admins can do that.")


def _unique_slug(name: str) -> str:
    base = slugify(name)[:50] or "workspace"
    slug = base
    n = 2
    while Workspace.objects.filter(slug=slug).exists():
        slug = f"{base}-{n}"
        n += 1
    return slug


@transaction.atomic
def create_workspace(user, name: str) -> Workspace:
    name = name.strip()[:80]
    if not name:
        raise ValueError("Name is required")
    owned_free = Membership.objects.filter(user=user, role=Role.OWNER).select_related("workspace__subscription__plan")
    free_count = sum(1 for m in owned_free if billing.workspace_plan(m.workspace).is_free)
    if free_count >= settings.FREE_WORKSPACES_PER_USER:
        raise billing.EntitlementError(
            f"You already own {free_count} workspace(s) on the Free plan. Upgrade one of them or contact us for more.",
            key="free_workspaces",
        )
    ws = Workspace.objects.create(name=name, slug=_unique_slug(name), created_by=user)
    Membership.objects.create(workspace=ws, user=user, role=Role.OWNER)
    billing.ensure_subscription(ws)
    return ws


def seats_used(workspace: Workspace) -> int:
    return workspace.memberships.count() + workspace.invitations.pending().count()


def check_can_add_seat(workspace: Workspace) -> None:
    plan = billing.workspace_plan(workspace)
    limit = plan.entitlement("max_members")
    if seats_used(workspace) >= limit:
        raise billing.EntitlementError(
            f"The {plan.name} plan allows {limit} members including pending invitations.", key="max_members"
        )


@transaction.atomic
def invite(actor, workspace_id, email: str, role: str = Role.MEMBER) -> tuple[Invitation, str]:
    membership = membership_for(actor, workspace_id)
    ws = Workspace.objects.select_for_update().get(pk=membership.workspace_id)
    if not membership.can_manage and not (ws.allow_member_invites and role == Role.MEMBER):
        raise PermissionDenied("You are not allowed to invite people to this workspace.")
    if role not in set(Role.values) - {Role.OWNER}:
        raise PermissionDenied("Invalid role")
    if role == Role.ADMIN and membership.role != Role.OWNER:
        raise PermissionDenied("Only the owner can invite admins.")
    if membership.can_manage and role not in assignable_roles(membership.role):
        raise PermissionDenied("You can't give that role.")
    email = email.strip().lower()
    if Membership.objects.filter(workspace=ws, user__email__iexact=email).exists():
        raise ValueError("That person is already a member.")
    if ws.invitations.pending().filter(email=email).exists():
        raise ValueError("There is already a pending invitation for that address.")
    plan = billing.workspace_plan(ws)
    if ws.invitations.pending().count() >= plan.entitlement("max_pending_invites"):
        raise billing.EntitlementError("Too many open invitations for this plan.", key="max_pending_invites")
    check_can_add_seat(ws)
    return Invitation.issue(workspace=ws, email=email, role=role, invited_by=actor)


@transaction.atomic
def accept_invitation(user, token: str) -> Membership:
    found = Invitation.objects.valid_for_token(token)
    inv = Invitation.objects.select_for_update().filter(pk=found.pk).first() if found else None
    if inv is None or inv.state != "pending":
        raise ValueError("This invitation is invalid, expired or already used.")
    if inv.email != (user.email or "").lower():
        raise PermissionDenied("This invitation was sent to a different email address.")
    if Membership.objects.filter(workspace=inv.workspace, user=user).exists():
        raise ValueError("You are already a member of this workspace.")
    # The invitation already holds a seat, so no new seat check is needed.
    try:
        m = Membership.objects.create(workspace=inv.workspace, user=user, role=inv.role)
    except IntegrityError as exc:  # pragma: no cover - race
        raise ValueError("You are already a member of this workspace.") from exc
    inv.accepted_at = timezone.now()
    inv.accepted_by = user
    inv.save(update_fields=["accepted_at", "accepted_by"])
    return m


def revoke_invitation(actor, workspace_id, invitation_id) -> Invitation:
    membership = membership_for(actor, workspace_id)
    require_manager(membership)
    try:
        inv = Invitation.objects.get(pk=invitation_id, workspace_id=membership.workspace_id)
    except (Invitation.DoesNotExist, ValueError, ValidationError):
        raise Http404() from None
    if inv.state == "pending":
        inv.revoked_at = timezone.now()
        inv.save(update_fields=["revoked_at"])
    return inv


@transaction.atomic
def change_role(actor, workspace_id, member_id, new_role: str) -> Membership:
    """The owner may give any role but owner; an admin may move people who are not
    owner/admin between manager, agent, team member and read-only."""
    membership = membership_for(actor, workspace_id)
    if not membership.can_manage:
        raise PermissionDenied("Only the owner and admins can change roles.")
    if new_role not in set(Role.values) - {Role.OWNER}:
        raise PermissionDenied("Invalid role")
    try:
        target = Membership.objects.select_for_update().get(pk=member_id, workspace_id=membership.workspace_id)
    except (Membership.DoesNotExist, ValueError, ValidationError):
        raise Http404() from None
    if target.role == Role.OWNER:
        raise PermissionDenied("The owner's role cannot be changed here.")
    if membership.role != Role.OWNER and (target.role == Role.ADMIN or new_role not in assignable_roles(membership.role)):
        raise PermissionDenied("Only the owner can change admins or make someone an admin.")
    if target.pk == membership.pk:
        raise PermissionDenied("You can't change your own role.")
    target.role = new_role
    target.save(update_fields=["role"])
    return target


@transaction.atomic
def remove_member(actor, workspace_id, member_id) -> Membership:
    membership = membership_for(actor, workspace_id)
    try:
        target = Membership.objects.select_for_update().get(pk=member_id, workspace_id=membership.workspace_id)
    except (Membership.DoesNotExist, ValueError, ValidationError):
        raise Http404() from None
    if target.user_id == actor.pk:
        if target.role == Role.OWNER:
            raise PermissionDenied("Transfer ownership or delete the workspace instead of leaving it.")
    else:
        require_manager(membership)
        if target.role == Role.OWNER:
            raise PermissionDenied("The owner cannot be removed.")
        if target.role == Role.ADMIN and membership.role != Role.OWNER:
            raise PermissionDenied("Only the owner can remove admins.")
    target.delete()
    return target


@transaction.atomic
def transfer_ownership(actor, workspace_id, member_id) -> None:
    membership = membership_for(actor, workspace_id)
    if membership.role != Role.OWNER:
        raise PermissionDenied("Only the owner can transfer ownership.")
    try:
        target = Membership.objects.select_for_update().get(pk=member_id, workspace_id=membership.workspace_id)
    except (Membership.DoesNotExist, ValueError, ValidationError):
        raise Http404() from None
    if target.pk == membership.pk:
        return
    target.role = Role.OWNER
    target.save(update_fields=["role"])
    membership.role = Role.ADMIN
    membership.save(update_fields=["role"])


def update_settings(actor, workspace_id, *, name: str, require_mfa: bool, allow_member_invites: bool) -> Workspace:
    membership = membership_for(actor, workspace_id)
    require_manager(membership)
    ws = membership.workspace
    if require_mfa and not ws.require_mfa:
        plan = billing.workspace_plan(ws)
        if not plan.entitlement("can_require_mfa"):
            raise billing.EntitlementError(
                f"Requiring MFA is not included in the {plan.name} plan.", key="can_require_mfa"
            )
    ws.name = name.strip()[:80] or ws.name
    ws.require_mfa = require_mfa
    ws.allow_member_invites = allow_member_invites
    ws.save(update_fields=["name", "require_mfa", "allow_member_invites"])
    return ws


@transaction.atomic
def delete_workspace(actor, workspace_id) -> None:
    membership = membership_for(actor, workspace_id)
    if membership.role != Role.OWNER:
        raise PermissionDenied("Only the owner can delete the workspace.")
    ws = membership.workspace
    try:
        sub = ws.subscription
    except Subscription.DoesNotExist:
        sub = None
    if sub is not None and sub.provider == Subscription.Provider.STRIPE and sub.status in {
        Subscription.Status.ACTIVE,
        Subscription.Status.TRIALING,
        Subscription.Status.PAST_DUE,
    } and not sub.cancel_at_period_end:
        raise PermissionDenied("Cancel the paid subscription before deleting this workspace.")
    ws.delete()
