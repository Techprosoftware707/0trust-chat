from __future__ import annotations

import re
import time
import uuid

from django.conf import settings
from django.contrib import messages
from django.contrib.auth import logout
from django.http import Http404
from django.shortcuts import redirect

from .logging import request_id_var

_REQUEST_ID_RE = re.compile(r"^[A-Za-z0-9-]{8,64}$")


class RequestContextMiddleware:
    """Assigns a request ID (propagated from Caddy when well-formed)."""

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        rid = request.META.get("HTTP_X_REQUEST_ID", "")
        if not _REQUEST_ID_RE.match(rid):
            rid = uuid.uuid4().hex
        request.request_id = rid
        token = request_id_var.set(rid)
        try:
            response = self.get_response(request)
        finally:
            request_id_var.reset(token)
        response["X-Request-Id"] = rid
        return response


class NexusEnvironmentMiddleware:
    """Labels every response with the deployment's environment (production, test,
    development) so API clients and people can tell a test build from a real one."""

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        response = self.get_response(request)
        response["X-Nexus-Environment"] = settings.NEXUS_ENVIRONMENT
        return response


class SurfaceGuardMiddleware:
    """Defence in depth: the public process never serves ops/internal paths."""

    PUBLIC_FORBIDDEN = ("/ops/", "/internal/")

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        if settings.SURFACE == "public" and request.path.startswith(self.PUBLIC_FORBIDDEN):
            raise Http404()
        return self.get_response(request)


class SessionIdleTimeoutMiddleware:
    """Ends sessions that have been idle longer than SESSION_IDLE_TIMEOUT."""

    KEY = "_lumen_last_seen"

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        user = getattr(request, "user", None)
        if user is not None and user.is_authenticated:
            now = int(time.time())
            last = request.session.get(self.KEY)
            if last is not None and now - int(last) > settings.SESSION_IDLE_TIMEOUT:
                logout(request)
                messages.info(request, "You were signed out after a period of inactivity.")
                return redirect(settings.LOGIN_URL)
            if last is None or now - int(last) > 60:
                request.session[self.KEY] = now
        return self.get_response(request)


class AccountStatusMiddleware:
    """Signs out suspended or deleted accounts on their next request."""

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        user = getattr(request, "user", None)
        if user is not None and user.is_authenticated and getattr(user, "status", "active") in {"suspended", "deleted"}:
            logout(request)
            messages.error(request, "This account is not active. Contact support if you think this is a mistake.")
            return redirect(settings.LOGIN_URL)
        return self.get_response(request)


class SecurityHeadersMiddleware:
    PERMISSIONS_POLICY = (
        "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), "
        "microphone=(), payment=(), usb=(), interest-cohort=()"
    )

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        response = self.get_response(request)
        response.setdefault("Permissions-Policy", self.PERMISSIONS_POLICY)
        response.setdefault("Cross-Origin-Resource-Policy", "same-origin")
        user = getattr(request, "user", None)
        if (user is not None and user.is_authenticated) or settings.SURFACE == "ops":
            response["Cache-Control"] = "no-store"
        return response
