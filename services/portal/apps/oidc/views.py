from __future__ import annotations

from allauth.idp.oidc.views import authorization as allauth_authorization
from django.conf import settings
from django.shortcuts import render
from django.urls import reverse
from django.utils import timezone

from apps.core.audit import security_event

from .policy import chat_signin_decision


def authorize(request, *args, **kwargs):
    """Wraps allauth's OIDC authorization endpoint with Lumen's policy.

    Unauthenticated users fall through to allauth, which redirects to login
    (including MFA). Authenticated users are checked before a code is issued.
    """
    user = request.user
    if user.is_authenticated:
        decision = chat_signin_decision(user)
        if not decision.allowed:
            security_event(request, "oidc_denied", user=user, detail={"reason": decision.reason})
            action_url = reverse(decision.action_url_name) if decision.action_url_name else ""
            return render(
                request,
                "portal/chat_signin_denied.html",
                {"decision": decision, "action_url": action_url, "retry_url": request.get_full_path()},
                status=403,
            )
    response = allauth_authorization(request, *args, **kwargs)
    if user.is_authenticated and response.status_code in (301, 302) and "code=" in response.get("Location", ""):
        security_event(request, "oidc_granted", user=user, detail={"client": request.GET.get("client_id", "")[:60]})
        now = timezone.now()
        fields = ["chat_last_login_at"]
        user.chat_last_login_at = now
        if user.chat_first_login_at is None:
            user.chat_first_login_at = now
            fields.append("chat_first_login_at")
        user.save(update_fields=fields)
    return response


def matrix_client_redirect(request):
    """Convenience: /chat sends people to the web client."""
    from django.shortcuts import redirect

    return redirect(settings.APP_BASE_URL)
