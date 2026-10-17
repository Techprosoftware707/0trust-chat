"""Provider failures as API errors (the API's one error format, docs/nexus/ARCHITECTURE.md).

| Provider error | HTTP | code |
|---|---|---|
| ReauthRequired | 409 | ``reauth_required`` (the connection moved to needs_reauth; reconnect) |
| NotConfigured | 409 | ``not_configured`` |
| ScopeMissing | 403 | ``scope_missing`` |
| RateLimited | 429 | ``rate_limited`` (+ ``Retry-After``) |
| ProviderUnavailable | 502 | ``provider_unavailable`` |
| ProviderNotFound | 404 | ``not_found`` |
| ProviderBadRequest, Unsupported, Forbidden | 400 / 403 | the error's own code (e.g. ``slack_not_in_channel``) |
"""

from __future__ import annotations

import contextlib
import math

from apps.api.errors import ApiError

from .http import (
    Forbidden,
    NotConfigured,
    ProviderBadRequest,
    ProviderError,
    ProviderNotFound,
    ProviderUnavailable,
    RateLimited,
    ReauthRequired,
    ScopeMissing,
    Unsupported,
)


class ProviderApiError(ApiError):
    status, code, message = 502, "provider_unavailable", "The provider is unavailable right now."


def to_api_error(exc: ProviderError) -> ApiError:
    if isinstance(exc, ReauthRequired):
        return ProviderApiError(exc.message, code="reauth_required", status=409)
    if isinstance(exc, NotConfigured):
        return ProviderApiError(exc.message, code="not_configured", status=409)
    if isinstance(exc, ScopeMissing):
        return ProviderApiError(exc.message, code="scope_missing", status=403)
    if isinstance(exc, RateLimited):
        wait = max(1, math.ceil(exc.retry_after or 30))
        return ProviderApiError(exc.message, code="rate_limited", status=429, headers={"Retry-After": str(wait)})
    if isinstance(exc, ProviderNotFound):
        return ProviderApiError(exc.message, code="not_found", status=404)
    if isinstance(exc, ProviderUnavailable):
        return ProviderApiError(exc.message, code="provider_unavailable", status=502)
    if isinstance(exc, Forbidden):
        return ProviderApiError(exc.message, code=exc.code, status=403)
    if isinstance(exc, (ProviderBadRequest, Unsupported)):
        return ProviderApiError(exc.message, code=exc.code if exc.code != "bad_request" else "provider_rejected", status=400)
    return ProviderApiError(exc.message, code=exc.code or "provider_error", status=502)


@contextlib.contextmanager
def provider_call(connection=None):
    """Turns provider failures into API errors. A rejected token (after one refresh) moves
    ``connection`` to needs_reauth, with a reconnect action in the UI."""
    try:
        yield
    except ProviderError as exc:
        if isinstance(exc, ReauthRequired) and connection is not None and connection.status != "needs_reauth":
            from .tokens import mark_needs_reauth

            mark_needs_reauth(connection, exc.detail or "token_rejected", "The provider rejected the connection's access. Reconnect to continue.")
        raise to_api_error(exc) from None
