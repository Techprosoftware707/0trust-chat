"""Atomic fixed-window rate limiting backed by PostgreSQL.

``hit(key, limit, window)`` increments the counter for the current window with
a single ``INSERT ... ON CONFLICT DO UPDATE ... RETURNING`` statement, so
concurrent workers cannot race past the limit.
"""

from __future__ import annotations

import time
from dataclasses import dataclass

from django.db import connection
from django.http import HttpRequest


@dataclass
class Decision:
    allowed: bool
    count: int
    limit: int
    retry_after: int


def hit(key: str, limit: int, window_seconds: int) -> Decision:
    now = int(time.time())
    window_start = now - (now % window_seconds)
    with connection.cursor() as cur:
        cur.execute(
            """
            INSERT INTO core_ratelimitbucket (key, window_start, count)
            VALUES (%s, %s, 1)
            ON CONFLICT (key, window_start)
            DO UPDATE SET count = core_ratelimitbucket.count + 1
            RETURNING count
            """,
            [key[:200], window_start],
        )
        count = cur.fetchone()[0]
    retry_after = window_start + window_seconds - now
    return Decision(allowed=count <= limit, count=count, limit=limit, retry_after=max(retry_after, 1))


def client_ip(request: HttpRequest) -> str:
    # Caddy (the only ingress) sets X-Real-IP / X-Forwarded-For from the TCP peer
    # and replaces any client-supplied value.
    return request.META.get("HTTP_X_REAL_IP") or request.META.get("REMOTE_ADDR") or "0.0.0.0"


def check_request(request: HttpRequest, scope: str, limit: int, window_seconds: int, *, per_user: bool = False) -> Decision:
    ident = client_ip(request)
    if per_user and getattr(request, "user", None) is not None and request.user.is_authenticated:
        ident = f"u{request.user.pk}"
    decision = hit(f"{scope}:{ident}", limit, window_seconds)
    if not decision.allowed:
        from .audit import security_event

        security_event(request, "rate_limited", detail={"scope": scope, "count": decision.count})
    return decision


def purge_old(older_than_seconds: int = 86400) -> int:
    cutoff = int(time.time()) - older_than_seconds
    with connection.cursor() as cur:
        cur.execute("DELETE FROM core_ratelimitbucket WHERE window_start < %s", [cutoff])
        return cur.rowcount
