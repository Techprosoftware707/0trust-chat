from __future__ import annotations

import re
from functools import lru_cache
from pathlib import Path

from django import template
from django.conf import settings
from django.utils.html import escape
from django.utils.safestring import mark_safe

register = template.Library()

_NAME_RE = re.compile(r"^[a-z0-9-]{1,40}$")


def _icon_dir() -> Path:
    return Path(settings.DESIGN_DIR) / "icons"


@lru_cache(maxsize=256)
def _icon_inner(name: str) -> str:
    if not _NAME_RE.match(name):
        return ""
    path = _icon_dir() / f"{name}.svg"
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError:
        return ""
    match = re.search(r"<svg[^>]*>(.*)</svg>", raw, re.S)
    return match.group(1).strip() if match else ""


@register.simple_tag
def icon(name: str, extra_class: str = "", label: str = ""):
    inner = _icon_inner(name)
    cls = "icon" + (f" {escape(extra_class)}" if extra_class else "")
    if label:
        a11y = f'role="img" aria-label="{escape(label)}"'
    else:
        a11y = 'aria-hidden="true" focusable="false"'
    # Reviewed: `inner` comes from repository-bundled SVG files selected by a
    # validated name; class and label are escaped above.
    return mark_safe(f'<svg class="{cls}" viewBox="0 0 24 24" {a11y}>{inner}</svg>')  # nosec B308 B703


@register.filter
def cents(value, currency: str = "usd"):
    if value is None:
        return ""
    symbol = {"usd": "$", "eur": "€", "gbp": "£"}.get((currency or "").lower(), "")
    amount = int(value) / 100
    text = f"{amount:,.0f}" if amount == int(amount) else f"{amount:,.2f}"
    return f"{symbol}{text}" if symbol else f"{text} {currency.upper()}"


@register.filter
def percent_of(value, total):
    try:
        value, total = float(value), float(total)
    except (TypeError, ValueError):
        return 0
    if total <= 0:
        return 0
    return max(0, min(100, round(value * 100 / total)))


@register.filter
def initials(user):
    name = getattr(user, "display_name", "") or getattr(user, "username", "") or "?"
    parts = [p for p in re.split(r"[\s._-]+", name) if p]
    return "".join(p[0] for p in parts[:2]).upper() or "?"


@register.simple_tag(takes_context=True)
def nav_current(context, *prefixes):
    request = context.get("request")
    if request is None:
        return ""
    for prefix in prefixes:
        if prefix == "/" and request.path == "/":
            return 'aria-current="page"'
        if prefix != "/" and request.path.startswith(prefix):
            return 'aria-current="page"'
    return ""


@register.filter
def get_item(mapping, key):
    try:
        return mapping.get(key)
    except AttributeError:
        return None
