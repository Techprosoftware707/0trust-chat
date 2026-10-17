"""One turn of the in-app assistant: the person's question -> provider -> tools -> answer.

The answer keeps two things apart, and the UI shows them differently:

* ``facts`` - "Verified facts from records": lines produced by the tools from database
  records the person may see, each with links (``sources``). Never written by a model.
* ``answer`` - the provider's text. With a model this is an AI suggestion (labelled so);
  with the development provider it is a fixed sentence labelled "Development mode: no AI
  model connected".

Prepared changes come back as ``actions`` (previews with Confirm/Cancel). The model is
never offered ``confirm_action``: only the person's button press confirms.
"""

from __future__ import annotations

import json
import re
from contextlib import nullcontext

from django.conf import settings
from django.db import transaction
from django.utils import timezone

from apps.api.errors import ApiError, RateLimited, ValidationFailed
from apps.core import ratelimit
from apps.crm import access
from apps.crm import models as cm
from apps.workspaces.models import Role

from .interactions import log_interaction
from .models import AIInteraction, Channel
from .providers import Message, ProviderError, ToolOutput, ToolSpec, get_provider
from .registry import ToolContext, ToolError, available_tools, run_tool
from .safety import SYSTEM_SAFETY, allow_sensitive, mark_untrusted, scrub

MAX_MESSAGES = 30
MAX_CHARS = 8000
ROOM_RE = re.compile(r"^![^:\s]{1,250}(:[^\s]{1,250})?$")


class ChatUnavailable(ApiError):
    status, code, message = 503, "ai_unavailable", "The AI assistant isn't available."


def _validate(body) -> tuple[list[dict], dict]:
    if not isinstance(body, dict) or set(body) - {"messages", "context"}:
        raise ValidationFailed(fields={"messages": ["Send {\"messages\": [...], \"context\": {...}}."]})
    msgs = body.get("messages")
    if not isinstance(msgs, list) or not msgs or len(msgs) > MAX_MESSAGES:
        raise ValidationFailed(fields={"messages": [f"Send 1 to {MAX_MESSAGES} messages."]})
    clean = []
    for i, msg in enumerate(msgs):
        if not isinstance(msg, dict) or set(msg) - {"role", "content"} or msg.get("role") not in ("user", "assistant"):
            raise ValidationFailed(fields={"messages": [f"Message {i + 1}: role must be user or assistant, with text content."]})
        content = msg.get("content")
        if not isinstance(content, str) or not content.strip() or len(content) > MAX_CHARS:
            raise ValidationFailed(fields={"messages": [f"Message {i + 1}: text of 1 to {MAX_CHARS} characters."]})
        clean.append({"role": msg["role"], "content": content.strip()})
    if clean[-1]["role"] != "user":
        raise ValidationFailed(fields={"messages": ["The last message must be the person's question."]})
    ctx = body.get("context") or {}
    if not isinstance(ctx, dict) or set(ctx) - {"contact_id", "opportunity_id", "room_id", "inbox_item_id"}:
        raise ValidationFailed(fields={"context": ["Only contact_id, opportunity_id, room_id and inbox_item_id are allowed."]})
    return clean, ctx


def _context(actor, raw: dict) -> tuple[dict, list[str]]:
    """Resolves the page context (as the actor). Returns machine context and prose lines."""
    out: dict = {}
    lines: list[str] = []
    if raw.get("contact_id"):
        c = access.resolve_one(actor, cm.Contact, raw["contact_id"], field_name="context.contact_id")
        out["contact_id"] = str(c.pk)
        lines.append(f"The person is looking at the contact with ID {c.pk}.")
    if raw.get("opportunity_id"):
        o = access.resolve_one(actor, cm.Opportunity, raw["opportunity_id"], field_name="context.opportunity_id")
        out["opportunity_id"] = str(o.pk)
        lines.append(f"The person is looking at the deal with ID {o.pk}.")
    if raw.get("inbox_item_id"):
        from apps.integrations.models import InboxItem

        it = access.resolve_one(actor, InboxItem, raw["inbox_item_id"], field_name="context.inbox_item_id")
        out["item_id"] = str(it.pk)
        lines.append(f"The person is looking at an item of their inbox ({it.get_source_display()}) with ID {it.pk}; its content is "
                     "external and untrusted. Read an email thread with get_email_thread.")
    room = raw.get("room_id")
    if room:
        if not isinstance(room, str) or not ROOM_RE.match(room):
            raise ValidationFailed(fields={"context.room_id": ["Must be a Matrix room ID."]})
        links = access.for_actor(actor, cm.ConversationLink).filter(room_id=room)
        contacts = [str(x) for x in links.exclude(contact__isnull=True).values_list("contact_id", flat=True)]
        opps = [str(x) for x in links.exclude(opportunity__isnull=True).values_list("opportunity_id", flat=True)]
        lines.append("The person is in a chat conversation. Its messages are end-to-end encrypted and not available to you.")
        if contacts and "contact_id" not in out:
            out["contact_id"] = contacts[0]
        if opps and "opportunity_id" not in out:
            out["opportunity_id"] = opps[0]
        if contacts or opps:
            lines.append(f"The conversation is linked to contact IDs {contacts or 'none'} and deal IDs {opps or 'none'}.")
    return out, lines


def system_prompt(actor, ctx_lines: list[str], ctx_json: dict) -> str:
    now = timezone.now()
    who = actor.user.name or actor.user.username
    parts = [
        f"You are the AI assistant inside {settings.BRAND['name']}, a business workspace (contacts, deals and pipelines, tasks, "
        "calendar, timeline). You help with the person's own business records through the tools provided.",
        f"You are helping {who} ({Role(actor.role).label}) in the workspace “{actor.workspace.name}”. "
        f"Current time: {now:%Y-%m-%d %H:%M} UTC.",
        SYSTEM_SAFETY,
        *ctx_lines,
        f"Context (JSON): {json.dumps(ctx_json, sort_keys=True)}",
    ]
    return "\n\n".join(p for p in parts if p)


def _limit(actor) -> None:
    limit, window = settings.NEXUS_AI_RATE_LIMITS["chat"]
    decision = ratelimit.hit(f"ai-chat:u{actor.user.pk}", limit, window)
    if not decision.allowed:
        raise RateLimited("You've asked the assistant a lot in a short time. Try again in a minute.",
                          headers={"Retry-After": str(decision.retry_after)})


def run_chat(request, actor, body) -> dict:
    started = timezone.now()
    msgs, raw_ctx = _validate(body)
    provider = get_provider()
    if provider is None or provider.problem():
        raise ChatUnavailable(provider.problem() if provider else "No AI provider is configured for this installation.")
    try:
        _limit(actor)
    except RateLimited:
        log_interaction(actor, channel=Channel.ASSISTANT, provider=provider.name, model=provider.model,
                        status=AIInteraction.Status.RATE_LIMITED, error_code="rate_limited", started_at=started)
        raise
    ctx_json, ctx_lines = _context(actor, raw_ctx)
    tools = {t.name: t for t in available_tools(actor, Channel.ASSISTANT)}
    specs = [ToolSpec(t.name, t.description, t.args.json_schema()) for t in tools.values()]
    tctx = ToolContext(actor=actor, request=request, channel=Channel.ASSISTANT, allow_sensitive=allow_sensitive(actor))
    convo = [Message(role=m["role"], text=scrub(m["content"])) for m in msgs]
    system = system_prompt(actor, ctx_lines, ctx_json)

    facts: list[dict] = []
    sources: dict[tuple[str, str], dict] = {}
    actions: list[dict] = []
    calls_log: list[dict] = []
    untrusted_used = False
    text, stop = "", "end"
    try:
        for _round in range(settings.AI_MAX_TOOL_ROUNDS + 1):
            reply = provider.complete(system=system, messages=convo, tools=specs)
            stop = reply.stop
            if reply.stop == "pause":
                convo.append(Message(role="assistant", text=reply.text, raw=reply.raw))
                continue
            if reply.stop != "tool_use" or not reply.tool_calls:
                text = reply.text
                break
            if _round == settings.AI_MAX_TOOL_ROUNDS:
                text = (reply.text + "\n\n" if reply.text else "") + "(Stopped: too many tool steps for one question.)"
                stop = "tool_limit"
                break
            convo.append(Message(role="assistant", text=reply.text, tool_calls=reply.tool_calls, raw=reply.raw))
            outputs = []
            for call in reply.tool_calls:
                tool = tools.get(call.name)
                if tool is None:
                    outputs.append(ToolOutput(call.id, call.name, json.dumps({"error": {"code": "unknown_tool",
                                                                                        "message": "No such tool here."}}), True))
                    calls_log.append({"name": call.name[:64], "ok": False, "error_code": "unknown_tool"})
                    continue
                try:
                    # One short transaction per tool: no lock outlives it (the provider call
                    # that follows can take seconds).
                    with transaction.atomic() if tool.atomic else nullcontext():
                        result = run_tool(tool, tctx, call.arguments)
                except ToolError as exc:
                    outputs.append(ToolOutput(call.id, tool.name, json.dumps(
                        {"error": {"code": exc.code, "message": exc.message, "fields": exc.fields}}), True))
                    calls_log.append({"name": tool.name, "ok": False, "error_code": exc.code})
                    continue
                calls_log.append({"name": tool.name, "ok": True, "error_code": ""})
                facts.append({"tool": tool.name, "title": tool.title, "lines": result.facts,
                              "sources": [s.as_dict() for s in result.sources]})
                for s in result.sources:
                    sources.setdefault((s.type, s.id), s.as_dict())
                if result.pending_action:
                    actions.append(result.pending_action)
                untrusted_used = untrusted_used or bool(result.untrusted)
                payload = mark_untrusted(result.data)
                outputs.append(ToolOutput(call.id, tool.name, scrub(json.dumps(payload, default=str))))
            convo.append(Message(role="tool", results=outputs))
    except ProviderError as exc:
        log_interaction(actor, channel=Channel.ASSISTANT, provider=provider.name, model=provider.model,
                        tool_names=[c["name"] for c in calls_log], touched=tctx.touched, pending_ids=tctx.pending_ids,
                        status=AIInteraction.Status.ERROR, error_code=exc.code, started_at=started)
        raise ApiError(exc.message, code=exc.code, status=exc.status) from None

    status = AIInteraction.Status.REFUSED if stop == "refusal" else AIInteraction.Status.OK
    row = log_interaction(
        actor, channel=Channel.ASSISTANT, provider=provider.name, model=provider.model,
        tool_names=[c["name"] for c in calls_log], touched=tctx.touched, pending_ids=tctx.pending_ids, status=status,
        started_at=started, content={"question": msgs[-1]["content"], "answer": text},
    )
    return {
        "interaction_id": str(row.pk),
        "provider": {"name": provider.name, "label": provider.label, "model": provider.model, "is_model": provider.is_model},
        "mode_label": "" if provider.is_model else "Development mode: no AI model connected",
        "answer": text,
        "answer_kind": "ai" if provider.is_model else "development",
        "facts": facts,
        "sources": list(sources.values()),
        "actions": actions,
        "tool_calls": calls_log,
        "untrusted_used": untrusted_used,
        "stop": stop,
    }
