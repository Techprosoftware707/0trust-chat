"""Tool input and output schemas: one declaration gives both the JSON Schema that models
and MCP clients see and the server-side validation that every call goes through.

    INPUT = Args(
        query=P.string("Name, company, email or phone to look for.", max_length=100, required=True),
        limit=P.integer("How many results (1-20).", minimum=1, maximum=20, default=10),
    )
    INPUT.json_schema()          # {"type": "object", "properties": {...}, "required": [...], "additionalProperties": false}
    data = INPUT.validate(args)  # ValidationFailed(fields=...) on unknown keys or bad values

Validation reuses ``apps.api.schema.F`` (the parsers of the JSON API), so a tool accepts
exactly what the matching API endpoint accepts. Validation never touches the database:
IDs are resolved afterwards through ``apps.crm.access`` (unknown and inaccessible IDs look
the same).

``check_output(schema, value)`` validates a tool's structured output against its declared
output schema (the subset of JSON Schema used here: type, properties, required, items,
enum, additionalProperties false is not enforced on outputs).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from apps.api.schema import F, validate

_MISSING = object()


@dataclass(frozen=True)
class P:
    """One tool parameter: a parser (``F``) plus its JSON Schema."""

    f: F
    schema: dict
    required: bool = False

    @classmethod
    def string(cls, description: str, *, max_length: int = 200, required: bool = False, multiline: bool = False,
               default: Any = _MISSING, blank: bool = True) -> P:
        kw: dict[str, Any] = {"max_length": max_length, "multiline": multiline, "required": required, "blank": blank}
        if default is not _MISSING:
            kw["default"] = default
        schema = {"type": "string", "description": description, "maxLength": max_length}
        if not blank or required:
            schema["minLength"] = 1
        return cls(F.string(**kw), schema, required)

    @classmethod
    def uuid(cls, description: str, *, required: bool = False, null: bool = False) -> P:
        schema = {"type": ["string", "null"] if null else "string", "format": "uuid", "description": description}
        return cls(F.uuid(required=required, null=null, default=None), schema, required)

    @classmethod
    def integer(cls, description: str, *, minimum: int, maximum: int, default: int | None = None, required: bool = False) -> P:
        schema = {"type": "integer", "description": description, "minimum": minimum, "maximum": maximum}
        if default is not None:
            schema["default"] = default
        kw: dict[str, Any] = {"min_value": minimum, "max_value": maximum, "required": required}
        if default is not None:
            kw["default"] = default
        return cls(F.integer(**kw), schema, required)

    @classmethod
    def boolean(cls, description: str, *, default: bool = False) -> P:
        return cls(F.boolean(default=default), {"type": "boolean", "description": description, "default": default})

    @classmethod
    def choice(cls, description: str, choices: list[str], *, default: str | None = None, required: bool = False) -> P:
        schema: dict[str, Any] = {"type": "string", "enum": list(choices), "description": description}
        kw: dict[str, Any] = {"required": required}
        if default is not None:
            schema["default"] = default
            kw["default"] = default
        return cls(F.choice(choices, **kw), schema, required)

    @classmethod
    def datetime(cls, description: str, *, required: bool = False, null: bool = True) -> P:
        schema = {"type": ["string", "null"] if null else "string", "format": "date-time",
                  "description": description + " ISO 8601 with a time zone, e.g. 2026-10-20T09:00:00Z."}
        return cls(F.datetime(required=required, null=null, default=None), schema, required)

    @classmethod
    def date(cls, description: str, *, required: bool = False) -> P:
        schema = {"type": ["string", "null"], "format": "date", "description": description + " (YYYY-MM-DD)."}
        return cls(F.date(required=required, null=True, default=None), schema, required)

    @classmethod
    def uuid_list(cls, description: str, *, max_items: int = 20) -> P:
        schema = {"type": "array", "items": {"type": "string", "format": "uuid"}, "maxItems": max_items, "description": description}
        return cls(F.list(F.uuid(), max_items=max_items), schema)

    @classmethod
    def object(cls, description: str, properties: dict[str, P], *, required: bool = False) -> P:
        """A nested object with its own validated properties (used for field updates)."""
        inner = Args(**properties)

        def parse(value):
            from apps.api.errors import ValidationFailed
            from apps.api.schema import Invalid

            try:
                return inner.validate(value, partial=True)
            except ValidationFailed as exc:
                parts = [f"{k}: {' '.join(v)}" for k, v in (exc.fields or {}).items()]
                raise Invalid("; ".join(parts) or exc.message) from None

        schema = inner.json_schema(require=False)
        schema["description"] = description
        schema["minProperties"] = 1
        return cls(F(parse, required=required), schema, required)


@dataclass(frozen=True)
class Args:
    params: dict[str, P] = field(default_factory=dict)

    def __init__(self, **params: P):
        object.__setattr__(self, "params", dict(params))

    def json_schema(self, *, require: bool = True) -> dict:
        schema: dict[str, Any] = {
            "type": "object",
            "properties": {k: p.schema for k, p in self.params.items()},
            "additionalProperties": False,
        }
        req = [k for k, p in self.params.items() if p.required]
        if req and require:
            schema["required"] = req
        return schema

    def validate(self, data: Any, *, partial: bool = False) -> dict:
        if data is None:
            data = {}
        return validate(data, {k: p.f for k, p in self.params.items()}, partial=partial)


# --- output checking -------------------------------------------------------------------------

_TYPES = {
    "object": dict,
    "array": list,
    "string": str,
    "integer": int,
    "number": (int, float),
    "boolean": bool,
    "null": type(None),
}


class OutputMismatch(Exception):
    pass


def _type_ok(value: Any, typ: str) -> bool:
    if typ == "integer" and isinstance(value, bool):
        return False
    if typ == "number" and isinstance(value, bool):
        return False
    return isinstance(value, _TYPES[typ])


def check_output(schema: dict, value: Any, path: str = "$") -> None:
    """Raises ``OutputMismatch`` if ``value`` does not match ``schema`` (the subset used by
    the tool output schemas)."""
    types = schema.get("type")
    if types is not None:
        types = types if isinstance(types, list) else [types]
        if not any(_type_ok(value, t) for t in types):
            raise OutputMismatch(f"{path}: expected {'/'.join(types)}")
    if "enum" in schema and value not in schema["enum"]:
        raise OutputMismatch(f"{path}: not an allowed value")
    if isinstance(value, dict):
        for key in schema.get("required", []):
            if key not in value:
                raise OutputMismatch(f"{path}.{key}: missing")
        props = schema.get("properties", {})
        for key, sub in props.items():
            if key in value:
                check_output(sub, value[key], f"{path}.{key}")
    if isinstance(value, list) and "items" in schema:
        for i, item in enumerate(value):
            check_output(schema["items"], item, f"{path}[{i}]")


# Reusable output fragments ---------------------------------------------------------------------

def nullable(schema: dict) -> dict:
    s = dict(schema)
    t = s.get("type")
    s["type"] = [t, "null"] if isinstance(t, str) else list(t or []) + ["null"]
    return s


STR = {"type": "string"}
INT = {"type": "integer"}
BOOL = {"type": "boolean"}
NSTR = {"type": ["string", "null"]}

LINK = {
    "type": "object",
    "properties": {"type": STR, "id": STR, "label": STR, "url": STR},
    "required": ["type", "id", "label", "url"],
}
PERSON = nullable({"type": "object", "properties": {"id": STR, "name": STR}, "required": ["id", "name"]})


def obj(required: list[str] | None = None, **properties: dict) -> dict:
    out: dict[str, Any] = {"type": "object", "properties": properties}
    if required:
        out["required"] = required
    return out


def arr(items: dict) -> dict:
    return {"type": "array", "items": items}
