from __future__ import annotations

import json
from datetime import timedelta

from allauth.account import views as allauth_views
from allauth.account.decorators import reauthentication_required
from allauth.account.models import EmailAddress
from allauth.mfa.models import Authenticator
from allauth.mfa.utils import is_mfa_enabled
from allauth.usersessions.models import UserSession
from django.conf import settings
from django.contrib import messages
from django.contrib.auth.decorators import login_required
from django.core.exceptions import PermissionDenied, ValidationError
from django.core.validators import validate_email
from django.core.paginator import Paginator
from django.db import transaction
from django.http import Http404, HttpResponse
from django.shortcuts import redirect, render
from django.urls import reverse
from django.utils import timezone
from django.views.decorators.http import require_http_methods, require_POST

from apps.billing import services as billing
from apps.billing.models import ENTITLEMENT_LABELS
from apps.billing.providers import BillingUnavailable, get_provider
from apps.core import ratelimit
from apps.core.audit import audit, security_event
from apps.core.models import SecurityEvent, SupportTicket
from apps.workspaces import services as ws_services
from apps.workspaces.models import Invitation, Membership, Role, Workspace, hash_token

from .adapter import INVITE_SESSION_KEY
from .forms import DeleteAccountForm, DisplayNameForm
from .models import AccountStatus, OperatorSetupToken

# --- helpers -------------------------------------------------------------------


def _security_summary(user) -> dict:
    authenticators = list(Authenticator.objects.filter(user=user))
    types = {a.type for a in authenticators}
    recovery = next((a for a in authenticators if a.type == Authenticator.Type.RECOVERY_CODES), None)
    unused_codes = None
    if recovery is not None:
        try:
            unused_codes = len(recovery.wrap().get_unused_codes())
        except Exception:  # pragma: no cover - defensive
            unused_codes = None
    primary_email = EmailAddress.objects.filter(user=user, primary=True).first()
    week_ago = timezone.now() - timedelta(days=7)
    failed = SecurityEvent.objects.filter(user=user, kind="login_failed", at__gte=week_ago).count()
    sessions = UserSession.objects.filter(user=user).count()
    checks = [
        ("Two-factor authentication", is_mfa_enabled(user)),
        ("Recovery codes available", bool(unused_codes)),
        ("Email address verified", bool(primary_email and primary_email.verified) or not settings.EMAIL_ENABLED),
        ("No recent failed sign-ins", failed == 0),
    ]
    score = round(100 * sum(1 for _, ok in checks if ok) / len(checks))
    actions = ["turn on two-factor", "save recovery codes", "verify your email", "review failed sign-ins"]
    todo = [action for (_, ok), action in zip(checks, actions) if not ok]
    return {
        "mfa_enabled": is_mfa_enabled(user),
        "totp": Authenticator.Type.TOTP in types,
        "webauthn": Authenticator.Type.WEBAUTHN in types,
        "recovery_codes_left": unused_codes,
        "email": primary_email,
        "failed_logins_7d": failed,
        "sessions": sessions,
        "checks": checks,
        "todo": todo,
        "score": score,
    }


def _notifications(user, summary, memberships) -> list[dict]:
    notes = []
    if user.status == AccountStatus.PENDING_DELETION:
        notes.append(
            {
                "level": "danger",
                "text": f"Your account is scheduled for deletion on {user.deletion_scheduled_for:%Y-%m-%d}.",
                "href": reverse("portal:privacy"),
                "cta": "Review",
            }
        )
    if not summary["mfa_enabled"]:
        notes.append(
            {"level": "warning", "text": "Two-factor authentication is off.", "href": reverse("mfa_index"), "cta": "Turn on"}
        )
    if summary["mfa_enabled"] and summary["recovery_codes_left"] is not None and summary["recovery_codes_left"] <= 2:
        notes.append(
            {
                "level": "warning",
                "text": f"Only {summary['recovery_codes_left']} MFA recovery codes left.",
                "href": reverse("mfa_view_recovery_codes"),
                "cta": "Manage",
            }
        )
    if summary["failed_logins_7d"]:
        notes.append(
            {
                "level": "info",
                "text": f"{summary['failed_logins_7d']} failed sign-in attempt(s) in the last 7 days.",
                "href": reverse("portal:security"),
                "cta": "View",
            }
        )
    for m in memberships:
        if m.workspace.require_mfa and not summary["mfa_enabled"]:
            notes.append(
                {
                    "level": "danger",
                    "text": f"{m.workspace.name} requires MFA — chat sign-in is blocked until you enable it.",
                    "href": reverse("mfa_index"),
                    "cta": "Set up MFA",
                }
            )
        sub = getattr(m.workspace, "subscription", None)
        if m.can_manage and sub is not None and sub.status == "past_due":
            until = f" until {sub.grace_until:%Y-%m-%d}" if sub.grace_until else ""
            notes.append(
                {
                    "level": "danger",
                    "text": f"Payment failed for {m.workspace.name}. Paid features stay on{until}.",
                    "href": reverse("portal:workspace_billing", args=[m.workspace.pk]),
                    "cta": "Fix billing",
                }
            )
    return notes


# --- dashboard & account ------------------------------------------------------


@login_required
def dashboard(request):
    user = request.user
    memberships = list(
        Membership.objects.filter(user=user).select_related("workspace", "workspace__subscription__plan")
    )
    summary = _security_summary(user)
    workspaces = []
    for m in memberships:
        plan = billing.workspace_plan(m.workspace)
        workspaces.append(
            {
                "membership": m,
                "plan": plan,
                "seats": ws_services.seats_used(m.workspace),
                "limit": plan.entitlement("max_members"),
            }
        )
    ent = billing.user_entitlements(user)
    recent = SecurityEvent.objects.filter(user=user).order_by("-at")[:6]
    return render(
        request,
        "portal/dashboard.html",
        {
            "summary": summary,
            "workspaces": workspaces,
            "entitlements": ent,
            "recent_events": recent,
            "notifications": _notifications(user, summary, memberships),
        },
    )


@login_required
@require_http_methods(["GET", "POST"])
def profile(request):
    form = DisplayNameForm(
        request.POST or None,
        initial={"display_name": request.user.display_name, "show_in_directory": request.user.show_in_directory},
    )
    if request.method == "POST" and form.is_valid():
        request.user.display_name = form.cleaned_data["display_name"].strip()
        request.user.show_in_directory = form.cleaned_data["show_in_directory"]
        request.user.save(update_fields=["display_name", "show_in_directory"])
        messages.success(request, "Profile updated.")
        return redirect("portal:profile")
    emails = EmailAddress.objects.filter(user=request.user)
    return render(request, "portal/profile.html", {"form": form, "emails": emails})


@login_required
def security_center(request):
    summary = _security_summary(request.user)
    events = SecurityEvent.objects.filter(user=request.user).order_by("-at")
    page = Paginator(events, 20).get_page(request.GET.get("page"))
    return render(request, "portal/security.html", {"summary": summary, "events": page})


@login_required
def privacy_center(request):
    owned_paid = [
        m.workspace
        for m in Membership.objects.filter(user=request.user, role=Role.OWNER).select_related("workspace__subscription")
        if not billing.workspace_plan(m.workspace).is_free
    ]
    return render(
        request,
        "portal/privacy.html",
        {
            "retention": settings.RETENTION,
            "delete_form": DeleteAccountForm(user=request.user),
            "owned_paid": owned_paid,
        },
    )


@login_required
def export_data(request):
    user = request.user
    decision = ratelimit.check_request(request, "export", limit=5, window_seconds=3600, per_user=True)
    if not decision.allowed:
        messages.error(request, "Too many export requests. Try again later.")
        return redirect("portal:privacy")
    data = {
        "generated_at": timezone.now().isoformat(),
        "notice": (
            "This export contains the account data held by the portal. Chat messages are end-to-end "
            "encrypted and are not readable by the server; export them from the chat app instead."
        ),
        "account": {
            "username": user.username,
            "matrix_id": user.matrix_id,
            "display_name": user.display_name,
            "email": user.email,
            "date_joined": user.date_joined.isoformat(),
            "last_login": user.last_login.isoformat() if user.last_login else None,
            "chat_first_login_at": user.chat_first_login_at.isoformat() if user.chat_first_login_at else None,
            "status": user.status,
            "show_in_directory": user.show_in_directory,
        },
        "emails": [
            {"email": e.email, "verified": e.verified, "primary": e.primary}
            for e in EmailAddress.objects.filter(user=user)
        ],
        "mfa": [{"type": a.type, "created_at": a.created_at.isoformat()} for a in Authenticator.objects.filter(user=user)],
        "workspaces": [
            {"workspace": m.workspace.name, "role": m.role, "joined": m.created_at.isoformat()}
            for m in Membership.objects.filter(user=user).select_related("workspace")
        ],
        "sessions": [
            {"ip": s.ip, "user_agent": s.user_agent, "created_at": s.created_at.isoformat(), "last_seen_at": s.last_seen_at.isoformat() if s.last_seen_at else None}
            for s in UserSession.objects.filter(user=user)
        ],
        "security_events": [
            {"at": e.at.isoformat(), "kind": e.kind, "ip": e.ip, "user_agent": e.user_agent}
            for e in SecurityEvent.objects.filter(user=user).order_by("-at")[:1000]
        ],
        "support_tickets": [
            {"created_at": t.created_at.isoformat(), "subject": t.subject, "message": t.message, "status": t.status}
            for t in SupportTicket.objects.filter(user=user)
        ],
    }
    audit(request, "account.export", target=user)
    resp = HttpResponse(json.dumps(data, indent=2), content_type="application/json")
    resp["Content-Disposition"] = f'attachment; filename="{user.username}-account-export.json"'
    return resp


@login_required
@require_POST
@reauthentication_required
def delete_account(request):
    user = request.user
    form = DeleteAccountForm(request.POST, user=user)
    if not form.is_valid():
        messages.error(request, "Account deletion was not scheduled: the username did not match.")
        return redirect("portal:privacy")
    for m in Membership.objects.filter(user=user, role=Role.OWNER).select_related("workspace__subscription"):
        sub = getattr(m.workspace, "subscription", None)
        if sub is not None and sub.provider == "stripe" and sub.status in {"active", "trialing", "past_due"} and not sub.cancel_at_period_end:
            messages.error(
                request,
                f"Cancel the paid subscription of {m.workspace.name} (or transfer ownership) before deleting your account.",
            )
            return redirect("portal:privacy")
    now = timezone.now()
    user.set_status(AccountStatus.PENDING_DELETION, "requested by user")
    user.deletion_requested_at = now
    user.deletion_scheduled_for = now + timedelta(days=settings.RETENTION["deletion_grace_days"])
    user.save()
    security_event(request, "account_deletion", user=user, detail={"scheduled_for": user.deletion_scheduled_for.isoformat()})
    audit(request, "account.deletion_scheduled", target=user)
    messages.warning(
        request,
        f"Your account will be deleted on {user.deletion_scheduled_for:%Y-%m-%d}. You can cancel until then.",
    )
    return redirect("portal:privacy")


@login_required
@require_POST
def cancel_deletion(request):
    user = request.user
    if user.status == AccountStatus.PENDING_DELETION:
        user.set_status(AccountStatus.ACTIVE, "deletion canceled by user")
        user.deletion_requested_at = None
        user.deletion_scheduled_for = None
        user.save()
        audit(request, "account.deletion_canceled", target=user)
        messages.success(request, "Account deletion canceled.")
    return redirect("portal:privacy")


@login_required
@require_http_methods(["GET"])
def support(request):
    tickets = SupportTicket.objects.filter(user=request.user)[:50]
    ent = billing.user_entitlements(request.user)
    return render(request, "portal/support.html", {"tickets": tickets, "priority": ent.priority_support})


# --- workspaces -------------------------------------------------------------------


@login_required
@require_http_methods(["GET", "POST"])
def workspaces(request):
    if request.method == "POST":
        name = request.POST.get("name", "")
        try:
            ws = ws_services.create_workspace(request.user, name)
        except (ValueError, billing.EntitlementError) as exc:
            messages.error(request, str(exc))
        else:
            audit(request, "workspace.create", target=ws)
            messages.success(request, f"Workspace “{ws.name}” created.")
            return redirect("portal:workspace", ws.pk)
    memberships = Membership.objects.filter(user=request.user).select_related("workspace")
    rows = [
        {"membership": m, "plan": billing.workspace_plan(m.workspace), "seats": ws_services.seats_used(m.workspace)}
        for m in memberships
    ]
    return render(request, "portal/workspaces.html", {"rows": rows})


@login_required
def workspace_detail(request, workspace_id):
    membership = ws_services.membership_for(request.user, workspace_id)
    ws = membership.workspace
    plan = billing.workspace_plan(ws)
    members = ws.memberships.select_related("user").order_by("created_at")
    invitations = ws.invitations.pending() if membership.can_manage else Invitation.objects.none()
    new_invite = request.session.pop("lumen_new_invite", None)
    return render(
        request,
        "portal/workspace_detail.html",
        {
            "membership": membership,
            "ws": ws,
            "plan": plan,
            "members": members,
            "invitations": invitations,
            "seats": ws_services.seats_used(ws),
            "limit": plan.entitlement("max_members"),
            "new_invite": new_invite,
            "roles": [(Role.MEMBER, "Member"), (Role.ADMIN, "Admin")],
        },
    )


@login_required
@require_POST
def workspace_invite(request, workspace_id):
    decision = ratelimit.check_request(request, "invite", limit=30, window_seconds=3600, per_user=True)
    if not decision.allowed:
        messages.error(request, "Too many invitations. Try again later.")
        return redirect("portal:workspace", workspace_id)
    email = (request.POST.get("email") or "").strip()
    role = request.POST.get("role") or Role.MEMBER
    try:
        validate_email(email)
        inv, token = ws_services.invite(request.user, workspace_id, email, role)
    except PermissionDenied as exc:
        messages.error(request, str(exc) or "Not allowed.")
        return redirect("portal:workspace", workspace_id)
    except ValidationError:
        messages.error(request, "Enter a valid email address.")
        return redirect("portal:workspace", workspace_id)
    except (ValueError, billing.EntitlementError) as exc:
        messages.error(request, str(exc))
        return redirect("portal:workspace", workspace_id)
    link = request.build_absolute_uri(f"/invite/{token}/")
    audit(request, "workspace.invite", target=inv.workspace, metadata={"email": inv.email, "role": inv.role})
    if settings.EMAIL_ENABLED:
        from apps.core.models import OutboundEmail

        OutboundEmail.objects.create(
            to=inv.email,
            subject=f"{request.user.name} invited you to {inv.workspace.name} on {settings.BRAND['name']}",
            body=(
                f"{request.user.name} ({request.user.matrix_id}) invited you to join the workspace "
                f"“{inv.workspace.name}” on {settings.BRAND['name']}.\n\n"
                f"Accept the invitation: {link}\n\nThis link expires on {inv.expires_at:%Y-%m-%d}."
            ),
        )
        messages.success(request, f"Invitation queued for delivery to {inv.email}. You can also share the link below.")
    else:
        messages.info(request, "Email delivery is not configured, so share the invitation link below with the person you invited.")
    # Shown once on the next page view; the token itself is not stored.
    request.session["lumen_new_invite"] = {"email": inv.email, "link": link}
    return redirect("portal:workspace", workspace_id)


@login_required
@require_POST
def workspace_invite_revoke(request, workspace_id, invitation_id):
    inv = ws_services.revoke_invitation(request.user, workspace_id, invitation_id)
    audit(request, "workspace.invite_revoke", target=inv.workspace, metadata={"email": inv.email})
    messages.success(request, "Invitation revoked.")
    return redirect("portal:workspace", workspace_id)


@login_required
@require_POST
def workspace_member_role(request, workspace_id, member_id):
    try:
        m = ws_services.change_role(request.user, workspace_id, member_id, request.POST.get("role", ""))
    except PermissionDenied as exc:
        messages.error(request, str(exc))
    else:
        audit(request, "workspace.role_change", target=m.workspace, metadata={"member": m.user.username, "role": m.role})
        messages.success(request, f"{m.user.name} is now {m.get_role_display().lower()}.")
    return redirect("portal:workspace", workspace_id)


@login_required
@require_POST
def workspace_member_remove(request, workspace_id, member_id):
    try:
        m = ws_services.remove_member(request.user, workspace_id, member_id)
    except PermissionDenied as exc:
        messages.error(request, str(exc))
        return redirect("portal:workspace", workspace_id)
    audit(request, "workspace.member_remove", target=m.workspace, metadata={"member": m.user.username})
    if m.user_id == request.user.pk:
        messages.success(request, f"You left {m.workspace.name}.")
        return redirect("portal:workspaces")
    messages.success(request, f"{m.user.name} was removed.")
    return redirect("portal:workspace", workspace_id)


@login_required
@require_POST
def workspace_transfer(request, workspace_id, member_id):
    try:
        ws_services.transfer_ownership(request.user, workspace_id, member_id)
    except PermissionDenied as exc:
        messages.error(request, str(exc))
    else:
        audit(request, "workspace.transfer_ownership", target_type="workspace", target_id=str(workspace_id), metadata={"member": str(member_id)})
        messages.success(request, "Ownership transferred.")
    return redirect("portal:workspace", workspace_id)


@login_required
@require_http_methods(["GET", "POST"])
def workspace_settings(request, workspace_id):
    membership = ws_services.membership_for(request.user, workspace_id)
    ws_services.require_manager(membership)
    plan = billing.workspace_plan(membership.workspace)
    if request.method == "POST":
        try:
            ws = ws_services.update_settings(
                request.user,
                workspace_id,
                name=request.POST.get("name", ""),
                require_mfa=request.POST.get("require_mfa") == "on",
                allow_member_invites=request.POST.get("allow_member_invites") == "on",
            )
        except billing.EntitlementError as exc:
            messages.error(request, str(exc))
        else:
            audit(request, "workspace.settings", target=ws, metadata={"require_mfa": ws.require_mfa, "allow_member_invites": ws.allow_member_invites})
            messages.success(request, "Workspace settings saved.")
        return redirect("portal:workspace_settings", workspace_id)
    return render(request, "portal/workspace_settings.html", {"membership": membership, "ws": membership.workspace, "plan": plan})


@login_required
@require_POST
@reauthentication_required
def workspace_delete(request, workspace_id):
    membership = ws_services.membership_for(request.user, workspace_id)
    if request.POST.get("confirm_name", "").strip() != membership.workspace.name:
        messages.error(request, "Type the workspace name exactly to confirm deletion.")
        return redirect("portal:workspace_settings", workspace_id)
    name = membership.workspace.name
    try:
        ws_services.delete_workspace(request.user, workspace_id)
    except PermissionDenied as exc:
        messages.error(request, str(exc))
        return redirect("portal:workspace_settings", workspace_id)
    audit(request, "workspace.delete", target_type="workspace", target_id=str(workspace_id), metadata={"name": name})
    messages.success(request, f"Workspace “{name}” deleted. Chat rooms are not affected.")
    return redirect("portal:workspaces")


@login_required
def workspace_billing(request, workspace_id):
    membership = ws_services.membership_for(request.user, workspace_id)
    ws = membership.workspace
    sub = billing.ensure_subscription(ws)
    plan = billing.workspace_plan(ws)
    provider = get_provider()
    from apps.billing.models import Plan

    plans = Plan.objects.filter(active=True, is_public=True).order_by("sort_order")
    checkout_state = request.GET.get("checkout")
    if checkout_state == "returned":
        messages.info(
            request,
            "Thanks! Your plan changes as soon as the payment provider confirms the payment. Refresh in a moment.",
        )
    elif checkout_state == "canceled":
        messages.info(request, "Checkout canceled. Nothing was charged.")
    return render(
        request,
        "portal/workspace_billing.html",
        {
            "membership": membership,
            "ws": ws,
            "sub": sub,
            "plan": plan,
            "plans": [
                {
                    "plan": p,
                    "monthly": provider.can_checkout(p, "month"),
                    "yearly": provider.can_checkout(p, "year"),
                }
                for p in plans
            ],
            "provider": provider,
            "invoices": sub.invoices.all()[:24],
            "seats": ws_services.seats_used(ws),
            "labels": ENTITLEMENT_LABELS,
        },
    )


@login_required
@require_POST
def workspace_checkout(request, workspace_id):
    membership = ws_services.membership_for(request.user, workspace_id)
    if membership.role != Role.OWNER:
        raise PermissionDenied("Only the workspace owner can change the plan.")
    from apps.billing.models import Plan

    plan = Plan.objects.filter(code=request.POST.get("plan", ""), active=True).first()
    interval = "year" if request.POST.get("interval") == "year" else "month"
    if plan is None:
        raise Http404()
    decision = ratelimit.check_request(request, "checkout", limit=10, window_seconds=3600, per_user=True)
    if not decision.allowed:
        messages.error(request, "Too many checkout attempts. Try again later.")
        return redirect("portal:workspace_billing", workspace_id)
    try:
        url = get_provider().start_checkout(workspace=membership.workspace, plan=plan, interval=interval, user=request.user)
    except BillingUnavailable as exc:
        messages.error(request, str(exc))
        return redirect("portal:workspace_billing", workspace_id)
    except Exception:
        messages.error(request, "The payment provider could not be reached. Nothing was charged; please try again.")
        return redirect("portal:workspace_billing", workspace_id)
    audit(request, "billing.checkout_started", target=membership.workspace, metadata={"plan": plan.code, "interval": interval})
    return redirect(url)


@login_required
@require_POST
def workspace_billing_portal(request, workspace_id):
    membership = ws_services.membership_for(request.user, workspace_id)
    if membership.role != Role.OWNER:
        raise PermissionDenied("Only the workspace owner can manage billing.")
    try:
        url = get_provider().customer_portal_url(workspace=membership.workspace, user=request.user)
    except Exception:
        url = None
    if not url:
        messages.error(request, "The billing portal is not available for this workspace.")
        return redirect("portal:workspace_billing", workspace_id)
    return redirect(url)


# --- invitations / setup links -------------------------------------------------


@require_http_methods(["GET", "POST"])
def invitation_landing(request, token):
    inv = Invitation.objects.valid_for_token(token)
    if inv is None:
        return render(request, "portal/invitation_invalid.html", status=404)
    if request.method == "POST":
        if not request.user.is_authenticated:
            return redirect(f"/accounts/login/?next=/invite/{token}/")
        try:
            m = ws_services.accept_invitation(request.user, token)
        except (ValueError, PermissionDenied) as exc:
            messages.error(request, str(exc))
            return redirect(request.path)
        request.session.pop(INVITE_SESSION_KEY, None)
        audit(request, "workspace.invite_accept", target=m.workspace)
        messages.success(request, f"Welcome to {m.workspace.name}!")
        return redirect("portal:workspace", m.workspace.pk)
    if not request.user.is_authenticated:
        # Lets the invited person register while registration is invite-only.
        request.session[INVITE_SESSION_KEY] = token
    email_matches = request.user.is_authenticated and (request.user.email or "").lower() == inv.email
    return render(request, "portal/invitation.html", {"inv": inv, "token": token, "email_matches": email_matches})


@require_http_methods(["GET", "POST"])
def setup_link(request, token):
    """One-time link for operator onboarding / admin-assisted password recovery."""
    from django.contrib.auth.forms import SetPasswordForm

    rec = OperatorSetupToken.objects.filter(token_hash=hash_token(token)).select_related("user").first()
    if rec is None or not rec.is_valid:
        return render(request, "portal/setup_invalid.html", status=404)
    form = SetPasswordForm(rec.user, request.POST or None)
    if request.method == "POST":
        decision = ratelimit.check_request(request, "setup_link", limit=10, window_seconds=600)
        if decision.allowed and form.is_valid():
            with transaction.atomic():
                form.save()
                rec.used_at = timezone.now()
                rec.save(update_fields=["used_at"])
            security_event(request, "recovery_link", user=rec.user, detail={"purpose": rec.purpose})
            audit(request, f"account.{rec.purpose}_link_used", target=rec.user, actor=rec.user)
            messages.success(request, "Password set. Sign in to continue — you'll be asked to set up two-factor authentication.")
            return redirect("account_login")
    return render(request, "portal/setup_link.html", {"form": form, "target": rec.user, "purpose": rec.purpose})


# --- guarded allauth views ------------------------------------------------------------


def password_reset(request):
    if settings.EMAIL_ENABLED:
        return allauth_views.password_reset(request)
    return render(request, "account/password_reset_unavailable.html")


def email_management(request):
    if settings.EMAIL_ENABLED:
        return allauth_views.email(request)
    if not request.user.is_authenticated:
        return redirect("account_login")
    return render(request, "account/email_unavailable.html", {"emails": EmailAddress.objects.filter(user=request.user)})


def ops_password_reset_disabled(request):
    return render(request, "account/password_reset_unavailable.html", {"ops": True})


def ops_signup_disabled(request):
    raise Http404()
