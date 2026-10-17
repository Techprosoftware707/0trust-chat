"""Meeting notes and action items ("review suggested next steps").

Notes are written explicitly by people; the server never sees call audio, video or chat
messages (end-to-end encrypted), and there is no recording or transcription in this build.

Action items start as *proposals* — from a teammate, or later from the AI assistant
(``propose_action_item(..., source="ai_suggestion")``) — and become real tasks only when a
person confirms them (``confirm_action_item``). Proposals announce ``action_item.proposed`` to
the automation engine.
"""

from __future__ import annotations

import datetime as dt

from django.core.exceptions import PermissionDenied
from django.db.models import Q
from django.utils import timezone

from apps.api.errors import Conflict, ValidationFailed
from apps.api.schema import F, validate

from . import access, services
from . import models as m
from .access import VIEW, Actor, Cap

NOTE_SPEC = {
    "event_id": F.uuid(null=True, default=None),
    "contact_id": F.uuid(null=True, default=None),
    "opportunity_id": F.uuid(null=True, default=None),
    "room_id": services.room_field(),
    "title": F.string(max_length=200, required=True, blank=False),
    "body": F.string(max_length=20000, multiline=True),
    "visibility": F.choice(m.MeetingNote.Visibility.values, default=m.MeetingNote.Visibility.TEAM),
}


def create_meeting_note(request, actor: Actor, body: dict) -> m.MeetingNote:
    """Explicit notes about a meeting (typed by a person; never call or chat content)."""
    access.require(actor, Cap.EVENTS_CREATE, "Your role can't add meeting notes.")
    data = validate(body, NOTE_SPEC)
    note = m.MeetingNote(workspace=actor.workspace, created_by=actor.user, title=data["title"], body=data["body"],
                         visibility=data["visibility"], room_id=data["room_id"])
    note.event = access.resolve_one(actor, m.CalendarEvent, data["event_id"], field_name="event_id")
    note.contact = access.resolve_one(actor, m.Contact, data["contact_id"], field_name="contact_id")
    note.opportunity = access.resolve_one(actor, m.Opportunity, data["opportunity_id"], field_name="opportunity_id")
    if note.event is not None:
        note.contact = note.contact or note.event.contact
        note.opportunity = note.opportunity or note.event.opportunity
        note.room_id = note.room_id or note.event.matrix_room_id
    if not (note.event or note.contact or note.opportunity):
        raise ValidationFailed(fields={"event_id": ["Attach the notes to a meeting, a contact or a deal."]})
    note.save()
    services.sync_note_timeline(note)
    access.audit_write(request, actor, "create", note, fields=list(body))
    return note


def update_meeting_note(request, actor: Actor, note: m.MeetingNote, body: dict) -> m.MeetingNote:
    spec = {k: NOTE_SPEC[k] for k in ("title", "body", "visibility")}
    spec["title"] = F.string(max_length=200, blank=False)
    data = validate(body, spec, partial=True)
    changed: list[str] = []
    services._set(note, data, list(spec), changed)
    note.save()
    services.sync_note_timeline(note)
    access.audit_write(request, actor, "update", note, fields=changed)
    return note


ITEM_SPEC = {
    "note_id": F.uuid(null=True, default=None),
    "event_id": F.uuid(null=True, default=None),
    "contact_id": F.uuid(null=True, default=None),
    "opportunity_id": F.uuid(null=True, default=None),
    "title": F.string(max_length=200, required=True, blank=False),
    "description": F.string(max_length=2000, multiline=True),
    "suggested_assignee_id": F.uuid(null=True, default=None),
    "suggested_due_at": F.datetime(null=True, default=None),
}


def propose_action_item(request, actor: Actor, body: dict, *, source: str = m.ActionItem.Source.MANUAL) -> m.ActionItem:
    """A suggested next step. It stays a proposal until a person confirms it into a task.

    The AI assistant passes ``source="ai_suggestion"`` (server-side only; clients can't)."""
    if not (actor.can(Cap.TASKS_CREATE) or actor.can(Cap.TASKS_CREATE_OWN)):
        raise PermissionDenied("Your role can't suggest next steps.")
    if source not in m.ActionItem.Source.values:
        raise ValueError(source)
    data = validate(body, ITEM_SPEC)
    item = m.ActionItem(workspace=actor.workspace, created_by=actor.user, title=data["title"], description=data["description"],
                        suggested_due_at=data["suggested_due_at"], source=source)
    item.note = access.resolve_one(actor, m.MeetingNote, data["note_id"], field_name="note_id")
    item.event = access.resolve_one(actor, m.CalendarEvent, data["event_id"], field_name="event_id")
    item.contact = access.resolve_one(actor, m.Contact, data["contact_id"], field_name="contact_id")
    item.opportunity = access.resolve_one(actor, m.Opportunity, data["opportunity_id"], field_name="opportunity_id")
    if item.note is not None:
        item.event = item.event or item.note.event
        item.contact = item.contact or item.note.contact
        item.opportunity = item.opportunity or item.note.opportunity
    item.suggested_assignee = (access.resolve_member(actor, str(data["suggested_assignee_id"]), field_name="suggested_assignee_id")
                               if data["suggested_assignee_id"] else None)
    item.save()
    access.audit_write(request, actor, "create", item, fields=list(body), extra={"source": source})
    from apps.automation import engine

    engine.emit(actor.workspace_id, "action_item.proposed", subject=item, dedup_key=str(item.pk), payload=engine.action_item_facts(item),
                actor=actor.user)
    return item


CONFIRM_SPEC = {
    "title": F.string(max_length=200, blank=False),
    "assignee_id": F.uuid(null=True),
    "due_at": F.datetime(null=True),
    "priority": F.choice(m.Priority.values),
}


def confirm_action_item(request, actor: Actor, item: m.ActionItem, body: dict) -> tuple[m.ActionItem, m.Task]:
    """A person confirms a suggested next step: it becomes a task (with the person's
    edits). AI suggestions become tasks with ``source="ai_suggestion_confirmed"``."""
    if not access.for_actor(actor, m.ActionItem, VIEW).filter(pk=item.pk).exists():
        raise PermissionDenied()
    if item.status != m.ActionItem.Status.PROPOSED:
        raise Conflict("This next step was handled already.")
    data = validate(body, CONFIRM_SPEC, partial=True)
    assignee_id = data.get("assignee_id") if "assignee_id" in data else (item.suggested_assignee.public_id if item.suggested_assignee else None)
    due = data.get("due_at") if "due_at" in data else item.suggested_due_at
    task_body = {
        "title": data.get("title") or item.title,
        "description": item.description,
        "due_at": due.isoformat() if due else None,
        "priority": data.get("priority", "normal"),
        "contact_id": str(item.contact_id) if item.contact_id and access.ref_visible(actor, "crm.contact", item.contact_id) else None,
        "opportunity_id": (str(item.opportunity_id) if item.opportunity_id and access.ref_visible(actor, "crm.opportunity", item.opportunity_id)
                           else None),
        "source": "ai_suggestion_confirmed" if item.source == m.ActionItem.Source.AI_SUGGESTION else "manual",
    }
    if assignee_id:
        task_body["assignee_id"] = str(assignee_id)
    if item.event_id and access.ref_visible(actor, "crm.calendarevent", item.event_id):
        task_body["related"] = {"type": "crm.calendarevent", "id": str(item.event_id)}
    task = services.create_task(request, actor, task_body)
    item.status = m.ActionItem.Status.CONFIRMED
    item.task = task
    item.decided_by, item.decided_at = actor.user, timezone.now()
    item.save(update_fields=["status", "task", "decided_by", "decided_at", "updated_at"])
    access.audit_write(request, actor, "confirm", item, fields=["status", "task"])
    return item, task


def dismiss_action_item(request, actor: Actor, item: m.ActionItem) -> m.ActionItem:
    services.ensure_actor_can(actor, m.ActionItem, item, "change")
    if item.status != m.ActionItem.Status.PROPOSED:
        raise Conflict("This next step was handled already.")
    item.status = m.ActionItem.Status.DISMISSED
    item.decided_by, item.decided_at = actor.user, timezone.now()
    item.save(update_fields=["status", "decided_by", "decided_at", "updated_at"])
    access.audit_write(request, actor, "dismiss", item, fields=["status"])
    return item


def update_action_item(request, actor: Actor, item: m.ActionItem, body: dict) -> m.ActionItem:
    spec = {k: ITEM_SPEC[k] for k in ("title", "description", "suggested_assignee_id", "suggested_due_at")}
    spec["title"] = F.string(max_length=200, blank=False)
    data = validate(body, spec, partial=True)
    if item.status != m.ActionItem.Status.PROPOSED:
        raise Conflict("Only proposed next steps can be edited.")
    changed: list[str] = []
    services._set(item, data, ["title", "description", "suggested_due_at"], changed)
    if "suggested_assignee_id" in data:
        item.suggested_assignee = (access.resolve_member(actor, str(data["suggested_assignee_id"]), field_name="suggested_assignee_id")
                                   if data["suggested_assignee_id"] else None)
        changed.append("suggested_assignee")
    item.save()
    access.audit_write(request, actor, "update", item, fields=changed)
    return item


def upcoming_meetings(actor: Actor, *, days: int = 14, mine: bool = True, limit: int = 50):
    """Scheduled events from now on (the actor's own by default: organizer or attendee)."""
    now = timezone.now()
    qs = access.for_actor(actor, m.CalendarEvent).filter(end_at__gte=now, start_at__lte=now + dt.timedelta(days=days),
                                                         status=m.CalendarEvent.Status.SCHEDULED)
    if mine:
        attending = m.CalendarEvent.attendee_users.through.objects.filter(user_id=actor.user.pk).values("calendarevent_id")
        qs = qs.filter(Q(organizer=actor.user) | Q(pk__in=attending))
    return qs.order_by("start_at")[:limit]
