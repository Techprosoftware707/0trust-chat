from __future__ import annotations

from allauth.idp.oidc.views import authorization as allauth_authorization
from django.conf import settings
from django.shortcuts import render
from django.urls import reverse
from django.utils import timezone

from apps.core.audit import security_event

from .policy import chat_signin_decision


def _login_required_redirect(request):
    """``prompt=none`` without a portal session: answer ``login_required`` to the client
    (OIDC Core 3.1.2.6) instead of showing a login page. Only to a redirect URI registered
    for that client; anything else gets the plain error page (no open redirect).

    (allauth itself fails with a server error here for requests without the ``openid``
    scope, e.g. the workspace SPA's silent sign-in.)"""
    from allauth.idp.oidc.internal.clientkit import is_redirect_uri_allowed
    from allauth.idp.oidc.models import Client
    from django.http import HttpResponse
    from django.utils.http import urlencode

    client = Client.objects.filter(id=request.GET.get("client_id", "")[:100]).first()
    redirect_uri = request.GET.get("redirect_uri", "")
    if client is None or not redirect_uri or not is_redirect_uri_allowed(redirect_uri, client.get_redirect_uris(), client.allow_uri_wildcards):
        from allauth.idp.oidc.internal.oauthlib.utils import respond_html_error
        from oauthlib.oauth2.rfc6749 import errors

        response = respond_html_error(request, error=errors.InvalidRequestFatalError(description="Unknown client or redirect URI."))
        response.status_code = 400
        return response
    params = {"error": "login_required"}
    if request.GET.get("state"):
        params["state"] = request.GET["state"][:500]
    response = HttpResponse(status=302)
    response["Location"] = f"{redirect_uri}{'&' if '?' in redirect_uri else '?'}{urlencode(params)}"
    return response


def authorize(request, *args, **kwargs):
    """Wraps allauth's OIDC authorization endpoint with Lumen's policy.

    Unauthenticated users fall through to allauth, which redirects to login
    (including MFA), except for ``prompt=none`` (answered with ``login_required``).
    Authenticated users are checked before a code is issued.
    """
    user = request.user
    if not user.is_authenticated and "none" in request.GET.get("prompt", "").split():
        return _login_required_redirect(request)
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
        client_id = request.GET.get("client_id", "")[:60]
        security_event(request, "oidc_granted", user=user, detail={"client": client_id})
        if client_id != settings.SYNAPSE_OIDC_CLIENT_ID:
            return response  # e.g. the workspace SPA (nexus-web): not a chat sign-in
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
