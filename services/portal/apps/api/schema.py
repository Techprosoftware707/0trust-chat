"""Small, explicit input validation for JSON bodies and query parameters.

    SPEC = {
        "name": F.string(max_length=160, required=True),
        "value": F.decimal(max_digits=14, decimal_places=2, null=True),
        "kind": F.choice(["lead", "client"], default="lead"),
        "tag_ids": F.list(F.uuid(), max_items=50),
    }
    data = validate(body, SPEC)                 # create: defaults applied, required enforced
    data = validate(body, SPEC, partial=True)   # PATCH: only the keys that were sent

Unknown keys are rejected, strings are stripped and length-checked, and every problem is
reported at once as ``ValidationFailed(fields={key: [message, ...]})``. Validation never
looks anything up in the database: callers resolve IDs through ``apps.crm.access`` so
that unknown and inaccessible IDs give the same answer.
"""

from __future__ import annotations

import datetime as dt
import re
import uuid
from collections.abc import Callable, Iterable
from decimal import Decimal, InvalidOperation
from typing import Any

from django.core.exceptions import ValidationError as DjangoValidationError
from django.core.validators import URLValidator, validate_email
from django.utils.dateparse import parse_date, parse_datetime

from .errors import ValidationFailed

_MISSING = object()
_PHONE = re.compile(r"^\+?[0-9 ()./-]{3,40}$")
_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


class Invalid(Exception):
    pass


class F:
    """A field: a parser plus options. Use the constructors (F.string, F.uuid, ...)."""

    def __init__(self, parse: Callable[[Any], Any], *, required: bool = False, null: bool = False,
                 default: Any = _MISSING, label: str = ""):
        self.parse = parse
        self.required = required
        self.null = null
        self.default = default
        self.label = label

    # --- constructors ---------------------------------------------------------------
    @classmethod
    def string(cls, *, max_length: int, min_length: int = 0, multiline: bool = False, blank: bool = True, **kw) -> F:
        def parse(v):
            if not isinstance(v, str):
                raise Invalid("Must be text.")
            v = v.strip()
            if not multiline and ("\n" in v or "\r" in v):
                raise Invalid("Must be a single line.")
            if _CONTROL.search(v):
                raise Invalid("Contains control characters.")
            if len(v) > max_length:
                raise Invalid(f"At most {max_length} characters.")
            if len(v) < min_length or (not blank and not v):
                raise Invalid("This field can't be empty." if not v else f"At least {min_length} characters.")
            return v

        kw.setdefault("default", "" if not kw.get("required") else _MISSING)
        return cls(parse, **kw)

    @classmethod
    def email(cls, **kw) -> F:
        def parse(v):
            if not isinstance(v, str):
                raise Invalid("Must be text.")
            v = v.strip()
            if not v:
                return ""
            if len(v) > 254:
                raise Invalid("At most 254 characters.")
            try:
                validate_email(v)
            except DjangoValidationError:
                raise Invalid("Enter a valid email address.") from None
            return v.lower()

        kw.setdefault("default", "")
        return cls(parse, **kw)

    @classmethod
    def phone(cls, **kw) -> F:
        def parse(v):
            if not isinstance(v, str):
                raise Invalid("Must be text.")
            v = v.strip()
            if v and not _PHONE.match(v):
                raise Invalid("Enter a phone number (digits, spaces, + ( ) . / -).")
            return v

        kw.setdefault("default", "")
        return cls(parse, **kw)

    @classmethod
    def url(cls, **kw) -> F:
        validator = URLValidator(schemes=["https", "http"])

        def parse(v):
            if not isinstance(v, str):
                raise Invalid("Must be text.")
            v = v.strip()
            if not v:
                return ""
            if len(v) > 500:
                raise Invalid("At most 500 characters.")
            try:
                validator(v)
            except DjangoValidationError:
                raise Invalid("Enter a valid http(s) URL.") from None
            return v

        kw.setdefault("default", "")
        return cls(parse, **kw)

    @classmethod
    def boolean(cls, **kw) -> F:
        def parse(v):
            if not isinstance(v, bool):
                raise Invalid("Must be true or false.")
            return v

        return cls(parse, **kw)

    @classmethod
    def integer(cls, *, min_value: int | None = None, max_value: int | None = None, **kw) -> F:
        def parse(v):
            if isinstance(v, bool) or not isinstance(v, int):
                raise Invalid("Must be a whole number.")
            if min_value is not None and v < min_value:
                raise Invalid(f"Must be at least {min_value}.")
            if max_value is not None and v > max_value:
                raise Invalid(f"Must be at most {max_value}.")
            return v

        return cls(parse, **kw)

    @classmethod
    def decimal(cls, *, max_digits: int = 14, decimal_places: int = 2, min_value: Decimal | int | None = 0, **kw) -> F:
        def parse(v):
            if isinstance(v, bool) or not isinstance(v, (int, float, str)):
                raise Invalid("Must be a number.")
            try:
                d = Decimal(str(v).strip())
            except InvalidOperation:
                raise Invalid("Must be a number.") from None
            if not d.is_finite():
                raise Invalid("Must be a number.")
            d = d.quantize(Decimal(1).scaleb(-decimal_places))
            if len(d.as_tuple().digits) > max_digits:
                raise Invalid("The number is too large.")
            if min_value is not None and d < Decimal(min_value):
                raise Invalid(f"Must be at least {min_value}.")
            return d

        return cls(parse, **kw)

    @classmethod
    def uuid(cls, **kw) -> F:
        def parse(v):
            if not isinstance(v, str) or len(v) > 40:
                raise Invalid("Must be an ID.")
            try:
                return uuid.UUID(v)
            except ValueError:
                raise Invalid("Must be an ID.") from None

        return cls(parse, **kw)

    @classmethod
    def choice(cls, choices: Iterable[str], **kw) -> F:
        allowed = list(choices)

        def parse(v):
            if v not in allowed:
                raise Invalid(f"Must be one of: {', '.join(allowed)}.")
            return v

        return cls(parse, **kw)

    @classmethod
    def datetime(cls, **kw) -> F:
        def parse(v):
            if not isinstance(v, str):
                raise Invalid("Must be an ISO 8601 date-time.")
            parsed = parse_datetime(v.strip())
            if parsed is None:
                raise Invalid("Must be an ISO 8601 date-time, e.g. 2026-10-17T09:30:00Z.")
            if parsed.tzinfo is None:
                raise Invalid("Include a time zone (Z or an offset).")
            return parsed.astimezone(dt.UTC)

        return cls(parse, **kw)

    @classmethod
    def date(cls, **kw) -> F:
        def parse(v):
            if not isinstance(v, str):
                raise Invalid("Must be a date (YYYY-MM-DD).")
            try:
                parsed = parse_date(v.strip())
            except ValueError:
                parsed = None
            if parsed is None:
                raise Invalid("Must be a date (YYYY-MM-DD).")
            return parsed

        return cls(parse, **kw)

    @classmethod
    def list(cls, item: F, *, max_items: int = 100, unique: bool = True, **kw) -> F:
        def parse(v):
            if not isinstance(v, list):
                raise Invalid("Must be a list.")
            if len(v) > max_items:
                raise Invalid(f"At most {max_items} items.")
            out = []
            for i, element in enumerate(v):
                if element is None:
                    raise Invalid(f"Item {i + 1} is empty.")
                try:
                    parsed = item.parse(element)
                except Invalid as exc:
                    raise Invalid(f"Item {i + 1}: {exc}") from None
                if unique and parsed in out:
                    continue
                out.append(parsed)
            return out

        kw.setdefault("default", [])
        return cls(parse, **kw)

    @classmethod
    def object(cls, *, max_keys: int = 100, **kw) -> F:
        def parse(v):
            if not isinstance(v, dict):
                raise Invalid("Must be an object.")
            if len(v) > max_keys:
                raise Invalid(f"At most {max_keys} keys.")
            return v

        kw.setdefault("default", {})
        return cls(parse, **kw)


def validate(data: Any, spec: dict[str, F], *, partial: bool = False) -> dict[str, Any]:
    """Validates ``data`` (a decoded JSON object) against ``spec``."""
    if not isinstance(data, dict):
        raise ValidationFailed("The body must be a JSON object.")
    errors: dict[str, list[str]] = {}
    clean: dict[str, Any] = {}
    for key in data:
        if key not in spec:
            errors.setdefault(str(key)[:60], []).append("Unknown field.")
    for key, field in spec.items():
        if key not in data:
            if partial:
                continue
            if field.required:
                errors.setdefault(key, []).append("This field is required.")
            elif field.default is not _MISSING:
                clean[key] = field.default() if callable(field.default) else field.default
            continue
        value = data[key]
        if value is None:
            if field.null:
                clean[key] = None
            else:
                errors.setdefault(key, []).append("This field can't be null.")
            continue
        try:
            clean[key] = field.parse(value)
        except Invalid as exc:
            errors.setdefault(key, []).append(str(exc))
    if errors:
        raise ValidationFailed(fields=errors)
    return clean


def query_param(request, name: str, field: F, *, default: Any = None) -> Any:
    """Parses one query-string parameter with ``field`` (strings only: use F.string,
    F.uuid, F.choice, F.datetime, F.date). Invalid values are a validation error."""
    raw = request.GET.get(name)
    if raw is None or raw == "":
        return default
    try:
        return field.parse(raw)
    except Invalid as exc:
        raise ValidationFailed(fields={name: [str(exc)]}) from None


def query_bool(request, name: str, default: bool | None = None) -> bool | None:
    raw = request.GET.get(name)
    if raw is None or raw == "":
        return default
    if raw.lower() in {"1", "true", "yes"}:
        return True
    if raw.lower() in {"0", "false", "no"}:
        return False
    raise ValidationFailed(fields={name: ["Must be true or false."]})
