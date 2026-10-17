"""Request parsing, responses and pagination shared by every API view.

Success bodies:

* one object:  ``{"data": {...}}``
* a list:      ``{"data": [...], "page": {"limit": 50, "next_cursor": "..." | null, "total": 123}}``
* delete:      ``204 No Content``

Pagination is by opaque cursor: pass ``?limit=`` (1-200, default 50) and the previous
response's ``page.next_cursor`` as ``?cursor=``. Cursors are opaque on purpose (today they
encode an offset; they can become keyset cursors without changing clients).
"""

from __future__ import annotations

import base64
import json
from collections.abc import Callable, Iterable
from typing import Any

from django.conf import settings
from django.core.exceptions import RequestDataTooBig
from django.core.serializers.json import DjangoJSONEncoder
from django.http import HttpResponse, JsonResponse

from .errors import PayloadTooLarge, UnsupportedMediaType, ValidationFailed

DEFAULT_LIMIT = 50
MAX_LIMIT = 200


class ApiJSONEncoder(DjangoJSONEncoder):
    """ISO 8601 for dates/times (UTC with Z), strings for UUIDs and Decimals."""

    def default(self, o):
        import datetime as dt

        if isinstance(o, dt.datetime):
            return o.astimezone(dt.UTC).isoformat().replace("+00:00", "Z")
        return super().default(o)


def ok(data: Any, status: int = 200) -> JsonResponse:
    response = JsonResponse({"data": data}, status=status, encoder=ApiJSONEncoder)
    response["Cache-Control"] = "no-store"
    return response


def created(data: Any) -> JsonResponse:
    return ok(data, status=201)


def no_content() -> HttpResponse:
    response = HttpResponse(status=204)
    response["Cache-Control"] = "no-store"
    return response


def json_body(request) -> Any:
    """The decoded JSON body. Requires ``Content-Type: application/json``."""
    ctype = (request.META.get("CONTENT_TYPE") or "").split(";")[0].strip().lower()
    if ctype != "application/json":
        raise UnsupportedMediaType()
    try:
        raw = request.body
    except RequestDataTooBig:
        raise PayloadTooLarge() from None
    if len(raw) > settings.DATA_UPLOAD_MAX_MEMORY_SIZE:
        raise PayloadTooLarge()
    if not raw:
        return {}
    try:
        return json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        raise ValidationFailed("The body is not valid JSON.") from None


def _encode_cursor(offset: int) -> str:
    return base64.urlsafe_b64encode(f"o:{offset}".encode()).decode().rstrip("=")


def _decode_cursor(cursor: str) -> int:
    try:
        padded = cursor + "=" * (-len(cursor) % 4)
        kind, _, value = base64.urlsafe_b64decode(padded.encode()).decode().partition(":")
        offset = int(value)
        if kind != "o" or offset < 0 or offset > 10_000_000:
            raise ValueError
        return offset
    except (ValueError, UnicodeDecodeError):
        raise ValidationFailed(fields={"cursor": ["Invalid cursor."]}) from None


def page_params(request, *, default_limit: int = DEFAULT_LIMIT) -> tuple[int, int]:
    raw = request.GET.get("limit")
    limit = default_limit
    if raw:
        try:
            limit = int(raw)
        except ValueError:
            raise ValidationFailed(fields={"limit": ["Must be a whole number."]}) from None
        if not 1 <= limit <= MAX_LIMIT:
            raise ValidationFailed(fields={"limit": [f"Must be between 1 and {MAX_LIMIT}."]})
    cursor = request.GET.get("cursor")
    return limit, (_decode_cursor(cursor) if cursor else 0)


def paginated(request, queryset, serialize: Callable[[Any], dict], *, default_limit: int = DEFAULT_LIMIT,
              prepare: Callable[[list], Iterable] | None = None) -> JsonResponse:
    """A page of ``queryset`` (already filtered for the actor and ordered)."""
    limit, offset = page_params(request, default_limit=default_limit)
    total = queryset.count()
    rows = list(queryset[offset : offset + limit])
    if prepare is not None:
        rows = list(prepare(rows))
    next_cursor = _encode_cursor(offset + limit) if offset + limit < total else None
    response = JsonResponse(
        {"data": [serialize(r) for r in rows], "page": {"limit": limit, "next_cursor": next_cursor, "total": total}},
        encoder=ApiJSONEncoder,
    )
    response["Cache-Control"] = "no-store"
    return response
