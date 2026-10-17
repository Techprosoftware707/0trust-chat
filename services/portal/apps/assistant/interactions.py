"""The AI audit log (``AIInteraction``): who used AI where, with which provider or client,
which tools ran and which record IDs they touched. Content (question and answer text) is
stored only if the workspace set a retention period, and is purged when it expires."""

from __future__ import annotations

from datetime import timedelta

from django.utils import timezone

from .models import AIInteraction
from .safety import ai_settings, scrub


def log_interaction(actor, *, channel: str, provider: str, model: str = "", client_id: str = "", tool_names=(), touched=(),
                    pending_ids=(), status: str = AIInteraction.Status.OK, error_code: str = "", started_at=None,
                    content: dict | None = None) -> AIInteraction:
    now = timezone.now()
    row = AIInteraction(
        workspace=actor.workspace, created_by=actor.user, channel=channel, provider=provider[:40], model=model[:120],
        client_id=client_id[:100], tool_names=list(tool_names)[:50],
        record_refs=[{"type": t, "id": i} for t, i in list(touched)[:200]], pending_action_ids=list(pending_ids)[:20],
        status=status, error_code=error_code[:60], started_at=started_at or now, finished_at=now,
    )
    days = ai_settings(actor.workspace).content_retention_days if content else 0
    if content and days:
        row.content = {k: scrub(v)[:20000] if isinstance(v, str) else v for k, v in content.items()}
        row.content_expires_at = now + timedelta(days=days)
    row.save()
    return row


def purge_expired_content(now=None) -> int:
    now = now or timezone.now()
    return AIInteraction.objects.filter(content_expires_at__lte=now).update(content=None, content_expires_at=None)


def serialize(row: AIInteraction, *, with_content: bool) -> dict:
    from apps.crm.serializers import user_ref

    out = {
        "id": str(row.pk), "channel": row.channel, "provider": row.provider, "model": row.model, "client_id": row.client_id,
        "tool_names": row.tool_names, "record_refs": row.record_refs, "pending_action_ids": row.pending_action_ids,
        "status": row.status, "error_code": row.error_code, "started_at": row.started_at, "finished_at": row.finished_at,
        "user": user_ref(row.created_by), "content_retained": row.content is not None,
    }
    if with_content and row.content is not None:
        out["content"] = row.content
        out["content_expires_at"] = row.content_expires_at
    return out
