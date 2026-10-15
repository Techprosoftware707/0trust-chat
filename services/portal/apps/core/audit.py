"""Helpers for recording audit and security events."""

from __future__ import annotations

from typing import Any

from django.conf import settings
from django.http import HttpRequest

from .logging import request_id_var
from .models import AuditEvent, SecurityEvent
from .ratelimit import client_ip

_FORBIDDEN_KEYS = {"password", "secret", "token", "key", "private_key", "code", "otp"}


def _clean(metadata: dict[str, Any] | None) -> dict[str, Any]:
    clean: dict[str, Any] = {}
    for k, v in (metadata or {}).items():
        if any(f in k.lower() for f in _FORBIDDEN_KEYS) and k.lower() not in {"public_key", "key_id"}:
            clean[k] = "[redacted]"
        else:
            clean[k] = v
    return clean


def audit(
    request: HttpRequest | None,
    action: str,
    *,
    target: Any = None,
    target_type: str = "",
    target_id: str = "",
    actor=None,
    metadata: dict[str, Any] | None = None,
) -> AuditEvent:
    if target is not None:
        target_type = target_type or target.__class__.__name__.lower()
        target_id = target_id or str(getattr(target, "pk", ""))
    user = actor
    if user is None and request is not None and getattr(request, "user", None) is not None and request.user.is_authenticated:
        user = request.user
    event = AuditEvent(
        actor=user if user is not None and getattr(user, "pk", None) else None,
        actor_label=(getattr(user, "username", "") or "system") if user is not None else "system",
        surface=settings.SURFACE,
        action=action,
        target_type=target_type,
        target_id=str(target_id),
        ip=client_ip(request) if request is not None else None,
        request_id=request_id_var.get(),
        metadata=_clean(metadata),
    )
    event.save()
    return event


def security_event(request: HttpRequest | None, kind: str, *, user=None, detail: dict[str, Any] | None = None) -> SecurityEvent:
    if user is None and request is not None and getattr(request, "user", None) is not None and request.user.is_authenticated:
        user = request.user
    ua = ""
    ip = None
    if request is not None:
        ua = (request.META.get("HTTP_USER_AGENT") or "")[:200]
        ip = client_ip(request)
    return SecurityEvent.objects.create(kind=kind, user=user, ip=ip, user_agent=ua, detail=_clean(detail))
