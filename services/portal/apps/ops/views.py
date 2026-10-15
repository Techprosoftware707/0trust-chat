"""Operator console views.

Every view is wrapped in ``ops_view(<permission>)``. Mutating views are
POST-only, audit-logged, and the sensitive ones require step-up
re-authentication and a typed confirmation. Nothing here can display message
plaintext or encryption keys: the platform never has them.
"""

from __future__ import annotations

import io
import json
import secrets
from datetime import timedelta

from allauth.account.models import EmailAddress
from allauth.mfa.models import Authenticator
from allauth.mfa.utils import is_mfa_enabled
from allauth.usersessions.models import UserSession
from django.conf import settings
from django.contrib import messages
from django.contrib.auth import get_user_model
from django.core.exceptions import PermissionDenied, ValidationError
from django.core.paginator import Paginator
from django.db.models import Count, Q
from django.http import Http404, HttpResponse
from django.shortcuts import get_object_or_404, redirect, render
from django.utils import timezone
from django.views.decorators.http import require_POST

from apps.accounts.models import AccountStatus, OperatorSetupToken, StaffRole, end_all_sessions
from apps.billing import services as billing
from apps.billing.models import ENTITLEMENT_FIELDS, ENTITLEMENT_LABELS, Plan, Subscription, WebhookEvent
from apps.billing.providers import StripeProvider, get_provider
from apps.core import runtime
from apps.core.audit import audit, security_event
from apps.core.models import AuditEvent, HealthSnapshot, SecurityEvent, SupportTicket
from apps.ops.probes import HYBRID_PQ_GROUPS
from apps.core.views import component_status
from apps.workspaces.models import Membership, Workspace, hash_token

from . import agent
from .rbac import has_perm, ops_view, perms_for
from .synapse import SynapseAdmin, SynapseError

User = get_user_model()

COMPONENTS = [
    ("website", "Website & portal"),
    ("ops", "Operator console"),
    ("chat_app", "Web chat app"),
    ("homeserver", "Homeserver (Synapse)"),
    ("database", "PostgreSQL"),
    ("federation", "Federation reachability"),
    ("tls", "TLS certificates"),
    ("email", "Email delivery"),
    ("billing", "Payment provider"),
    ("calls", "Calls (SFU)"),
    ("turn", "TURN relay"),
    ("backups", "Backups"),
    ("disk", "Disk space"),
]


def _ctx(request, **extra):
    extra["perms"] = perms_for(request.user)
    return extra


def _confirm(request, expected: str) -> bool:
    return request.POST.get("confirm", "").strip() == expected


def _status_file(name: str) -> dict | None:
    path = settings.STATUS_DIR / f"{name}.json"
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


# --- overview -------------------------------------------------------------------------


@ops_view("view_console")
def dashboard(request):
    now = timezone.now()
    day, week, month = now - timedelta(days=1), now - timedelta(days=7), now - timedelta(days=30)
    users = User.objects.exclude(status=AccountStatus.DELETED)
    paid = Subscription.objects.filter(status__in=["active", "trialing", "past_due"]).exclude(plan__is_free=True).select_related("plan")
    mrr = 0
    for s in paid:
        if s.plan.price_monthly_cents:
            mrr += s.plan.price_monthly_cents if s.interval == "month" else round((s.plan.price_yearly_cents or 0) / 12)
    stats = {
        "users": users.count(),
        "new_users_7d": users.filter(date_joined__gte=week).count(),
        "chat_active_30d": users.filter(chat_last_login_at__gte=month).count(),
        "suspended": users.filter(status=AccountStatus.SUSPENDED).count(),
        "workspaces": Workspace.objects.count(),
        "paid_subscriptions": paid.count(),
        "past_due": paid.filter(status="past_due").count(),
        "mrr_cents": mrr,
        "open_tickets": SupportTicket.objects.filter(status="open").count(),
        "failed_logins_24h": SecurityEvent.objects.filter(kind="login_failed", at__gte=day).count(),
        "rate_limited_24h": SecurityEvent.objects.filter(kind="rate_limited", at__gte=day).count(),
        "oidc_denied_24h": SecurityEvent.objects.filter(kind="oidc_denied", at__gte=day).count(),
    }
    backup = _status_file("backup")
    return render(
        request,
        "ops/dashboard.html",
        _ctx(
            request,
            stats=stats,
            health=component_status(COMPONENTS),
            backup=backup,
            recent_audit=AuditEvent.objects.select_related("actor")[:8],
        ),
    )


# --- users -------------------------------------------------------------------------


@ops_view("view_users")
def users(request):
    q = request.GET.get("q", "").strip()
    status = request.GET.get("status", "")
    qs = User.objects.all().order_by("-date_joined")
    if q:
        qs = qs.filter(Q(username__icontains=q) | Q(email__icontains=q) | Q(display_name__icontains=q))
    if status:
        qs = qs.filter(status=status)
    page = Paginator(qs, 25).get_page(request.GET.get("page"))
    return render(
        request, "ops/users.html", _ctx(request, page=page, q=q, status=status, statuses=AccountStatus.choices)
    )


@ops_view("view_users")
def user_detail(request, user_id):
    target = get_object_or_404(User, pk=user_id)
    matrix_user, devices, matrix_error = None, [], ""
    synapse = SynapseAdmin()
    if synapse.configured:
        try:
            matrix_user = synapse.user(target.matrix_id)
            if matrix_user is not None:
                devices = synapse.devices(target.matrix_id)
        except SynapseError as exc:
            matrix_error = str(exc)
    else:
        matrix_error = "Homeserver admin token not configured."
    return render(
        request,
        "ops/user_detail.html",
        _ctx(
            request,
            target=target,
            emails=EmailAddress.objects.filter(user=target),
            mfa=Authenticator.objects.filter(user=target),
            mfa_enabled=is_mfa_enabled(target),
            sessions=UserSession.objects.filter(user=target).count(),
            memberships=Membership.objects.filter(user=target).select_related("workspace"),
            events=SecurityEvent.objects.filter(user=target)[:20],
            matrix_user=matrix_user,
            devices=devices,
            matrix_error=matrix_error,
            staff_roles=StaffRole.choices,
        ),
    )


@ops_view("manage_users", step_up=True)
@require_POST
def user_suspend(request, user_id):
    target = get_object_or_404(User, pk=user_id)
    if target.pk == request.user.pk:
        messages.error(request, "You cannot suspend your own account.")
        return redirect("ops:user", user_id)
    suspend = request.POST.get("action") == "suspend"
    reason = request.POST.get("reason", "").strip()[:300]
    if suspend and not reason:
        messages.error(request, "A reason is required to suspend an account.")
        return redirect("ops:user", user_id)
    target.set_status(AccountStatus.SUSPENDED if suspend else AccountStatus.ACTIVE, reason)
    target.save()
    if suspend:
        end_all_sessions(target)
    synapse_note = ""
    synapse = SynapseAdmin()
    if synapse.configured:
        try:
            if synapse.user(target.matrix_id) is not None:
                synapse.set_suspended(target.matrix_id, suspend)
                if suspend:
                    n = synapse.logout_all(target.matrix_id)
                    synapse_note = f" Homeserver: suspended and {n} chat device(s) signed out."
                else:
                    synapse_note = " Homeserver: suspension lifted."
        except SynapseError as exc:
            synapse_note = f" Homeserver update failed ({exc}); retry from this page."
    security_event(request, "account_suspended", user=target, detail={"by": request.user.username, "suspended": suspend})
    audit(request, "ops.user_suspend" if suspend else "ops.user_unsuspend", target=target, metadata={"reason": reason})
    messages.success(request, ("Account suspended." if suspend else "Account reactivated.") + synapse_note)
    return redirect("ops:user", user_id)


@ops_view("manage_users", step_up=True)
@require_POST
def user_logout_chat(request, user_id):
    target = get_object_or_404(User, pk=user_id)
    try:
        n = SynapseAdmin().logout_all(target.matrix_id)
    except SynapseError as exc:
        messages.error(request, f"Could not sign out chat devices: {exc}")
        return redirect("ops:user", user_id)
    end_all_sessions(target)
    audit(request, "ops.user_logout_all", target=target, metadata={"chat_devices": n})
    messages.success(request, f"Signed out {n} chat device(s) and all portal sessions.")
    return redirect("ops:user", user_id)


@ops_view("manage_users", step_up=True)
@require_POST
def user_recovery_link(request, user_id):
    target = get_object_or_404(User, pk=user_id)
    if target.staff_role and not has_perm(request.user, "manage_staff"):
        messages.error(request, "Only the owner can issue recovery links for operators.")
        return redirect("ops:user", user_id)
    token = secrets.token_urlsafe(32)
    OperatorSetupToken.objects.create(
        user=target,
        token_hash=hash_token(token),
        purpose="recovery",
        expires_at=timezone.now() + timedelta(hours=1),
        created_by=request.user,
    )
    audit(request, "ops.recovery_link_issued", target=target)
    security_event(request, "recovery_link", user=target, detail={"issued_by": request.user.username})
    link = f"{settings.PUBLIC_BASE_URL}/setup/{token}/"
    return render(request, "ops/recovery_link.html", _ctx(request, target=target, link=link))


@ops_view("delete_users", step_up=True)
@require_POST
def user_reset_mfa(request, user_id):
    target = get_object_or_404(User, pk=user_id)
    if not _confirm(request, target.username):
        messages.error(request, "Type the username to confirm.")
        return redirect("ops:user", user_id)
    if target.staff_role and not has_perm(request.user, "manage_staff"):
        messages.error(request, "Only the owner can reset an operator's MFA.")
        return redirect("ops:user", user_id)
    n = Authenticator.objects.filter(user=target).count()
    Authenticator.objects.filter(user=target).delete()
    end_all_sessions(target)
    security_event(request, "mfa_disabled", user=target, detail={"reset_by": request.user.username})
    audit(request, "ops.mfa_reset", target=target, metadata={"authenticators_removed": n})
    messages.success(request, f"Removed {n} authenticator(s) and signed out portal sessions. The user should re-enrol MFA immediately.")
    return redirect("ops:user", user_id)


@ops_view("manage_staff", step_up=True)
@require_POST
def user_set_role(request, user_id):
    target = get_object_or_404(User, pk=user_id)
    role = request.POST.get("role", "")
    if role not in dict(StaffRole.choices):
        raise Http404()
    if target.pk == request.user.pk and role != StaffRole.OWNER:
        if not User.objects.filter(staff_role=StaffRole.OWNER, status=AccountStatus.ACTIVE).exclude(pk=target.pk).exists():
            messages.error(request, "You are the last owner; appoint another owner first.")
            return redirect("ops:user", user_id)
    old = target.staff_role
    target.staff_role = role
    target.save()
    if role and not is_mfa_enabled(target):
        messages.info(request, "This person must enrol MFA before they can use the console.")
    audit(request, "ops.staff_role", target=target, metadata={"from": old, "to": role})
    messages.success(request, f"Operator role set to {target.get_staff_role_display()}.")
    return redirect("ops:user", user_id)


@ops_view("delete_users", step_up=True)
@require_POST
def user_schedule_deletion(request, user_id):
    target = get_object_or_404(User, pk=user_id)
    if not _confirm(request, target.username):
        messages.error(request, "Type the username to confirm.")
        return redirect("ops:user", user_id)
    if target.staff_role:
        messages.error(request, "Remove the operator role before deleting this account.")
        return redirect("ops:user", user_id)
    immediate = request.POST.get("immediate") == "on"
    now = timezone.now()
    target.set_status(AccountStatus.PENDING_DELETION, f"scheduled by operator {request.user.username}")
    target.deletion_requested_at = now
    target.deletion_scheduled_for = now if immediate else now + timedelta(days=settings.RETENTION["deletion_grace_days"])
    target.save()
    end_all_sessions(target)
    audit(request, "ops.user_deletion_scheduled", target=target, metadata={"immediate": immediate})
    messages.success(
        request,
        "Deletion scheduled; the worker deactivates the Matrix account and removes portal data "
        + ("on its next run." if immediate else f"on {target.deletion_scheduled_for:%Y-%m-%d}."),
    )
    return redirect("ops:user", user_id)


# --- workspaces ----------------------------------------------------------------------


@ops_view("view_workspaces")
def workspaces(request):
    q = request.GET.get("q", "").strip()
    qs = Workspace.objects.annotate(member_count=Count("memberships")).select_related("subscription__plan").order_by("-created_at")
    if q:
        qs = qs.filter(Q(name__icontains=q) | Q(slug__icontains=q))
    page = Paginator(qs, 25).get_page(request.GET.get("page"))
    return render(request, "ops/workspaces.html", _ctx(request, page=page, q=q))


@ops_view("view_workspaces")
def workspace_detail(request, workspace_id):
    try:
        ws = Workspace.objects.select_related("subscription__plan").get(pk=workspace_id)
    except (Workspace.DoesNotExist, ValueError, ValidationError):
        raise Http404() from None
    sub = billing.ensure_subscription(ws)
    return render(
        request,
        "ops/workspace_detail.html",
        _ctx(
            request,
            ws=ws,
            sub=sub,
            effective=billing.workspace_plan(ws),
            members=ws.memberships.select_related("user"),
            invitations=ws.invitations.all()[:50],
            plans=Plan.objects.filter(active=True),
            invoices=sub.invoices.all()[:20],
        ),
    )


@ops_view("manage_billing", step_up=True)
@require_POST
def workspace_assign_plan(request, workspace_id):
    try:
        ws = Workspace.objects.get(pk=workspace_id)
    except (Workspace.DoesNotExist, ValueError, ValidationError):
        raise Http404() from None
    plan = get_object_or_404(Plan, code=request.POST.get("plan", ""))
    sub = billing.ensure_subscription(ws)
    if sub.provider == Subscription.Provider.STRIPE and sub.status in {"active", "trialing", "past_due"}:
        messages.error(request, "This workspace has an active Stripe subscription; change it in Stripe so both stay consistent.")
        return redirect("ops:workspace", workspace_id)
    period_end = None
    days = request.POST.get("days", "").strip()
    if days:
        try:
            period_end = timezone.now() + timedelta(days=max(1, min(int(days), 3660)))
        except ValueError:
            messages.error(request, "Duration must be a number of days.")
            return redirect("ops:workspace", workspace_id)
    note = request.POST.get("note", "")
    billing.assign_manual_plan(ws, plan, note=note, period_end=period_end)
    audit(request, "ops.plan_assigned", target=ws, metadata={"plan": plan.code, "days": days, "note": note[:100]})
    messages.success(request, f"{ws.name} is now on {plan.name} (manual billing).")
    return redirect("ops:workspace", workspace_id)


# --- plans -------------------------------------------------------------------------


@ops_view("view_billing")
def plans(request):
    return render(
        request,
        "ops/plans.html",
        _ctx(request, plans=Plan.objects.annotate(subs=Count("subscriptions")), labels=ENTITLEMENT_LABELS),
    )


def _int_or_none(value: str):
    value = (value or "").strip()
    if value == "":
        return None
    n = int(value)
    if n < 0:
        raise ValueError("negative")
    return n


@ops_view("manage_plans")
def plan_edit(request, plan_id=None):
    plan = get_object_or_404(Plan, pk=plan_id) if plan_id else Plan(entitlements={k: (False if t is bool else 0) for k, t in ENTITLEMENT_FIELDS.items()})
    errors = []
    if request.method == "POST":
        try:
            if not plan.pk:
                plan.code = request.POST.get("code", "").strip().lower()
                if not plan.code or Plan.objects.filter(code=plan.code).exists():
                    raise ValueError("Plan code must be unique and non-empty.")
            plan.name = request.POST.get("name", "").strip()[:80] or plan.name
            plan.tagline = request.POST.get("tagline", "").strip()[:200]
            plan.price_monthly_cents = _int_or_none(request.POST.get("price_monthly_cents"))
            plan.price_yearly_cents = _int_or_none(request.POST.get("price_yearly_cents"))
            plan.currency = (request.POST.get("currency") or settings.BILLING_CURRENCY).lower()[:3]
            plan.stripe_price_monthly = request.POST.get("stripe_price_monthly", "").strip()[:100]
            plan.stripe_price_yearly = request.POST.get("stripe_price_yearly", "").strip()[:100]
            plan.is_public = request.POST.get("is_public") == "on"
            plan.self_serve = request.POST.get("self_serve") == "on"
            plan.active = request.POST.get("active") == "on"
            plan.sort_order = int(request.POST.get("sort_order") or 100)
            ents = {}
            for key, cast in ENTITLEMENT_FIELDS.items():
                if cast is bool:
                    ents[key] = request.POST.get(f"ent_{key}") == "on"
                else:
                    ents[key] = int(request.POST.get(f"ent_{key}") or 0)
            plan.entitlements = billing.validate_entitlements(ents)
            plan.features = [line.strip() for line in request.POST.get("features", "").splitlines() if line.strip()][:20]
            if plan.is_free and not plan.active:
                raise ValueError("The free plan must stay active.")
        except ValueError as exc:
            errors.append(str(exc) if str(exc) else "Check the numeric fields.")
        else:
            created = plan.pk is None
            plan.save()
            audit(request, "ops.plan_created" if created else "ops.plan_updated", target=plan, metadata={"code": plan.code, "entitlements": plan.entitlements})
            messages.success(request, f"Plan {plan.name} saved. Entitlement changes apply immediately to every workspace on it.")
            return redirect("ops:plans")
    return render(
        request,
        "ops/plan_edit.html",
        _ctx(request, plan=plan, errors=errors, fields=[(k, ENTITLEMENT_LABELS[k], t is bool, plan.entitlements.get(k)) for k, t in ENTITLEMENT_FIELDS.items()]),
    )


# --- subscriptions & webhooks --------------------------------------------------------


@ops_view("view_billing")
def subscriptions(request):
    status = request.GET.get("status", "")
    qs = Subscription.objects.select_related("workspace", "plan").order_by("-updated_at")
    if status:
        qs = qs.filter(status=status)
    page = Paginator(qs, 30).get_page(request.GET.get("page"))
    return render(
        request, "ops/subscriptions.html", _ctx(request, page=page, status=status, statuses=Subscription.Status.choices, provider=get_provider())
    )


@ops_view("manage_billing")
@require_POST
def subscription_reconcile(request, sub_id):
    sub = get_object_or_404(Subscription, pk=sub_id)
    provider = get_provider()
    if not isinstance(provider, StripeProvider) or sub.provider != "stripe":
        messages.error(request, "Only Stripe subscriptions can be reconciled.")
    else:
        try:
            provider.reconcile(sub)
        except Exception as exc:  # network/provider errors
            messages.error(request, f"Reconciliation failed: {type(exc).__name__}")
        else:
            audit(request, "ops.subscription_reconciled", target=sub)
            messages.success(request, "Subscription refreshed from Stripe.")
    return redirect("ops:subscriptions")


@ops_view("view_billing")
def webhooks(request):
    events = WebhookEvent.objects.all()
    page = Paginator(events, 40).get_page(request.GET.get("page"))
    provider = get_provider()
    day = timezone.now() - timedelta(days=1)
    summary = {
        o: WebhookEvent.objects.filter(received_at__gte=day, outcome=o).count() for o in ["processed", "ignored", "failed", "rejected"]
    }
    last = WebhookEvent.objects.filter(outcome__in=["processed", "ignored"]).first()
    return render(
        request,
        "ops/webhooks.html",
        _ctx(
            request,
            page=page,
            provider=provider,
            summary=summary,
            last=last,
            webhook_url=f"{settings.PUBLIC_BASE_URL}/billing/webhooks/stripe/",
        ),
    )


# --- platform: health, federation, backups, wireguard, maintenance ----------------------------


@ops_view("view_platform")
def health(request):
    host, host_error = agent.safe_call("host.status", actor=request.user.username)
    history = {
        key: list(HealthSnapshot.objects.filter(component=key, at__gte=timezone.now() - timedelta(hours=24)).order_by("-at")[:48])
        for key, _ in COMPONENTS
    }
    return render(
        request,
        "ops/health.html",
        _ctx(request, rows=component_status(COMPONENTS), history=history, host=host, host_error=host_error),
    )


def calls_rates(newer: dict, older: dict) -> dict | None:
    """Rates between two `calls` probe samples (None across an SFU restart)."""
    dt = (newer.get("at") or 0) - (older.get("at") or 0)
    if dt <= 0 or newer.get("started_at") != older.get("started_at"):
        return None

    def avg(key):
        (s2, c2), (s1, c1) = newer.get(key, [0, 0]), older.get(key, [0, 0])
        return (s2 - s1) / (c2 - c1) if c2 > c1 else None

    jitter = avg("jitter_us")
    return {
        "mbps_in": max(0.0, (newer["bytes_in"] - older["bytes_in"]) * 8 / dt / 1e6),
        "mbps_out": max(0.0, (newer["bytes_out"] - older["bytes_out"]) * 8 / dt / 1e6),
        "cpu_pct": max(0.0, (newer["cpu_seconds"] - older["cpu_seconds"]) / dt * 100),
        "rtt_ms": avg("rtt_ms"),
        "jitter_ms": jitter / 1000 if jitter is not None else None,
        "loss_pct": avg("loss_pct"),
    }


@ops_view("view_platform")
def calls(request):
    snaps = list(HealthSnapshot.objects.filter(component="calls", status="ok").order_by("-at")[:31])
    rows = []
    for newer, older in zip(snaps, snaps[1:]):
        rows.append({"at": newer.at, "d": newer.detail, "r": calls_rates(newer.detail, older.detail)})
    selftest = None
    if request.method == "POST":
        if not has_perm(request.user, "manage_platform"):
            raise PermissionDenied
        selftest, err = agent.safe_call("calls.selftest", actor=request.user.username)
        if err:
            selftest = {"ok": False, "output": err}
        audit(request, "ops.calls_selftest", metadata={"ok": bool(selftest and selftest.get("ok"))})
    latest = snaps[0] if snaps else None
    probe = HealthSnapshot.objects.filter(component="calls").order_by("-at").first()
    turn = HealthSnapshot.objects.filter(component="turn").order_by("-at").first()
    config = {
        "enabled": settings.CALLS_ENABLED,
        "rtc_domain": settings.RTC_DOMAIN,
        "public_ip": settings.CALLS_PUBLIC_IP or "discovered with STUN",
        "ports": [
            (f"{settings.CALLS_UDP_PORTS}/udp", "WebRTC media (UDP mux)"),
            (f"{settings.CALLS_TCP_PORT}/tcp", "ICE over TCP when UDP is blocked"),
            (f"{settings.CALLS_TURN_UDP_PORT}/udp", "TURN relay"),
            ("443/tcp", "signalling (wss) through Caddy"),
        ],
    }
    return render(
        request,
        "ops/calls.html",
        _ctx(request, rows=rows[:30], latest=latest, rate=rows[0]["r"] if rows else None, probe=probe, turn=turn,
             config=config, selftest=selftest),
    )


@ops_view("view_platform")
def federation(request):
    synapse = SynapseAdmin()
    data, error = {}, ""
    if synapse.configured:
        try:
            data["version"] = synapse.server_version()
            data["counts"] = synapse.counts()
            data["destinations"] = synapse.federation_destinations().get("destinations", [])
            data["media"] = synapse.media_statistics().get("users", [])
            if has_perm(request.user, "view_security"):
                data["reports"] = synapse.event_reports().get("event_reports", [])
        except SynapseError as exc:
            error = str(exc)
    else:
        error = "Homeserver admin token not configured."
    probe = HealthSnapshot.objects.filter(component="federation").first()
    now_ms = timezone.now().timestamp() * 1000
    for d in data.get("destinations", []):
        d["failing"] = bool(d.get("failure_ts"))
        d["retry_in_s"] = max(0, int((d.get("retry_last_ts", 0) + d.get("retry_interval", 0) - now_ms) / 1000)) if d.get("retry_interval") else 0
    return render(
        request,
        "ops/federation.html",
        _ctx(
            request,
            data=data,
            error=error,
            probe=probe,
            mode=settings.FEDERATION_MODE,
            allowlist=settings.FEDERATION_ALLOWLIST,
            server_name=settings.MATRIX_SERVER_NAME,
        ),
    )


@ops_view("view_platform")
def backups(request):
    status, status_error = agent.safe_call("backup.status", actor=request.user.username)
    listing, _ = agent.safe_call("backup.list", actor=request.user.username)
    update, _ = agent.safe_call("update.status", actor=request.user.username)
    if status is None:
        status = _status_file("backup")
    if update is None:
        update = _status_file("update")
    return render(
        request,
        "ops/backups.html",
        _ctx(request, status=status, status_error=status_error, listing=listing, update=update),
    )


@ops_view("manage_platform", step_up=True)
@require_POST
def backup_run(request):
    result, error = agent.safe_call("backup.run", actor=request.user.username, timeout=10)
    audit(request, "ops.backup_requested", metadata={"accepted": error == ""})
    if error:
        messages.error(request, f"Backup could not be started: {error}")
    else:
        messages.success(request, f"Backup started (job {result.get('job', '?')}). Refresh this page to follow its status.")
    return redirect("ops:backups")


@ops_view("manage_platform", step_up=True)
@require_POST
def backup_verify(request):
    result, error = agent.safe_call("backup.verify", {"which": "latest"}, actor=request.user.username, timeout=10)
    audit(request, "ops.backup_verify_requested", metadata={"accepted": error == ""})
    if error:
        messages.error(request, f"Verification could not be started: {error}")
    else:
        messages.success(request, f"Restore verification started (job {result.get('job', '?')}) in an isolated environment.")
    return redirect("ops:backups")


@ops_view("view_platform")
def wireguard(request):
    status, error = agent.safe_call("wg.status", actor=request.user.username)
    new_peer = request.session.pop("lumen_wg_new_peer", None)
    qr_svg = ""
    if new_peer and new_peer.get("config"):
        import qrcode
        import qrcode.image.svg

        img = qrcode.make(new_peer["config"], image_factory=qrcode.image.svg.SvgPathImage, box_size=8)
        buf = io.BytesIO()
        img.save(buf)
        qr_svg = buf.getvalue().decode()
    return render(
        request,
        "ops/wireguard.html",
        _ctx(request, status=status, error=error, enabled=settings.WIREGUARD_ENABLED, new_peer=new_peer, qr_svg=qr_svg),
    )


@ops_view("manage_wireguard", step_up=True)
@require_POST
def wireguard_add_peer(request):
    name = request.POST.get("name", "").strip()
    public_key = request.POST.get("public_key", "").strip()
    args = {"name": name}
    if public_key:
        args["public_key"] = public_key
    result, error = agent.safe_call("wg.add_peer", args, actor=request.user.username)
    audit(request, "ops.wg_peer_added", metadata={"name": name, "client_generated_key": bool(public_key), "ok": not error, "public_key": (result or {}).get("public_key", "")})
    if error:
        messages.error(request, f"Could not add peer: {error}")
        return redirect("ops:wireguard")
    # The private key (if generated) lives only in this one-time session value.
    request.session["lumen_wg_new_peer"] = {"name": name, "config": result.get("config", ""), "public_key": result.get("public_key", ""), "address": result.get("address", "")}
    messages.success(request, f"Peer {name} added.")
    return redirect("ops:wireguard")


@ops_view("manage_wireguard")
def wireguard_download(request):
    peer = request.session.get("lumen_wg_new_peer")
    if not peer or not peer.get("config"):
        raise Http404()
    request.session.pop("lumen_wg_new_peer", None)
    resp = HttpResponse(peer["config"], content_type="text/plain")
    resp["Content-Disposition"] = f'attachment; filename="lumen-{peer["name"][:30] or "peer"}.conf"'
    resp["Cache-Control"] = "no-store"
    audit(request, "ops.wg_profile_downloaded", metadata={"name": peer["name"]})
    return resp


@ops_view("manage_wireguard", step_up=True)
@require_POST
def wireguard_remove_peer(request):
    public_key = request.POST.get("public_key", "").strip()
    result, error = agent.safe_call("wg.remove_peer", {"public_key": public_key}, actor=request.user.username)
    audit(request, "ops.wg_peer_removed", metadata={"public_key": public_key, "ok": not error})
    if error:
        messages.error(request, f"Could not remove peer: {error}")
    else:
        messages.success(request, "Peer removed; its key no longer works.")
    return redirect("ops:wireguard")


RESTARTABLE = ["portal", "worker", "synapse", "caddy", "coturn"]


@ops_view("view_platform")
def maintenance(request):
    diag = request.session.pop("lumen_diag", None)
    return render(
        request,
        "ops/maintenance.html",
        _ctx(
            request,
            maintenance_mode=runtime.get("maintenance_mode"),
            maintenance_message=runtime.get("maintenance_message"),
            registration_mode=runtime.registration_mode(),
            announcement=runtime.get("announcement"),
            restartable=RESTARTABLE,
            diag=diag,
        ),
    )


@ops_view("manage_platform")
@require_POST
def maintenance_settings(request):
    mode = request.POST.get("registration_mode", "")
    try:
        runtime.set_value("maintenance_mode", request.POST.get("maintenance_mode") == "on", request.user)
        runtime.set_value("maintenance_message", request.POST.get("maintenance_message", "")[:300], request.user)
        runtime.set_value("announcement", request.POST.get("announcement", "")[:300], request.user)
        runtime.set_value("registration_mode", mode, request.user)
    except ValueError:
        messages.error(request, "Invalid registration mode.")
        return redirect("ops:maintenance")
    audit(request, "ops.runtime_settings", metadata={"maintenance_mode": request.POST.get("maintenance_mode") == "on", "registration_mode": mode})
    messages.success(request, "Settings saved.")
    return redirect("ops:maintenance")


@ops_view("manage_platform", step_up=True)
@require_POST
def service_restart(request):
    service = request.POST.get("service", "")
    if service not in RESTARTABLE or not _confirm(request, service):
        messages.error(request, "Choose a service and type its name to confirm.")
        return redirect("ops:maintenance")
    result, error = agent.safe_call("service.restart", {"service": service}, actor=request.user.username, timeout=90)
    audit(request, "ops.service_restart", metadata={"service": service, "ok": not error})
    if error:
        messages.error(request, f"Restart failed: {error}")
    else:
        messages.success(request, f"{service} restarted and reported {result.get('state', 'unknown')}.")
    return redirect("ops:maintenance")


@ops_view("manage_platform")
@require_POST
def diagnostics_run(request):
    result, error = agent.safe_call("diagnose.run", actor=request.user.username, timeout=120)
    audit(request, "ops.diagnostics_run", metadata={"ok": not error})
    request.session["lumen_diag"] = {"error": error, "output": (result or {}).get("output", "")[:20000], "exit_code": (result or {}).get("exit_code")}
    return redirect("ops:maintenance")


# --- security & audit ---------------------------------------------------------------


@ops_view("view_security")
def security(request):
    kind = request.GET.get("kind", "")
    qs = SecurityEvent.objects.select_related("user")
    if kind:
        qs = qs.filter(kind=kind)
    page = Paginator(qs, 40).get_page(request.GET.get("page"))
    day = timezone.now() - timedelta(days=1)
    week = timezone.now() - timedelta(days=7)
    counts = (
        SecurityEvent.objects.filter(at__gte=week)
        .values("kind")
        .annotate(week=Count("id"), day=Count("id", filter=Q(at__gte=day)))
        .order_by("-week")
    )
    top_ips = (
        SecurityEvent.objects.filter(at__gte=day, kind__in=["login_failed", "rate_limited", "mfa_failed"])
        .values("ip")
        .annotate(n=Count("id"))
        .order_by("-n")[:10]
    )
    tls = HealthSnapshot.objects.filter(component="tls").order_by("-at").first()
    transport = []
    if tls:
        for host, info in sorted(tls.detail.items()):
            if isinstance(info, dict) and "seconds_left" in info:
                group = info.get("key_exchange") or ""
                transport.append({"host": host, "group": group or "not measured", "hybrid_pq": group in HYBRID_PQ_GROUPS, "tls": info.get("tls_version", "")})
    return render(
        request,
        "ops/security.html",
        _ctx(request, page=page, kind=kind, kinds=SecurityEvent.Kind.choices, counts=counts, top_ips=top_ips, tls=tls, transport=transport),
    )


@ops_view("view_audit")
def audit_log(request):
    qs = AuditEvent.objects.select_related("actor")
    action = request.GET.get("action", "")
    if action:
        qs = qs.filter(action__startswith=action)
    page = Paginator(qs, 50).get_page(request.GET.get("page"))
    verify = request.session.pop("lumen_audit_verify", None)
    return render(request, "ops/audit.html", _ctx(request, page=page, action=action, verify=verify))


@ops_view("view_audit")
@require_POST
def audit_verify(request):
    from apps.core.auditchain import verify_chain

    result = verify_chain()
    request.session["lumen_audit_verify"] = result
    audit(request, "ops.audit_verified", metadata={"ok": result["ok"], "checked": result["checked"]})
    return redirect("ops:audit")


@ops_view("view_platform")
def config(request):
    provider = get_provider()
    items = [
        ("Primary domain", settings.PRIMARY_DOMAIN),
        ("Chat app", settings.APP_BASE_URL),
        ("Homeserver", settings.MATRIX_BASE_URL),
        ("Matrix server name", settings.MATRIX_SERVER_NAME),
        ("Operator console", settings.OPS_BASE_URL),
        ("Federation mode", settings.FEDERATION_MODE),
        ("Federation allowlist", ", ".join(settings.FEDERATION_ALLOWLIST) or "—"),
        ("Registration mode", runtime.registration_mode()),
        ("Email delivery", "configured" if settings.EMAIL_ENABLED else "not configured"),
        ("Payment provider", f"{provider.label} ({'configured' if provider.is_configured() else 'not configured'})"),
        ("Voice/video (TURN)", "enabled" if settings.VOIP_ENABLED else "disabled"),
        ("WireGuard", "enabled" if settings.WIREGUARD_ENABLED else "disabled"),
        ("Operator MFA required", "yes" if settings.OPS_REQUIRE_MFA else "NO (insecure)"),
        ("Portal session idle timeout", f"{settings.SESSION_IDLE_TIMEOUT // 60} min (portal), console uses its own"),
        ("Homeserver admin token", "present" if settings.SYNAPSE_ADMIN_TOKEN else "missing"),
        ("Internal API token", "present" if settings.INTERNAL_API_TOKEN else "missing"),
        ("Gateway secret", "present" if settings.OPS_GATEWAY_SECRET else "missing"),
        ("Version", settings.LUMEN_VERSION),
    ]
    return render(request, "ops/config.html", _ctx(request, items=items, retention=settings.RETENTION))


# --- support ---------------------------------------------------------------------------


@ops_view("view_users")
def support(request):
    status = request.GET.get("status", "open")
    qs = SupportTicket.objects.select_related("user")
    if status:
        qs = qs.filter(status=status)
    page = Paginator(qs.order_by("-priority", "-created_at"), 30).get_page(request.GET.get("page"))
    return render(request, "ops/support.html", _ctx(request, page=page, status=status, statuses=SupportTicket.Status.choices))


@ops_view("view_users")
def support_ticket(request, ticket_id):
    try:
        ticket = SupportTicket.objects.select_related("user").get(pk=ticket_id)
    except (SupportTicket.DoesNotExist, ValueError, ValidationError):
        raise Http404() from None
    if request.method == "POST":
        if not has_perm(request.user, "manage_support"):
            messages.error(request, "Your role cannot update tickets.")
            return redirect("ops:ticket", ticket_id)
        new_status = request.POST.get("status", ticket.status)
        if new_status in dict(SupportTicket.Status.choices):
            ticket.status = new_status
        ticket.internal_note = request.POST.get("internal_note", "")[:5000]
        ticket.handled_by = request.user
        ticket.save()
        audit(request, "ops.ticket_updated", target=ticket, metadata={"status": ticket.status})
        messages.success(request, "Ticket updated.")
        return redirect("ops:ticket", ticket_id)
    return render(request, "ops/ticket.html", _ctx(request, ticket=ticket, statuses=SupportTicket.Status.choices))
