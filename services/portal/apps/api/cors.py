"""CORS for the JSON API and the OAuth token/revoke endpoints.

The workspace SPA runs on the chat app's origin (``app.<domain>``) and calls the portal
(``<domain>``) with a bearer token. Only origins in ``settings.NEXUS_CORS_ORIGINS`` get CORS
headers; credentials (cookies) are never allowed cross-origin, so the API can only be used
with a bearer token, never with the portal session cookie.

oauthlib adds ``Access-Control-Allow-Origin`` to successful token responses for https
origins registered on the client, but not to error responses (the SPA could not tell an
invalid refresh token from a network failure) and not for plain-http development origins.
This middleware covers both, for the configured origins only.
"""

from __future__ import annotations

from django.conf import settings
from django.http import HttpResponse
from django.utils.cache import patch_vary_headers

API_PREFIX = "/api/"
OAUTH_PATHS = frozenset({"/identity/o/api/token", "/identity/o/api/revoke"})
EXPOSED = "X-Request-Id, X-Nexus-Environment, Retry-After, WWW-Authenticate"


class ApiCorsMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        path = request.path
        is_api = path.startswith(API_PREFIX)
        if not is_api and path not in OAUTH_PATHS:
            return self.get_response(request)
        origin = request.META.get("HTTP_ORIGIN", "")
        allowed = bool(origin) and origin in settings.NEXUS_CORS_ORIGINS
        if request.method == "OPTIONS" and request.META.get("HTTP_ACCESS_CONTROL_REQUEST_METHOD"):
            response = HttpResponse(status=204)
            if allowed:
                response["Access-Control-Allow-Origin"] = origin
                response["Access-Control-Allow-Methods"] = "GET, POST, PATCH, DELETE" if is_api else "POST"
                response["Access-Control-Allow-Headers"] = "Authorization, Content-Type, X-Request-Id"
                response["Access-Control-Max-Age"] = "600"
            patch_vary_headers(response, ["Origin"])
            return response
        response = self.get_response(request)
        if allowed:
            response["Access-Control-Allow-Origin"] = origin
            response["Access-Control-Expose-Headers"] = EXPOSED
        elif "Access-Control-Allow-Origin" in response and response["Access-Control-Allow-Origin"] != "*":
            # Never reflect an origin we did not configure (defence in depth).
            del response["Access-Control-Allow-Origin"]
        patch_vary_headers(response, ["Origin"])
        return response
