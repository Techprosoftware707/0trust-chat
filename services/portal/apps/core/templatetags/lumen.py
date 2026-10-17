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


@register.filter
def isodate(value):
    """Parse an ISO 8601 string (as reported by the host agent) into a datetime for |date."""
    if not value or not isinstance(value, str):
        return value
    from django.utils.dateparse import parse_datetime

    try:
        parsed = parse_datetime(value.strip().replace("Z", "+00:00"))
    except ValueError:
        parsed = None
    return parsed or value


@register.filter
def megabytes(value):
    """A size given in MB, written the way people read it: 100 MB, 10 GB, 1.5 GB."""
    try:
        mb = float(value)
    except (TypeError, ValueError):
        return value
    if mb >= 1024:
        gb = mb / 1024
        return f"{gb:,.0f} GB" if gb == int(gb) else f"{gb:,.1f} GB"
    return f"{mb:,.0f} MB"


@register.filter
def count_where(items, key):
    """Number of mappings in `items` whose `key` is truthy (e.g. peers with a preshared key)."""
    try:
        return sum(1 for item in items if (item.get(key) if hasattr(item, "get") else getattr(item, key, None)))
    except TypeError:
        return 0


@register.filter
def seconds_ago(value):
    """A short, human duration for an age in seconds: 42 s, 5 min, 3 h, 2 days."""
    try:
        s = int(value)
    except (TypeError, ValueError):
        return ""
    if s < 60:
        return f"{s} s"
    if s < 3600:
        return f"{s // 60} min"
    if s < 86400:
        return f"{s // 3600} h"
    days = s // 86400
    return f"{days} day{'s' if days != 1 else ''}"


@register.filter
def join_lines(items):
    """One item per line (for a textarea). Django template tags can't span lines, so
    `join:"<newline>"` does not work; the result is still auto-escaped."""
    if not items:
        return ""
    if isinstance(items, str):
        return items
    return "\n".join(str(i) for i in items)
