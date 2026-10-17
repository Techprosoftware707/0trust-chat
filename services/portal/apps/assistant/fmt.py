"""Plain-text formatting of record facts for answers (UTC, unambiguous)."""

from __future__ import annotations

import datetime as dt
from decimal import Decimal


def iso(value) -> str | None:
    if value is None:
        return None
    if isinstance(value, dt.datetime):
        return value.astimezone(dt.UTC).isoformat().replace("+00:00", "Z")
    return value.isoformat()


def when(value: dt.datetime | None) -> str:
    if value is None:
        return "no date"
    v = value.astimezone(dt.UTC)
    return f"{v:%a} {v.day} {v:%b %Y}, {v:%H:%M} UTC"


def day(value: dt.date | dt.datetime | None) -> str:
    if value is None:
        return "no date"
    if isinstance(value, dt.datetime):
        value = value.astimezone(dt.UTC).date()
    return f"{value.day} {value:%b %Y}"


def money(value: Decimal | None, currency: str = "") -> str:
    if value is None:
        return "no value"
    return f"{currency} {value:,.2f}".strip()


def money_str(value: Decimal | None) -> str | None:
    return None if value is None else f"{value:.2f}"


def person(user) -> dict | None:
    if user is None:
        return None
    return {"id": str(user.public_id), "name": user.name or user.username}


def name_of(user, fallback: str = "nobody") -> str:
    return (user.name or user.username) if user is not None else fallback


def clip(text: str, n: int) -> str:
    text = text or ""
    return text if len(text) <= n else text[: n - 1].rstrip() + "…"
