"""Access control for the private operator console.

Layers (all must pass):
1. Network: Caddy serves the console only on the admin listener
   (loopback / WireGuard / configured CIDRs).
2. Gateway secret: Caddy injects ``X-Lumen-Gateway``; requests that reach
   this process any other way (e.g. from another container) get a 404.
3. Operator role: only accounts with a staff role may sign in.
4. MFA: operators must enrol a second factor before using the console.
5. Per-view RBAC and step-up re-authentication for sensitive actions.
"""

from __future__ import annotations

import hmac

from allauth.mfa.utils import is_mfa_enabled
from django.conf import settings
from django.contrib import messages
from django.contrib.auth import logout
from django.http import Http404
from django.shortcuts import redirect, render

EXEMPT_PREFIXES = ("/healthz", "/internal/", "/static/")
MFA_SETUP_PREFIXES = ("/accounts/", "/setup/")


class OpsAccessMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def _applies(self, request) -> bool:
        if settings.SURFACE == "ops":
            return not request.path.startswith(EXEMPT_PREFIXES)
        if settings.SURFACE == "test":
            return request.path.startswith("/ops/")
        return False

    def __call__(self, request):
        if not self._applies(request):
            return self.get_response(request)
        supplied = request.META.get("HTTP_X_LUMEN_GATEWAY", "")
        expected = settings.OPS_GATEWAY_SECRET
        if not expected or not hmac.compare_digest(supplied.encode(), expected.encode()):
            raise Http404()
        user = getattr(request, "user", None)
        if user is not None and user.is_authenticated:
            if not user.is_operator:
                from apps.core.audit import security_event

                security_event(request, "ops_access_denied", user=user, detail={"reason": "not_operator", "path": request.path[:100]})
                logout(request)
                return render(request, "ops/forbidden.html", status=403)
            if settings.OPS_REQUIRE_MFA and not is_mfa_enabled(user) and not request.path.startswith(MFA_SETUP_PREFIXES):
                messages.warning(request, "Operators must set up two-factor authentication before using the console.")
                return redirect("mfa_index")
        return self.get_response(request)
