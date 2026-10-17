from __future__ import annotations

from datetime import timedelta

from django import forms
from django.conf import settings
from django.contrib import messages
from django.db import connection
from django.http import Http404, HttpResponse, JsonResponse
from django.shortcuts import redirect, render
from django.utils import timezone
from django.views.decorators.cache import cache_control
from django.views.decorators.http import require_GET, require_http_methods

from . import ratelimit
from .models import HealthSnapshot, SupportTicket


def _plans_for_pricing():
    from apps.billing.models import Plan
    from apps.billing.providers import get_provider

    provider = get_provider()
    plans = list(Plan.objects.filter(active=True, is_public=True).order_by("sort_order"))
    rows = []
    for plan in plans:
        rows.append(
            {
                "plan": plan,
                "purchasable": provider.can_checkout(plan, "month"),
            }
        )
    return rows, provider


@require_GET
def home(request):
    rows, provider = _plans_for_pricing()
    return render(request, "site/home.html", {"plans": rows[:3], "provider": provider})


@require_GET
def features(request):
    return render(request, "site/features.html")


@require_GET
def security(request):
    return render(request, "site/security.html")


@require_GET
def zero_trust(request):
    return render(request, "site/zero_trust.html")


@require_GET
def federation(request):
    return render(request, "site/federation.html")


@require_GET
def pricing(request):
    from apps.billing.models import ENTITLEMENT_LABELS

    rows, provider = _plans_for_pricing()
    return render(
        request,
        "site/pricing.html",
        {"plans": rows, "provider": provider, "entitlement_labels": ENTITLEMENT_LABELS, "grace_days": settings.BILLING_GRACE_DAYS},
    )


DOCS = [
    ("getting-started", "Getting started", "Create an account, open the chat app and set up encryption recovery."),
    ("encryption", "Encryption & verification", "How end-to-end encryption, verification and recovery keys work."),
    ("devices", "Devices & sessions", "Sign in on new devices, verify them and sign out old ones."),
    ("workspaces", "Workspaces & invitations", "Invite your team, manage roles and require MFA."),
    ("billing", "Plans & billing", "What each plan includes and how billing works."),
    ("federation", "Matrix & federation", "Talk to people on other Matrix servers and use other Matrix apps."),
    ("account-recovery", "Account recovery", "What to do if you lose your password, MFA device or recovery key."),
    ("self-hosting", "Self-hosting", "Run your own Lumen server on Ubuntu 24.04 with one command."),
]
DOC_SLUGS = {slug for slug, *_ in DOCS}


@require_GET
def docs_index(request):
    return render(request, "docs/index.html", {"docs": DOCS})


@require_GET
def docs_article(request, slug: str):
    if slug not in DOC_SLUGS:
        raise Http404()
    title = next(t for s, t, _ in DOCS if s == slug)
    return render(request, f"docs/{slug}.html", {"docs": DOCS, "slug": slug, "doc_title": title})


@require_GET
def download(request):
    return render(request, "site/download.html")


PUBLIC_COMPONENTS = [
    ("website", "Website & accounts"),
    ("chat_app", "Web chat app"),
    ("homeserver", "Messaging homeserver"),
    ("federation", "Federation"),
]


def component_status(components):
    rows = []
    cutoff = timezone.now() - timedelta(minutes=10)
    for key, label in components:
        snap = HealthSnapshot.objects.filter(component=key).order_by("-at").first()
        status = snap.status if snap and snap.at >= cutoff else "unknown"
        rows.append({"key": key, "label": label, "status": status, "snapshot": snap})
    return rows


@require_GET
def status(request):
    if not settings.PUBLIC_STATUS_PAGE:
        raise Http404()
    rows = component_status(PUBLIC_COMPONENTS)
    known = [r for r in rows if r["status"] != "unknown"]
    if not known:
        overall = "unknown"
    elif all(r["status"] == "ok" for r in known) and len(known) == len(rows):
        overall = "ok"
    elif any(r["status"] == "failed" for r in known):
        overall = "failed"
    else:
        overall = "degraded"
    return render(request, "site/status.html", {"rows": rows, "overall": overall})


class ContactForm(forms.Form):
    TOPICS = [
        ("general", "General question"),
        ("sales", "Sales & enterprise"),
        ("support", "Account or technical support"),
        ("privacy", "Privacy request"),
        ("security", "Security report"),
    ]
    name = forms.CharField(max_length=120)
    email = forms.EmailField()
    topic = forms.ChoiceField(choices=TOPICS)
    subject = forms.CharField(max_length=160)
    message = forms.CharField(widget=forms.Textarea(attrs={"rows": 7}), max_length=5000)
    # Honeypot: real people never see or fill this field.
    website = forms.CharField(required=False, widget=forms.TextInput(attrs={"tabindex": "-1", "autocomplete": "off"}))


@require_http_methods(["GET", "POST"])
def contact(request):
    initial = {}
    if request.user.is_authenticated:
        initial = {"name": request.user.name, "email": request.user.email}
    if request.GET.get("topic") in dict(ContactForm.TOPICS):
        initial["topic"] = request.GET["topic"]
    form = ContactForm(request.POST or None, initial=initial)
    if request.method == "POST":
        decision = ratelimit.check_request(request, "contact", limit=5, window_seconds=3600)
        if not decision.allowed:
            messages.error(request, "Too many messages from your network. Please try again later.")
            return render(request, "site/contact.html", {"form": form}, status=429)
        if form.is_valid():
            if form.cleaned_data.get("website"):
                # Bot: accept silently without storing.
                messages.success(request, "Thanks — your message was received.")
                return redirect("site:contact")
            priority = SupportTicket.Priority.NORMAL
            user = request.user if request.user.is_authenticated else None
            if user is not None:
                from apps.billing.services import user_entitlements

                if user_entitlements(user).priority_support:
                    priority = SupportTicket.Priority.HIGH
            if form.cleaned_data["topic"] == "security":
                priority = SupportTicket.Priority.HIGH
            ticket = SupportTicket.objects.create(
                user=user,
                name=form.cleaned_data["name"],
                email=form.cleaned_data["email"],
                topic=form.cleaned_data["topic"],
                subject=form.cleaned_data["subject"],
                message=form.cleaned_data["message"],
                priority=priority,
            )
            messages.success(
                request,
                f"Thanks — your message was received (reference {str(ticket.id)[:8]}). We reply by email.",
            )
            return redirect("site:contact")
    return render(request, "site/contact.html", {"form": form})


@require_GET
def privacy(request):
    return render(request, "site/privacy.html", {"retention": settings.RETENTION})


@require_GET
def terms(request):
    return render(request, "site/terms.html")


@require_GET
def disclosure(request):
    return render(request, "site/disclosure.html")


@require_GET
@cache_control(max_age=3600, public=True)
def security_txt(request):
    expires = (timezone.now() + timedelta(days=180)).strftime("%Y-%m-%dT%H:%M:%SZ")
    body = (
        f"Contact: mailto:{settings.BRAND['security_email']}\n"
        f"Expires: {expires}\n"
        f"Policy: {settings.PUBLIC_BASE_URL}/security/disclosure/\n"
        "Preferred-Languages: en\n"
        f"Canonical: {settings.PUBLIC_BASE_URL}/.well-known/security.txt\n"
    )
    return HttpResponse(body, content_type="text/plain; charset=utf-8")


@require_GET
def robots_txt(request):
    body = "User-agent: *\nDisallow: /portal/\nDisallow: /accounts/\nDisallow: /identity/\nDisallow: /invite/\n"
    return HttpResponse(body, content_type="text/plain")


@require_GET
def healthz(request):
    """Liveness + database readiness. Exposes no configuration details."""
    try:
        with connection.cursor() as cur:
            cur.execute("SELECT 1")
            cur.fetchone()
        db_ok = True
    except Exception:
        db_ok = False
    return JsonResponse({"status": "ok" if db_ok else "degraded", "db": db_ok}, status=200 if db_ok else 503)


def csrf_failure(request, reason="", template_name=None):
    return render(request, "site/csrf_failure.html", status=403)


def ops_root(request):
    return redirect("ops:dashboard")
