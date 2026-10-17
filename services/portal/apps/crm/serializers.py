"""JSON shapes of business records.

Serializers never follow a relation the actor may not see: nested contacts,
opportunities, tasks and generic references are included only when visible (a ``Ctx``
batches those checks per page), and sensitive custom fields are dropped for roles that only
read shared records. Users are always referenced by their random ``public_id``.
"""

from __future__ import annotations

from collections import defaultdict
from decimal import Decimal

from . import access
from . import models as m
from .access import CHANGE, DELETE, VIEW, Actor


def user_ref(user) -> dict | None:
    if user is None:
        return None
    return {"id": str(user.public_id), "username": user.username, "name": user.name, "matrix_id": user.matrix_id}


def money(value: Decimal | None) -> str | None:
    return None if value is None else f"{value:.2f}"


class Ctx:
    """Per-request cache: which related objects the actor may see or change."""

    def __init__(self, actor: Actor):
        self.actor = actor
        self._ids: dict[tuple[type, str], set] = defaultdict(set)
        self._sensitive: dict[str, set[str]] = {}

    def prime(self, model, ids, action: str = VIEW) -> None:
        ids = {i for i in ids if i}
        known = self._ids.get((model, action + ":checked"), set())
        todo = ids - known
        if todo:
            found = set(access.for_actor(self.actor, model, action).filter(pk__in=todo).values_list("pk", flat=True))
            self._ids[(model, action)].update(found)
            self._ids[(model, action + ":checked")].update(todo)

    def allowed(self, model, pk, action: str = VIEW) -> bool:
        if pk is None:
            return False
        self.prime(model, [pk], action)
        return pk in self._ids[(model, action)]

    def hidden_custom_keys(self, entity: str) -> set[str]:
        """Sensitive custom-field keys this actor must not receive."""
        if self.actor.view_level not in {"team", "none"}:
            return set()
        if entity not in self._sensitive:
            self._sensitive[entity] = set(
                m.FieldDefinition.objects.filter(workspace_id=self.actor.workspace_id, entity=entity, sensitive=True).values_list("key", flat=True)
            )
        return self._sensitive[entity]

    def perms(self, model, pk) -> dict[str, bool]:
        return {"change": self.allowed(model, pk, CHANGE), "delete": self.allowed(model, pk, DELETE)}


def _custom(ctx: Ctx, entity: str, values: dict) -> dict:
    hidden = ctx.hidden_custom_keys(entity)
    return {k: v for k, v in (values or {}).items() if k not in hidden}


def contact_ref(ctx: Ctx, contact) -> dict | None:
    if contact is None or not ctx.allowed(m.Contact, contact.pk):
        return None
    return {"id": str(contact.pk), "display_name": contact.display_name, "kind": contact.kind}


def opportunity_ref(ctx: Ctx, opp) -> dict | None:
    if opp is None or not ctx.allowed(m.Opportunity, opp.pk):
        return None
    return {"id": str(opp.pk), "name": opp.name, "status": opp.status}


def task_ref(ctx: Ctx, task) -> dict | None:
    if task is None or not ctx.allowed(m.Task, task.pk):
        return None
    return {"id": str(task.pk), "title": task.title, "status": task.status}


def related_ref(ctx: Ctx, obj) -> dict | None:
    if not obj.related_type or not obj.related_id:
        return None
    if not access.ref_visible(ctx.actor, obj.related_type, obj.related_id):
        return None
    return {"type": obj.related_type, "id": str(obj.related_id)}


def tag(t: m.Tag) -> dict:
    return {"id": str(t.pk), "name": t.name, "color": t.color}


def contact(ctx: Ctx, c: m.Contact) -> dict:
    return {
        "id": str(c.pk),
        "type": "crm.contact",
        "kind": c.kind,
        "roles": list(c.roles or []),
        "first_name": c.first_name,
        "last_name": c.last_name,
        "display_name": c.display_name,
        "company": c.company,
        "job_title": c.job_title,
        "email": c.email,
        "phone": c.phone,
        "owner": user_ref(c.owner),
        "assignees": [user_ref(u) for u in c.assignees.all()],
        "visibility": c.visibility,
        "source": c.source,
        "campaign": c.campaign,
        "follow_up_at": c.follow_up_at,
        "priority": c.priority,
        "tags": [tag(t) for t in c.tags.all()],
        "custom_fields": _custom(ctx, "contact", c.custom_fields),
        "last_activity_at": c.last_activity_at,
        "archived": c.archived_at is not None,
        "is_demo": c.is_demo,
        "created_at": c.created_at,
        "updated_at": c.updated_at,
        "created_by": user_ref(c.created_by),
        "permissions": ctx.perms(m.Contact, c.pk),
    }


def prepare_contacts(ctx: Ctx, rows: list[m.Contact]) -> list[m.Contact]:
    ids = [c.pk for c in rows]
    ctx.prime(m.Contact, ids)
    ctx.prime(m.Contact, ids, CHANGE)
    ctx.prime(m.Contact, ids, DELETE)
    return rows


def contact_queryset(qs):
    return qs.select_related("owner", "created_by").prefetch_related("assignees", "tags")


def stage(s: m.Stage) -> dict:
    return {
        "id": str(s.pk),
        "pipeline_id": str(s.pipeline_id),
        "name": s.name,
        "position": s.position,
        "is_won": s.is_won,
        "is_lost": s.is_lost,
        "probability": s.probability,
    }


def pipeline(p: m.Pipeline, *, stages=None) -> dict:
    stage_rows = stages if stages is not None else list(p.stages.all())
    return {
        "id": str(p.pk),
        "name": p.name,
        "kind": p.kind,
        "position": p.position,
        "is_default": p.is_default,
        "currency": p.currency,
        "archived": p.archived,
        "is_demo": p.is_demo,
        "stages": [stage(s) for s in sorted(stage_rows, key=lambda s: (s.position, s.created_at))],
        "created_at": p.created_at,
        "updated_at": p.updated_at,
    }


def opportunity(ctx: Ctx, o: m.Opportunity) -> dict:
    links = [link for link in o.contact_links.all() if ctx.allowed(m.Contact, link.contact_id)]
    return {
        "id": str(o.pk),
        "type": "crm.opportunity",
        "name": o.name,
        "pipeline_id": str(o.pipeline_id),
        "stage_id": str(o.stage_id),
        "stage": {"id": str(o.stage_id), "name": o.stage.name, "is_won": o.stage.is_won, "is_lost": o.stage.is_lost},
        "status": o.status,
        "value": money(o.value),
        "currency": o.currency,
        "owner": user_ref(o.owner),
        "collaborators": [user_ref(u) for u in o.collaborators.all()],
        "visibility": o.visibility,
        "priority": o.priority,
        "expected_close_date": o.expected_close_date,
        "closed_at": o.closed_at,
        "stage_entered_at": o.stage_entered_at,
        "position": o.position,
        "source": o.source,
        "contacts": [
            {"id": str(link.contact_id), "display_name": link.contact.display_name, "role": link.role} for link in links
        ],
        "custom_fields": _custom(ctx, "opportunity", o.custom_fields),
        "is_demo": o.is_demo,
        "created_at": o.created_at,
        "updated_at": o.updated_at,
        "created_by": user_ref(o.created_by),
        "permissions": ctx.perms(m.Opportunity, o.pk),
    }


def opportunity_queryset(qs):
    return qs.select_related("owner", "stage", "created_by").prefetch_related("collaborators", "contact_links__contact")


def prepare_opportunities(ctx: Ctx, rows: list[m.Opportunity]) -> list[m.Opportunity]:
    ids = [o.pk for o in rows]
    ctx.prime(m.Opportunity, ids)
    ctx.prime(m.Opportunity, ids, CHANGE)
    ctx.prime(m.Opportunity, ids, DELETE)
    ctx.prime(m.Contact, [link.contact_id for o in rows for link in o.contact_links.all()])
    return rows


def stage_history(h: m.StageHistory) -> dict:
    return {
        "id": str(h.pk),
        "from_stage_id": str(h.from_stage_id) if h.from_stage_id else None,
        "to_stage_id": str(h.to_stage_id) if h.to_stage_id else None,
        "from_name": h.from_name,
        "to_name": h.to_name,
        "changed_by": user_ref(h.created_by),
        "changed_at": h.created_at,
    }


def task(ctx: Ctx, t: m.Task, *, now=None) -> dict:
    from django.utils import timezone

    now = now or timezone.now()
    return {
        "id": str(t.pk),
        "type": "crm.task",
        "title": t.title,
        "description": t.description,
        "assignee": user_ref(t.assignee),
        "due_at": t.due_at,
        "is_overdue": bool(t.due_at and t.is_open and t.due_at < now),
        "priority": t.priority,
        "status": t.status,
        "completed_at": t.completed_at,
        "completed_by": user_ref(t.completed_by),
        "contact": contact_ref(ctx, t.contact),
        "opportunity": opportunity_ref(ctx, t.opportunity),
        "related": related_ref(ctx, t),
        "source": t.source,
        "visibility": t.visibility,
        "is_demo": t.is_demo,
        "created_at": t.created_at,
        "updated_at": t.updated_at,
        "created_by": user_ref(t.created_by),
        "permissions": ctx.perms(m.Task, t.pk),
    }


def task_queryset(qs):
    return qs.select_related("assignee", "completed_by", "contact", "opportunity", "created_by")


def prepare_tasks(ctx: Ctx, rows: list[m.Task]) -> list[m.Task]:
    ids = [t.pk for t in rows]
    ctx.prime(m.Task, ids, CHANGE)
    ctx.prime(m.Task, ids, DELETE)
    ctx.prime(m.Contact, [t.contact_id for t in rows])
    ctx.prime(m.Opportunity, [t.opportunity_id for t in rows])
    return rows


def activity(ctx: Ctx, a: m.Activity) -> dict:
    return {
        "id": str(a.pk),
        "type": "crm.activity",
        "kind": a.kind,
        "source": a.source,
        "actor": user_ref(a.actor),
        "occurred_at": a.occurred_at,
        "summary": a.summary,
        "body": a.body,
        "external_ref": a.external_ref,
        "room_id": a.room_id,
        "event_id": a.event_id,
        "untrusted": a.untrusted,
        "metadata": a.metadata or {},
        "contact": contact_ref(ctx, a.contact),
        "opportunity": opportunity_ref(ctx, a.opportunity),
        "task": task_ref(ctx, a.task),
        "related": related_ref(ctx, a),
        "is_demo": a.is_demo,
        "created_at": a.created_at,
        "updated_at": a.updated_at,
        "created_by": user_ref(a.created_by),
        "permissions": ctx.perms(m.Activity, a.pk),
    }


def activity_queryset(qs):
    return qs.select_related("actor", "contact", "opportunity", "task", "created_by")


def prepare_activities(ctx: Ctx, rows: list[m.Activity]) -> list[m.Activity]:
    ids = [a.pk for a in rows]
    ctx.prime(m.Activity, ids, CHANGE)
    ctx.prime(m.Activity, ids, DELETE)
    ctx.prime(m.Contact, [a.contact_id for a in rows])
    ctx.prime(m.Opportunity, [a.opportunity_id for a in rows])
    ctx.prime(m.Task, [a.task_id for a in rows])
    return rows


def event(ctx: Ctx, e: m.CalendarEvent) -> dict:
    return {
        "id": str(e.pk),
        "type": "crm.calendarevent",
        "kind": e.kind,
        "title": e.title,
        "description": e.description,
        "start_at": e.start_at,
        "end_at": e.end_at,
        "all_day": e.all_day,
        "location": e.location,
        "organizer": user_ref(e.organizer),
        "attendee_users": [user_ref(u) for u in e.attendee_users.all()],
        "attendee_contacts": [r for r in (contact_ref(ctx, c) for c in e.attendee_contacts.all()) if r],
        "matrix_room_id": e.matrix_room_id,
        "contact": contact_ref(ctx, e.contact),
        "opportunity": opportunity_ref(ctx, e.opportunity),
        "related": related_ref(ctx, e),
        "status": e.status,
        "visibility": e.visibility,
        "is_demo": e.is_demo,
        "created_at": e.created_at,
        "updated_at": e.updated_at,
        "created_by": user_ref(e.created_by),
        "permissions": ctx.perms(m.CalendarEvent, e.pk),
    }


def event_queryset(qs):
    return qs.select_related("organizer", "contact", "opportunity", "created_by").prefetch_related("attendee_users", "attendee_contacts")


def prepare_events(ctx: Ctx, rows: list[m.CalendarEvent]) -> list[m.CalendarEvent]:
    ids = [e.pk for e in rows]
    ctx.prime(m.CalendarEvent, ids, CHANGE)
    ctx.prime(m.CalendarEvent, ids, DELETE)
    ctx.prime(m.Contact, [e.contact_id for e in rows] + [c.pk for e in rows for c in e.attendee_contacts.all()])
    ctx.prime(m.Opportunity, [e.opportunity_id for e in rows])
    return rows


def field_definition(f: m.FieldDefinition) -> dict:
    return {
        "id": str(f.pk),
        "entity": f.entity,
        "key": f.key,
        "label": f.label,
        "field_type": f.field_type,
        "options": f.options or [],
        "required": f.required,
        "sensitive": f.sensitive,
        "profile": f.profile,
        "position": f.position,
        "archived": f.archived,
    }


def conversation_link(ctx: Ctx, link: m.ConversationLink) -> dict:
    return {
        "id": str(link.pk),
        "room_id": link.room_id,
        "event_id": link.event_id,
        "contact": contact_ref(ctx, link.contact),
        "opportunity": opportunity_ref(ctx, link.opportunity),
        "created_by": user_ref(link.created_by),
        "created_at": link.created_at,
        "permissions": ctx.perms(m.ConversationLink, link.pk),
    }


def mapping(x: m.ExternalRecordMapping) -> dict:
    return {
        "id": str(x.pk),
        "provider": x.provider,
        "external_id": x.external_id,
        "object": {"type": x.object_type, "id": str(x.object_id)},
        "external_url": x.external_url,
        "last_synced_at": x.last_synced_at,
        "created_at": x.created_at,
    }


def record_link(x: m.RecordLink) -> dict:
    return {
        "id": str(x.pk),
        "from": {"type": x.from_type, "id": str(x.from_id)},
        "to": {"type": x.to_type, "id": str(x.to_id)},
        "relation": x.relation,
        "created_at": x.created_at,
    }
