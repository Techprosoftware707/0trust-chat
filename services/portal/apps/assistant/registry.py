"""The tool registry shared by the in-app assistant and the Claude MCP connector.

Every Nexus app contributes tools through an extension point, discovered like ``JOBS``::

    # apps/<app>/ai_tools.py
    from apps.assistant.registry import Tool, ToolResult
    from apps.assistant.schema import Args, P, obj, STR

    def _run(ctx, args):
        rows = access.for_actor(ctx.actor, Property).filter(...)   # ALWAYS as the actor
        return ToolResult(data={...}, facts=["..."], sources=[ctx.source(p) for p in rows])

    TOOLS = [Tool(name="search_properties", title="Search properties", description="...",
                  args=Args(query=P.string("...", required=True)), output=obj(...), run=_run,
                  feature="real_estate")]

Rules for every tool (enforced here or by review):

* purpose-built, never generic (no SQL, no "fetch any URL", no "run any API call");
* inputs are validated server-side against the declared schema before ``run`` is called,
  outputs are checked against the declared output schema before anyone sees them;
* ``run`` reads and writes only through ``apps.crm.access`` / the app's services with
  ``ctx.actor``: a tool can never see or do more than the person using it;
* reads of sensitive fields need ``ctx.allow_sensitive`` (org opt-in AND the person's
  role); documents are never returned;
* external content (``untrusted``) goes into ``ToolResult.untrusted`` / is flagged in the
  data, so prompts wrap it as data and never follow instructions inside it;
* writes are two-phase: a ``write`` tool only *prepares* a ``PendingAction`` (see
  ``apps.assistant.actions``); nothing changes until a person confirms it.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from typing import Any

from django.conf import settings
from django.core.exceptions import PermissionDenied
from django.http import Http404
from django.utils import timezone

from apps.api.errors import ApiError, ValidationFailed

from .schema import Args, OutputMismatch, check_output

log = logging.getLogger("nexus.assistant")

READ, WRITE = "read", "write"
SCOPE_READ, SCOPE_WRITE = "mcp:read", "mcp:write"


class ToolError(Exception):
    """A tool execution error the model can act on (shown as an error result)."""

    def __init__(self, message: str, *, code: str = "tool_error", fields: dict | None = None):
        super().__init__(message)
        self.message = message
        self.code = code
        self.fields = fields or {}


@dataclass(frozen=True)
class Source:
    """A record an answer is based on, with its link in the app."""

    type: str
    id: str
    label: str

    @property
    def url(self) -> str:
        return record_url(self.type, self.id)

    def as_dict(self) -> dict:
        return {"type": self.type, "id": self.id, "label": self.label, "url": self.url}


@dataclass
class ToolResult:
    data: dict
    facts: list[str] = field(default_factory=list)
    sources: list[Source] = field(default_factory=list)
    # External content included in ``data`` (emails, integration notes): [{"ref", "source"}].
    untrusted: list[dict] = field(default_factory=list)
    pending_action: dict | None = None


@dataclass
class ToolContext:
    actor: Any
    request: Any
    channel: str  # "assistant" | "mcp"
    client_id: str = ""
    allow_sensitive: bool = False
    touched: list[tuple[str, str]] = field(default_factory=list)
    pending_ids: list[str] = field(default_factory=list)

    def __post_init__(self):
        self.now = timezone.now()

    def touch(self, obj_or_type, pk=None) -> None:
        if pk is None:
            t, i = obj_or_type._meta.label_lower, str(obj_or_type.pk)
        else:
            t, i = str(obj_or_type), str(pk)
        if (t, i) not in self.touched:
            self.touched.append((t, i))

    def source(self, obj, label: str | None = None) -> Source:
        self.touch(obj)
        return Source(obj._meta.label_lower, str(obj.pk), label or str(obj))


@dataclass(frozen=True)
class Tool:
    name: str
    title: str
    description: str
    args: Args
    output: dict
    run: Callable[[ToolContext, dict], ToolResult]
    kind: str = READ
    feature: str | None = "crm"
    channels: frozenset[str] = frozenset({"assistant", "mcp"})
    destructive: bool = False
    idempotent: bool = True
    open_world: bool = False
    sensitive: bool = False

    @property
    def scope(self) -> str:
        return SCOPE_READ if self.kind == READ else SCOPE_WRITE

    def annotations(self) -> dict:
        return {
            "title": self.title,
            "readOnlyHint": self.kind == READ,
            "destructiveHint": self.destructive,
            "idempotentHint": self.idempotent,
            "openWorldHint": self.open_world,
        }


def scope_granted(tool: Tool, scopes: Iterable[str] | None) -> bool:
    """``mcp:write`` implies ``mcp:read`` (MCP: servers account for scope hierarchies)."""
    if scopes is None:
        return True
    granted = set(scopes)
    if tool.scope == SCOPE_READ:
        return bool(granted & {SCOPE_READ, SCOPE_WRITE})
    return SCOPE_WRITE in granted


# --- links -------------------------------------------------------------------------------------

_LINKS: dict[str, Callable[[str], str]] = {
    "crm.contact": lambda i: f"#/contacts/{i}",
    "crm.opportunity": lambda i: f"#/crm/{i}",
    "crm.pipeline": lambda i: f"#/pipelines/{i}",
    "crm.task": lambda i: "#/tasks",
    "crm.calendarevent": lambda i: "#/calendar",
    "crm.activity": lambda i: "#/home",
}


def register_link(type_label: str, builder: Callable[[str], str]) -> None:
    """Other apps register the SPA route of their records (``#/<area>/<id>``)."""
    _LINKS[type_label] = builder


def record_url(type_label: str, pk: str) -> str:
    route = _LINKS.get(type_label, lambda i: "#/home")(pk)
    return f"{settings.APP_BASE_URL.rstrip('/')}/{route}"


# --- discovery ---------------------------------------------------------------------------------

_cache: list[Tool] | None = None


def all_tools() -> list[Tool]:
    """Every registered tool, in a deterministic order (app order, then file order)."""
    global _cache
    if _cache is None:
        from apps.core.extensions import nexus_modules

        found: list[Tool] = []
        names: set[str] = set()
        for app, module in nexus_modules("ai_tools"):
            for t in getattr(module, "TOOLS", []):
                if not isinstance(t, Tool):
                    raise TypeError(f"{app}.ai_tools.TOOLS contains a non-Tool")
                if t.name in names:
                    raise ValueError(f"duplicate AI tool name {t.name}")
                if not (1 <= len(t.name) <= 64) or not t.name.replace("_", "").isalnum():
                    raise ValueError(f"invalid AI tool name {t.name}")
                names.add(t.name)
                found.append(t)
        _cache = found
    return list(_cache)


def reset_cache() -> None:
    global _cache
    _cache = None


def get_tool(name: str) -> Tool | None:
    return next((t for t in all_tools() if t.name == name), None)


def available_tools(actor, channel: str, scopes: Iterable[str] | None = None) -> list[Tool]:
    """Tools offered to ``actor`` on ``channel`` (feature flags of the workspace and, for
    MCP, the token's scopes). Role permissions are checked when a tool runs."""
    out = []
    for t in all_tools():
        if channel not in t.channels:
            continue
        if t.feature and not actor.features.get(t.feature):
            continue
        if not scope_granted(t, scopes):
            continue
        out.append(t)
    return out


# --- running -------------------------------------------------------------------------------------


def _field_errors(exc: ValidationFailed) -> dict:
    return {k: list(v) for k, v in (exc.fields or {}).items()}


def run_tool(tool: Tool, ctx: ToolContext, raw_args: Any) -> ToolResult:
    """Validates the input, runs the tool as ``ctx.actor`` and checks its output. Raises
    ``ToolError`` for anything the caller should see as a tool execution error."""
    if tool.feature and not ctx.actor.features.get(tool.feature):
        raise ToolError("This feature is not enabled for the workspace.", code="feature_disabled")
    try:
        args = tool.args.validate(raw_args)
    except ValidationFailed as exc:
        raise ToolError("Some arguments are not valid.", code="invalid_arguments", fields=_field_errors(exc)) from None
    try:
        result = tool.run(ctx, args)
    except ToolError:
        raise
    except ValidationFailed as exc:
        raise ToolError(exc.message, code="validation_error", fields=_field_errors(exc)) from None
    except Http404:
        raise ToolError("That record doesn't exist or you don't have access to it.", code="not_found") from None
    except PermissionDenied as exc:
        raise ToolError(str(exc) or "Your role doesn't allow that.", code="permission_denied") from None
    except ApiError as exc:
        raise ToolError(exc.message, code=exc.code, fields=exc.fields or {}) from None
    try:
        check_output(tool.output, result.data)
    except OutputMismatch as exc:
        # A bug in the tool, never the caller's fault; the message has no record content.
        log.error("AI tool %s produced output that does not match its schema: %s", tool.name, exc)
        raise ToolError("The tool failed on our side.", code="server_error") from None
    return result
