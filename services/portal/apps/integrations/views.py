"""Public (non-API) views at /integrations/: the OAuth begin/callback pair, provider webhooks
and, in mock mode only, the local fake consent page.

* ``begin`` and ``callback`` need the portal session of the person who started connecting
  (login CSRF: a callback is accepted only in the browser session that began the flow).
* Webhooks are authenticated by their signatures only (no session, CSRF-exempt), rate
  limited per IP, size limited, and answer quickly.
* Results go back to the app as ``#/integrations?connected=<provider>`` or
  ``?error=<code>``: never a provider message.
"""

from __future__ import annotations

import logging
from urllib.parse import urlencode

from django.contrib.auth.views import redirect_to_login
from django.core.exceptions import PermissionDenied
from django.http import Http404, HttpResponse, HttpResponseBadRequest, HttpResponseRedirect, JsonResponse
from django.shortcuts import render
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_GET, require_http_methods, require_POST

from apps.core import ratelimit
from apps.core.audit import security_event

from . import conf, http, oauth, webhooks
from .models import Provider

log = logging.getLogger("nexus.integrations")


def _back(**params) -> HttpResponseRedirect:
    response = HttpResponseRedirect(conf.app_url("#/integrations" + ("?" + urlencode(params) if params else "")))
    response["Cache-Control"] = "no-store"
    response["Referrer-Policy"] = "no-referrer"
    return response


@require_GET
def oauth_begin(request):
    token = request.GET.get("s", "")
    if not token or len(token) > 2000:
        return HttpResponseBadRequest("Missing connection state.")
    if not request.user.is_authenticated:
        return redirect_to_login(request.get_full_path())
    decision = ratelimit.check_request(request, "integrations-oauth", limit=30, window_seconds=300, per_user=True)
    if not decision.allowed:
        return _back(error="rate_limited")
    try:
        url = oauth.begin(request, token)
    except oauth.FlowError as exc:
        security_event(request, "integration_oauth_rejected", detail={"stage": "begin", "reason": exc.code})
        return _back(error=exc.code)
    response = HttpResponseRedirect(url)
    response["Cache-Control"] = "no-store"
    response["Referrer-Policy"] = "no-referrer"
    return response


@require_GET
def oauth_callback(request, slug: str):
    provider = conf.SLUG_PROVIDER.get(slug)
    if provider is None:
        raise Http404()
    if not request.user.is_authenticated:
        return _back(error="not_signed_in")
    decision = ratelimit.check_request(request, "integrations-oauth", limit=30, window_seconds=300, per_user=True)
    if not decision.allowed:
        return _back(error="rate_limited")
    try:
        conn = oauth.complete(request, provider, code=request.GET.get("code", ""), token=request.GET.get("state") or None,
                              error=request.GET.get("error") or None)
    except oauth.FlowError as exc:
        if exc.code.startswith(("state_", "session_", "wrong_user")):
            security_event(request, "integration_oauth_rejected", detail={"stage": "callback", "reason": exc.code, "provider": provider})
        return _back(error=exc.code, provider=provider)
    except (PermissionDenied, Http404):
        return _back(error="not_allowed", provider=provider)
    return _back(connected=provider, connection=str(conn.pk))


# --- mock consent (development / test only) ---------------------------------------------------------------


MOCK_PROVIDERS = {"google": Provider.GMAIL, "slack": Provider.SLACK, "crm-connector": Provider.GOHIGHLEVEL}


@require_http_methods(["GET", "POST"])
def mock_authorize(request, slug: str):
    """Stands in for the provider's consent screen when NEXUS_INTEGRATIONS_MOCK is on (never
    in production). Labelled "Mock provider (development)"."""
    if not conf.mock_mode():
        raise Http404()
    provider = MOCK_PROVIDERS.get(slug)
    if provider is None:
        raise Http404()
    if not request.user.is_authenticated:
        return redirect_to_login(request.get_full_path())
    params = request.GET if request.method == "GET" else request.POST
    redirect_uri = params.get("redirect_uri", "")
    state = params.get("state", "")
    if redirect_uri != conf.redirect_uri(provider):
        return HttpResponseBadRequest("Unknown redirect URI.")
    spec = conf.spec(provider)
    if request.method == "POST":
        if request.POST.get("decision") != "allow":
            return HttpResponseRedirect(f"{redirect_uri}?{urlencode({'error': 'access_denied', 'state': state})}")
        transport = http.get_transport()
        fake = transport.provider(provider)
        account = _mock_account(request.user)
        scope = params.get("scope", "")
        if provider == Provider.GMAIL and request.POST.get("readonly_only") == "1":
            scope = "https://www.googleapis.com/auth/gmail.readonly"
        code = fake.issue_code(account=account, challenge=params.get("code_challenge", ""), method=params.get("code_challenge_method", ""),
                               redirect_uri=redirect_uri, extra={"scope": scope.replace(" ", ",") if provider == Provider.SLACK else scope})
        query = {"code": code}
        if state and not (provider == Provider.GOHIGHLEVEL and request.POST.get("drop_state") == "1"):
            query["state"] = state
        return HttpResponseRedirect(f"{redirect_uri}?{urlencode(query)}")
    scopes = [s for s in params.get("scope", "").replace(",", " ").split() if s]
    return render(request, "integrations/mock_authorize.html", {
        "provider_label": spec.label, "mock_label": conf.MOCK_LABEL, "scopes": scopes, "params": params.items(),
        "account": _mock_account(request.user), "is_gmail": provider == Provider.GMAIL,
    })


def _mock_account(user) -> str:
    email = (user.email or "").lower()
    if email.endswith(("@example.com", "@example.org", "@example.net")):
        return email
    return f"{user.username}.mock@example.com"


# --- webhooks ---------------------------------------------------------------------------------------------


def _webhook_response(outcome: webhooks.Outcome) -> HttpResponse:
    if isinstance(outcome.body, str):
        response = HttpResponse(outcome.body, status=outcome.status, content_type=outcome.content_type)
    else:
        response = JsonResponse(outcome.body, status=outcome.status)
    response["Cache-Control"] = "no-store"
    return response


@csrf_exempt
@require_POST
def slack_events(request):
    decision = ratelimit.check_request(request, "webhook-slack", limit=1200, window_seconds=60)
    if not decision.allowed:
        return HttpResponse(status=429, headers={"Retry-After": str(decision.retry_after)})
    outcome = webhooks.handle_slack(request.body, request.headers)
    if outcome.outcome.startswith("rejected"):
        security_event(request, "webhook_rejected", detail={"provider": "slack", "reason": outcome.outcome[9:][:40]})
    return _webhook_response(outcome)


@csrf_exempt
@require_POST
def ghl_events(request):
    decision = ratelimit.check_request(request, "webhook-ghl", limit=1200, window_seconds=60)
    if not decision.allowed:
        return HttpResponse(status=429, headers={"Retry-After": str(decision.retry_after)})
    outcome = webhooks.handle_ghl(request.body, request.headers)
    if outcome.outcome.startswith("rejected"):
        security_event(request, "webhook_rejected", detail={"provider": "gohighlevel", "reason": outcome.outcome[9:][:40]})
    return _webhook_response(outcome)
