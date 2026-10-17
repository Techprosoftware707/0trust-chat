"""Two-phase writes: prepare -> (a person) confirm.

A ``write`` tool never changes a record. It calls ``prepare()``, which

1. runs the real write once inside a savepoint that is always rolled back (a dry run: the
   same validation and permission checks as the real thing, so the preview is accurate
   and impossible actions fail now, not at confirmation);
2. stores a ``PendingAction``: the exact service payload, a SHA-256 over
   (action, payload, workspace, user, channel), the preview, a short expiry;
3. audits ``assistant.pendingaction.create`` (field names only).

``confirm()`` locks the row, checks it belongs to this user, workspace and channel (else it
does not exist for them: 404), that it is still pending (single use: a second confirm is a
conflict) and not expired, re-checks the payload hash, then executes the payload through
the CRM services AS the person, who is re-authorized on the spot. Failures mark the row
``failed``; nothing is retried automatically.

In the in-app assistant the model can only *prepare*: confirming is a button the person
presses (the ``confirm_action`` tool is not offered to the in-app model at all). Over MCP,
``confirm_action`` is a separate tool annotated as destructive, so the MCP host asks the
person before it runs.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Callable
from dataclasses import dataclass
from datetime import timedelta
from typing import Any

from django.conf import settings
from django.core.exceptions import PermissionDenied
from django.db import transaction
from django.http import Http404
from django.utils import timezone

from apps.api.errors import ApiError, Conflict, RateLimited, ValidationFailed
from apps.core import ratelimit
from apps.core.audit import audit

from .models import PendingAction
from .registry import ToolContext, ToolError


@dataclass(frozen=True)
class Executor:
    name: str
    # (request, actor, payload) -> list of (type_label, id) written
    run: Callable[[Any, Any, dict], list[tuple[str, str]]]


_EXECUTORS: dict[str, Executor] = {}


def register_executor(name: str, run: Callable[[Any, Any, dict], list[tuple[str, str]]]) -> None:
    _EXECUTORS[name] = Executor(name, run)


def executor(name: str) -> Executor:
    from .registry import all_tools

    all_tools()  # imports every ai_tools module, which registers its executors
    try:
        return _EXECUTORS[name]
    except KeyError:
        raise LookupError(name) from None


def payload_hash(action: str, payload: dict, workspace_id, user_id, channel: str) -> str:
    canonical = json.dumps(
        {"action": action, "payload": payload, "workspace": str(workspace_id), "user": str(user_id), "channel": channel},
        sort_keys=True, separators=(",", ":"), default=str,
    )
    return hashlib.sha256(canonical.encode()).hexdigest()


class _Rollback(Exception):
    pass


def _limit(actor, kind: str) -> None:
    limit, window = settings.NEXUS_AI_RATE_LIMITS[kind]
    decision = ratelimit.hit(f"ai-{kind}:u{actor.user.pk}", limit, window)
    if not decision.allowed:
        raise RateLimited(headers={"Retry-After": str(decision.retry_after)})


def dry_run(request, actor, action: str, payload: dict) -> list[tuple[str, str]]:
    """Runs the write and rolls it back. Raises the same errors the real write would."""
    ex = executor(action)
    refs: list[tuple[str, str]] = []
    try:
        with transaction.atomic():
            refs = ex.run(request, actor, payload)
            raise _Rollback
    except _Rollback:
        pass
    return refs


def prepare(ctx: ToolContext, action: str, payload: dict, preview: dict) -> dict:
    actor = ctx.actor
    try:
        _limit(actor, "prepare")
    except RateLimited:
        raise ToolError("Too many proposed changes in a short time. Try again in a minute.", code="rate_limited") from None
    dry_run(ctx.request, actor, action, payload)
    ttl = settings.NEXUS_AI_PENDING_ACTION_SECONDS
    row = PendingAction.objects.create(
        workspace=actor.workspace, created_by=actor.user, channel=ctx.channel, client_id=ctx.client_id[:100],
        action=action, payload=payload, payload_hash=payload_hash(action, payload, actor.workspace_id, actor.user.pk, ctx.channel),
        preview=preview, expires_at=timezone.now() + timedelta(seconds=ttl),
    )
    audit(ctx.request, "assistant.pendingaction.create", target=row, actor=actor.user,
          metadata={"workspace": str(actor.workspace_id), "action": action, "channel": ctx.channel, "fields": sorted(payload)})
    ctx.pending_ids.append(str(row.pk))
    return serialize(row)


def serialize(row: PendingAction) -> dict:
    return {
        "pending_action_id": str(row.pk),
        "action": row.action,
        "status": row.status,
        "preview": row.preview,
        "expires_at": row.expires_at.isoformat().replace("+00:00", "Z"),
        "result": row.result or {},
    }


class ConfirmFailed(Exception):
    """The confirmed write could not be executed (validation, permission, state)."""

    def __init__(self, err: ApiError, row: PendingAction):
        super().__init__(err.message)
        self.err = err
        self.row = row


def _locked(actor, action_id, channel: str, client_id: str) -> PendingAction:
    from apps.crm.access import _as_uuid

    key = _as_uuid(action_id)
    if key is None:
        raise Http404()
    row = (
        PendingAction.objects.select_for_update()
        .filter(pk=key, workspace_id=actor.workspace_id, created_by_id=actor.user.pk, channel=channel)
        .first()
    )
    if row is None or (channel == "mcp" and row.client_id != client_id[:100]):
        raise Http404()
    return row


@transaction.atomic
def cancel(request, actor, action_id, *, channel: str, client_id: str = "") -> PendingAction:
    row = _locked(actor, action_id, channel, client_id)
    if row.status != PendingAction.Status.PENDING:
        raise Conflict("This proposal was already confirmed or canceled.")
    row.status = PendingAction.Status.CANCELED
    row.decided_at = timezone.now()
    row.save(update_fields=["status", "decided_at", "updated_at"])
    audit(request, "assistant.pendingaction.cancel", target=row, actor=actor.user,
          metadata={"workspace": str(actor.workspace_id), "action": row.action, "channel": channel})
    return row


def _fail(row: PendingAction, code: str, now) -> None:
    row.status, row.error_code, row.decided_at = PendingAction.Status.FAILED, code[:40], now
    row.save(update_fields=["status", "error_code", "decided_at", "updated_at"])


def _as_api_error(exc: Exception) -> ApiError:
    from apps.api.errors import NotFound, PermissionDeniedError

    if isinstance(exc, ApiError):
        return exc
    if isinstance(exc, PermissionDenied):
        return PermissionDeniedError(str(exc) or None)
    return NotFound("A record in this proposal no longer exists or you lost access to it.")


def confirm(request, actor, action_id, *, channel: str, client_id: str = "") -> PendingAction:
    """Executes a pending action once. Raises Http404 (not theirs / unknown), Conflict
    (already decided) or ConfirmFailed (expired, tampered, or the write itself failed; the
    row is marked failed and that mark is committed before the exception leaves)."""
    _limit(actor, "confirm")
    failure: ConfirmFailed | None = None
    with transaction.atomic():
        row = _locked(actor, action_id, channel, client_id)
        if row.status != PendingAction.Status.PENDING:
            raise Conflict("This proposal was already confirmed or canceled. Prepare a new one if you still need the change.")
        now = timezone.now()
        if row.expires_at <= now:
            _fail(row, "expired", now)
            failure = ConfirmFailed(Conflict("This proposal has expired. Prepare it again."), row)
        elif row.payload_hash != payload_hash(row.action, row.payload, actor.workspace_id, actor.user.pk, channel):
            _fail(row, "payload_mismatch", now)
            failure = ConfirmFailed(Conflict("This proposal can't be confirmed. Prepare it again."), row)
        else:
            try:
                with transaction.atomic():
                    refs = executor(row.action).run(request, actor, row.payload)
            except (ApiError, ValidationFailed, PermissionDenied, Http404) as exc:
                err = _as_api_error(exc)
                _fail(row, err.code, now)
                audit(request, "assistant.pendingaction.fail", target=row, actor=actor.user,
                      metadata={"workspace": str(actor.workspace_id), "action": row.action, "channel": channel, "error": err.code})
                failure = ConfirmFailed(err, row)
            else:
                row.status, row.decided_at = PendingAction.Status.CONFIRMED, now
                row.result = {"records": [{"type": t, "id": i} for t, i in refs]}
                row.save(update_fields=["status", "decided_at", "result", "updated_at"])
                audit(request, "assistant.pendingaction.confirm", target=row, actor=actor.user,
                      metadata={"workspace": str(actor.workspace_id), "action": row.action, "channel": channel})
    if failure is not None:
        raise failure
    return row
