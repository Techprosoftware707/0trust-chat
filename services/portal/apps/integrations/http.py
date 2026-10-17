"""HTTP to providers: one transport seam, retries with backoff, rate limits, error mapping.

* ``Transport`` sends one request. ``RequestsTransport`` is the real one (TLS verification
  always on, no redirects followed, timeouts). In mock mode, and in every automated test, a
  fake transport answers instead (``apps.integrations.mock``): no live calls.
* ``ProviderClient.request`` retries idempotent requests on 5xx and network errors with
  exponential backoff and jitter (1 s, 2 s, 4 s, as the providers' docs recommend), honours
  ``Retry-After`` on 429 (waiting inline only for short waits; longer ones surface as
  ``RateLimited`` so the sync job reschedules), refreshes the access token once on 401, and
  maps every failure to a typed ``ProviderError`` with a safe, fixed message.
* Nothing here logs URLs with query strings, headers, bodies or tokens: only the provider,
  the method, a path template and the status.
"""

from __future__ import annotations

import contextlib
import email.utils
import json as jsonlib
import logging
import random
import time
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from typing import Any, Protocol
from urllib.parse import urlsplit

log = logging.getLogger("nexus.integrations")

MAX_INLINE_WAIT = 5.0  # seconds we are willing to sleep inside one request for a 429
DEFAULT_TIMEOUT = 20.0


# --- errors ---------------------------------------------------------------------------------------


class ProviderError(Exception):
    """A provider call failed. ``code`` is stable (clients branch on it), ``message`` is
    ours and safe to show; provider error bodies are never echoed."""

    code = "provider_error"
    message = "The provider returned an error."

    def __init__(self, message: str | None = None, *, code: str | None = None, status: int | None = None,
                 retry_after: float | None = None, detail: str = ""):
        super().__init__(message or self.message)
        self.message = message or self.message
        self.code = code or self.code
        self.status = status
        self.retry_after = retry_after
        self.detail = detail  # provider error code (e.g. "not_in_channel"), never a body


class NotConfigured(ProviderError):
    code, message = "not_configured", "This integration isn't set up on the server yet."


class AuthExpired(ProviderError):
    code, message = "auth_expired", "The provider rejected the access token."


class ReauthRequired(ProviderError):
    code, message = "reauth_required", "The connection was revoked or expired. Reconnect it to continue."


class ScopeMissing(ProviderError):
    code, message = "scope_missing", "The connection doesn't have the permission this needs. Reconnect and approve all requested permissions."


class Forbidden(ProviderError):
    code, message = "forbidden", "The provider refused this request."


class RateLimited(ProviderError):
    code, message = "rate_limited", "The provider is rate limiting requests. We'll retry automatically."


class ProviderUnavailable(ProviderError):
    code, message = "provider_unavailable", "The provider is unavailable right now. Try again in a few minutes."


class ProviderNotFound(ProviderError):
    code, message = "not_found", "The provider says this item doesn't exist (anymore)."


class ProviderBadRequest(ProviderError):
    code, message = "bad_request", "The provider rejected the request."


class Unsupported(ProviderError):
    code, message = "unsupported", "The provider doesn't support this."


# --- transport ------------------------------------------------------------------------------------


@dataclass
class HttpRequest:
    method: str
    url: str
    headers: dict[str, str] = field(default_factory=dict)
    params: dict[str, Any] | list[tuple[str, Any]] | None = None
    form: dict[str, Any] | None = None
    json: Any = None
    timeout: float = DEFAULT_TIMEOUT

    @property
    def path(self) -> str:
        return urlsplit(self.url).path


class Headers(dict):
    """Case-insensitive response headers."""

    def __init__(self, data=None):
        super().__init__()
        for k, v in (data or {}).items():
            self[k] = v

    def __setitem__(self, key, value):
        super().__setitem__(str(key).lower(), value)

    def __getitem__(self, key):
        return super().__getitem__(str(key).lower())

    def get(self, key, default=None):
        return super().get(str(key).lower(), default)

    def __contains__(self, key):
        return super().__contains__(str(key).lower())


@dataclass
class HttpResponse:
    status: int
    headers: Headers = field(default_factory=Headers)
    body: bytes = b""

    def json(self) -> Any:
        if not self.body:
            return {}
        try:
            return jsonlib.loads(self.body)
        except (ValueError, UnicodeDecodeError):
            return {}

    @property
    def ok(self) -> bool:
        return 200 <= self.status < 300


class TransportError(Exception):
    """Network-level failure (DNS, TLS, timeout, connection reset)."""


class Transport(Protocol):
    def send(self, request: HttpRequest) -> HttpResponse: ...


class RequestsTransport:
    """The real network. TLS certificates are always verified (``requests`` default, with the
    system/certifi bundle or REQUESTS_CA_BUNDLE); redirects are never followed."""

    def __init__(self):
        import requests

        self._requests = requests
        self.session = requests.Session()
        self.session.headers["User-Agent"] = "NexusOffice-Integrations/1"

    def send(self, request: HttpRequest) -> HttpResponse:
        try:
            r = self.session.request(
                request.method,
                request.url,
                headers=request.headers,
                params=request.params,
                data=request.form,
                json=request.json,
                timeout=request.timeout,
                allow_redirects=False,
            )
        except self._requests.RequestException as exc:
            raise TransportError(type(exc).__name__) from None
        return HttpResponse(status=r.status_code, headers=Headers(r.headers), body=r.content)


_override: Transport | None = None
_real: Transport | None = None


def get_transport() -> Transport:
    """The transport for provider calls: a test override, the mock providers, or the network."""
    global _real
    if _override is not None:
        return _override
    from .conf import mock_mode

    if mock_mode():
        from .mock.providers import mock_transport

        return mock_transport()
    if _real is None:
        _real = RequestsTransport()
    return _real


@contextlib.contextmanager
def use_transport(transport: Transport) -> Iterator[Transport]:
    """Routes every provider call to ``transport`` (tests)."""
    global _override
    previous = _override
    _override = transport
    try:
        yield transport
    finally:
        _override = previous


# --- client ---------------------------------------------------------------------------------------


def parse_retry_after(value: str | None) -> float | None:
    if not value:
        return None
    value = value.strip()
    try:
        return max(0.0, float(value))
    except ValueError:
        pass
    try:
        when = email.utils.parsedate_to_datetime(value)
    except (TypeError, ValueError):
        return None
    return max(0.0, when.timestamp() - time.time())


def backoff(attempt: int, *, base: float = 1.0, cap: float = 30.0) -> float:
    """Exponential backoff with full jitter on top of the documented 1 s, 2 s, 4 s steps."""
    delay = min(cap, base * (2 ** attempt))
    return delay + random.uniform(0, delay / 2)  # nosec B311 - jitter, not security


Sleeper = Callable[[float], None]
_sleep: Sleeper = time.sleep


@contextlib.contextmanager
def use_sleeper(fn: Sleeper) -> Iterator[None]:
    global _sleep
    previous = _sleep
    _sleep = fn
    try:
        yield
    finally:
        _sleep = previous


class TokenSource(Protocol):
    def access_token(self) -> str: ...
    def refresh(self) -> str: ...


Classifier = Callable[[HttpResponse], "ProviderError | None"]


class ProviderClient:
    """Calls one provider for one connection (or unauthenticated, for token endpoints)."""

    def __init__(self, provider: str, *, tokens: TokenSource | None = None, max_retries: int = 3,
                 classify: Classifier | None = None, auth_header: Callable[[str], dict[str, str]] | None = None,
                 extra_headers: dict[str, str] | None = None):
        self.provider = provider
        self.tokens = tokens
        self.max_retries = max_retries
        self.classify = classify
        self.auth_header = auth_header or (lambda token: {"Authorization": f"Bearer {token}"})
        self.extra_headers = dict(extra_headers or {})

    def request(self, method: str, url: str, *, params=None, json=None, form=None, headers=None, auth: bool = True,
                idempotent: bool | None = None, timeout: float = DEFAULT_TIMEOUT) -> HttpResponse:
        method = method.upper()
        if idempotent is None:
            idempotent = method in {"GET", "HEAD", "PUT", "DELETE", "OPTIONS"}
        refreshed = False
        attempt = 0
        transport = get_transport()
        while True:
            h = {"Accept": "application/json", **self.extra_headers, **(headers or {})}
            if auth:
                if self.tokens is None:
                    raise NotConfigured()
                h.update(self.auth_header(self.tokens.access_token()))
            req = HttpRequest(method, url, headers=h, params=params, form=form, json=json, timeout=timeout)
            try:
                resp = transport.send(req)
            except TransportError as exc:
                log.warning("provider %s %s %s: network error %s (attempt %d)", self.provider, method, req.path, exc, attempt + 1)
                if idempotent and attempt < self.max_retries:
                    _sleep(backoff(attempt))
                    attempt += 1
                    continue
                raise ProviderUnavailable() from None
            if resp.ok:
                err = self.classify(resp) if self.classify else None
                if err is None:
                    return resp
            else:
                err = (self.classify(resp) if self.classify else None) or self._default_error(resp)
            log.info("provider %s %s %s -> %s (%s)", self.provider, method, req.path, resp.status, err.code)
            if isinstance(err, AuthExpired):
                if auth and not refreshed and self.tokens is not None:
                    refreshed = True
                    self.tokens.refresh()
                    continue
                raise ReauthRequired(detail=err.detail, status=resp.status)
            if isinstance(err, RateLimited):
                wait = err.retry_after if err.retry_after is not None else backoff(attempt)
                if idempotent and attempt < self.max_retries and wait <= MAX_INLINE_WAIT:
                    _sleep(wait)
                    attempt += 1
                    continue
                err.retry_after = wait
                raise err
            if isinstance(err, ProviderUnavailable) and idempotent and attempt < self.max_retries:
                _sleep(backoff(attempt))
                attempt += 1
                continue
            raise err

    @staticmethod
    def _default_error(resp: HttpResponse) -> ProviderError:
        s = resp.status
        if s == 401:
            return AuthExpired(status=s)
        if s == 403:
            return Forbidden(status=s)
        if s == 404:
            return ProviderNotFound(status=s)
        if s == 429:
            return RateLimited(status=s, retry_after=parse_retry_after(resp.headers.get("Retry-After")))
        if s >= 500:
            return ProviderUnavailable(status=s)
        return ProviderBadRequest(status=s)
