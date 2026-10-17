"""Business rules for CRM records: validation of every write, stage moves, task
completion, timeline entries, custom fields and default pipelines.

Every function takes an ``Actor`` and re-checks permissions through ``access``; IDs in a
body are resolved with ``access.resolve*`` (unknown and inaccessible look the same). Each
write is audited by ``access.audit_write``. Other teams call these functions (not the ORM)
when they create records on a person's behalf, and use the ``record_*`` helpers for
server-side writes (integrations, automation).
"""

from __future__ import annotations

import re
from datetime import date, datetime
from decimal import Decimal
from typing import Any

from django.core.exceptions import PermissionDenied
from django.db import transaction
from django.db.models import Max, Q
from django.utils import timezone

from apps.api.errors import ApiError, Conflict, ValidationFailed
from apps.api.schema import F, Invalid, validate

from . import access
from . import models as m
from .access import CHANGE, DELETE, Actor, Cap

ROOM_ID_RE = re.compile(r"^![^:\s]{1,250}(:[^\s]{1,250})?$")
EVENT_ID_RE = re.compile(r"^\$[A-Za-z0-9+/_=:.\-]{1,254}$")
CURRENCY_RE = re.compile(r"^[A-Z]{3}$")


class PlanLimit(ApiError):
    status, code, message = 403, "plan_limit", "The workspace's plan does not allow more of these."


def _matrix_room(value: str) -> str:
    if value and (len(value) > 255 or not ROOM_ID_RE.match(value)):
        raise Invalid("Must be a Matrix room ID (!…).")
    return value


def _matrix_event(value: str) -> str:
    if value and not EVENT_ID_RE.match(value):
        raise Invalid("Must be a Matrix event ID ($…).")
    return value


def _currency(value: str) -> str:
    value = (value or "").upper()
    if not CURRENCY_RE.match(value):
        raise Invalid("Must be a three-letter currency code, e.g. USD.")
    return value


def room_field(**kw) -> F:
    base = F.string(max_length=255, **kw)
    return F(lambda v: _matrix_room(base.parse(v)), required=base.required, null=base.null, default=base.default)


def event_field(**kw) -> F:
    base = F.string(max_length=255, **kw)
    return F(lambda v: _matrix_event(base.parse(v)), required=base.required, null=base.null, default=base.default)


def currency_field(**kw) -> F:
    base = F.string(max_length=3, **kw)
    return F(lambda v: _currency(base.parse(v)), required=base.required, null=base.null, default=base.default)


def _set(obj, data: dict, keys: list[str], changed: list[str]) -> None:
    for key in keys:
        if key in data and getattr(obj, key) != data[key]:
            setattr(obj, key, data[key])
            changed.append(key)


# --- custom fields ------------------------------------------------------------------------

_CUSTOM_PARSERS = {
    m.FieldDefinition.Type.TEXT: lambda d: F.string(max_length=300),
    m.FieldDefinition.Type.LONG_TEXT: lambda d: F.string(max_length=5000, multiline=True),
    m.FieldDefinition.Type.NUMBER: lambda d: F.integer(min_value=-(10**12), max_value=10**12),
    m.FieldDefinition.Type.DECIMAL: lambda d: F.decimal(max_digits=16, decimal_places=4, min_value=None),
    m.FieldDefinition.Type.CURRENCY: lambda d: F.decimal(max_digits=14, decimal_places=2),
    m.FieldDefinition.Type.BOOLEAN: lambda d: F.boolean(),
    m.FieldDefinition.Type.DATE: lambda d: F.date(),
    m.FieldDefinition.Type.EMAIL: lambda d: F.email(),
    m.FieldDefinition.Type.PHONE: lambda d: F.phone(),
    m.FieldDefinition.Type.URL: lambda d: F.url(),
    m.FieldDefinition.Type.SELECT: lambda d: F.choice([o.get("value") for o in d.options or []]),
    m.FieldDefinition.Type.MULTISELECT: lambda d: F.list(F.choice([o.get("value") for o in d.options or []]), max_items=50),
}


def _json_safe(value: Any) -> Any:
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    return value


def clean_custom_fields(actor: Actor, entity: str, incoming: dict, current: dict | None = None, *, creating: bool) -> dict:
    """Validates ``incoming`` custom values against the workspace's field definitions and
    merges them into ``current``. ``null`` clears a value."""
    defs = {d.key: d for d in m.FieldDefinition.objects.filter(workspace_id=actor.workspace_id, entity=entity, archived=False)}
    result = dict(current or {})
    errors: dict[str, list[str]] = {}
    for key, value in (incoming or {}).items():
        d = defs.get(key)
        if d is None:
            errors[f"custom_fields.{str(key)[:40]}"] = ["Unknown custom field."]
            continue
        if value is None or value == "" or value == []:
            if d.required:
                errors[f"custom_fields.{key}"] = ["This field is required."]
            result.pop(key, None)
            continue
        try:
            result[key] = _json_safe(_CUSTOM_PARSERS[d.field_type](d).parse(value))
        except Invalid as exc:
            errors[f"custom_fields.{key}"] = [str(exc)]
    if creating:
        for key, d in defs.items():
            if d.required and key not in result:
                errors.setdefault(f"custom_fields.{key}", ["This field is required."])
    if errors:
        raise ValidationFailed(fields=errors)
    return result


# --- contacts ---------------------------------------------------------------------------

CONTACT_SPEC = {
    "kind": F.choice(m.Contact.Kind.values, default=m.Contact.Kind.LEAD),
    "roles": F.list(F.choice(m.Contact.Role.values), max_items=10),
    "first_name": F.string(max_length=80),
    "last_name": F.string(max_length=80),
    "company": F.string(max_length=120),
    "job_title": F.string(max_length=120),
    "email": F.email(),
    "phone": F.phone(),
    "owner_id": F.uuid(null=True),
    "assignee_ids": F.list(F.uuid(), max_items=20),
    "visibility": F.choice(m.Visibility.values, default=m.Visibility.TEAM),
    "source": F.string(max_length=60),
    "campaign": F.string(max_length=120),
    "follow_up_at": F.datetime(null=True, default=None),
    "priority": F.choice(m.Priority.values, default=m.Priority.NORMAL),
    "tag_ids": F.list(F.uuid(), max_items=50),
    "custom_fields": F.object(max_keys=100),
    "archived": F.boolean(default=False),
}
_CONTACT_SCALARS = ["kind", "roles", "first_name", "last_name", "company", "job_title", "email", "phone", "visibility",
                    "source", "campaign", "follow_up_at", "priority"]


def _check_contact_named(c: m.Contact) -> None:
    if not (c.first_name or c.last_name or c.company or c.email):
        raise ValidationFailed(fields={"first_name": ["Give the contact a name, a company or an email address."]})


def create_contact(request, actor: Actor, body: dict) -> m.Contact:
    access.require(actor, Cap.RECORDS_CREATE)
    data = validate(body, CONTACT_SPEC)
    from apps.billing.services import workspace_plan

    limit = workspace_plan(actor.workspace).entitlement("crm_max_contacts")
    if m.Contact.objects.filter(workspace_id=actor.workspace_id).count() >= limit:
        raise PlanLimit(f"The plan allows {limit} contacts per workspace.")
    c = m.Contact(workspace=actor.workspace, created_by=actor.user)
    for key in _CONTACT_SCALARS:
        setattr(c, key, data[key])
    c.owner = access.resolve_member(actor, data["owner_id"], field_name="owner_id") if "owner_id" in body else actor.user
    c.custom_fields = clean_custom_fields(actor, "contact", data["custom_fields"], creating=True)
    c.archived_at = timezone.now() if data["archived"] else None
    _check_contact_named(c)
    c.save()
    c.assignees.set(access.resolve_members(actor, data["assignee_ids"], field_name="assignee_ids"))
    c.tags.set(access.resolve(actor, m.Tag, data["tag_ids"], field_name="tag_ids"))
    access.audit_write(request, actor, "create", c, fields=[k for k in body])
    return c


def update_contact(request, actor: Actor, c: m.Contact, body: dict) -> m.Contact:
    data = validate(body, CONTACT_SPEC, partial=True)
    changed: list[str] = []
    _set(c, data, _CONTACT_SCALARS, changed)
    if "owner_id" in data:
        owner = access.resolve_member(actor, data["owner_id"], field_name="owner_id")
        if owner != c.owner:
            c.owner = owner
            changed.append("owner")
    if "custom_fields" in data:
        c.custom_fields = clean_custom_fields(actor, "contact", data["custom_fields"], c.custom_fields, creating=False)
        changed.append("custom_fields")
    if "archived" in data and data["archived"] != (c.archived_at is not None):
        c.archived_at = timezone.now() if data["archived"] else None
        changed.append("archived")
    _check_contact_named(c)
    c.save()
    if "assignee_ids" in data:
        c.assignees.set(access.resolve_members(actor, data["assignee_ids"], field_name="assignee_ids"))
        changed.append("assignees")
    if "tag_ids" in data:
        c.tags.set(access.resolve(actor, m.Tag, data["tag_ids"], field_name="tag_ids"))
        changed.append("tags")
    access.audit_write(request, actor, "update", c, fields=changed)
    return c


def delete_record(request, actor: Actor, obj) -> None:
    access.audit_write(request, actor, "delete", obj)
    obj.delete()


# --- tags and custom field definitions ----------------------------------------------------

TAG_SPEC = {"name": F.string(max_length=50, required=True, blank=False), "color": F.choice(m.Tag.COLORS, default="slate")}


def create_tag(request, actor: Actor, body: dict) -> m.Tag:
    access.require(actor, Cap.TAGS_CREATE)
    data = validate(body, TAG_SPEC)
    if m.Tag.objects.filter(workspace_id=actor.workspace_id, name__iexact=data["name"]).exists():
        raise Conflict("A tag with that name exists already.")
    t = m.Tag.objects.create(workspace=actor.workspace, created_by=actor.user, **data)
    access.audit_write(request, actor, "create", t, fields=list(data))
    return t


def update_tag(request, actor: Actor, t: m.Tag, body: dict) -> m.Tag:
    data = validate(body, TAG_SPEC, partial=True)
    if "name" in data and m.Tag.objects.filter(workspace_id=actor.workspace_id, name__iexact=data["name"]).exclude(pk=t.pk).exists():
        raise Conflict("A tag with that name exists already.")
    changed: list[str] = []
    _set(t, data, ["name", "color"], changed)
    t.save()
    access.audit_write(request, actor, "update", t, fields=changed)
    return t


FIELD_SPEC = {
    "entity": F.choice(m.FieldDefinition.Entity.values, required=True),
    "key": F.string(max_length=40, required=True, blank=False),
    "label": F.string(max_length=80, required=True, blank=False),
    "field_type": F.choice(m.FieldDefinition.Type.values, required=True),
    "options": F.list(F.object(max_keys=2), max_items=100),
    "required": F.boolean(default=False),
    "sensitive": F.boolean(default=False),
    "profile": F.choice([""] + m.BusinessProfile.values, default=""),
    "position": F.integer(min_value=0, max_value=10_000, default=0),
    "archived": F.boolean(default=False),
}
KEY_RE = re.compile(r"^[a-z][a-z0-9_]{0,39}$")


def _clean_options(field_type: str, options: list) -> list:
    if field_type not in {m.FieldDefinition.Type.SELECT, m.FieldDefinition.Type.MULTISELECT}:
        return []
    clean, seen = [], set()
    for o in options:
        value, label = str(o.get("value", "")).strip()[:60], str(o.get("label", o.get("value", ""))).strip()[:80]
        if not value or value in seen:
            raise ValidationFailed(fields={"options": ["Each option needs a unique value."]})
        seen.add(value)
        clean.append({"value": value, "label": label or value})
    if not clean:
        raise ValidationFailed(fields={"options": ["Add at least one option."]})
    return clean


def create_field_definition(request, actor: Actor, body: dict) -> m.FieldDefinition:
    access.require(actor, Cap.CRM_CONFIGURE)
    data = validate(body, FIELD_SPEC)
    if not KEY_RE.match(data["key"]):
        raise ValidationFailed(fields={"key": ["Lowercase letters, digits and _; start with a letter."]})
    data["options"] = _clean_options(data["field_type"], data["options"])
    if m.FieldDefinition.objects.filter(workspace_id=actor.workspace_id, entity=data["entity"], key=data["key"]).exists():
        raise Conflict("A field with that key exists already.")
    f = m.FieldDefinition.objects.create(workspace=actor.workspace, created_by=actor.user, **data)
    access.audit_write(request, actor, "create", f, fields=list(data))
    return f


def update_field_definition(request, actor: Actor, f: m.FieldDefinition, body: dict) -> m.FieldDefinition:
    spec = {k: v for k, v in FIELD_SPEC.items() if k not in {"entity", "key", "field_type"}}
    data = validate(body, spec, partial=True)
    if "options" in data:
        data["options"] = _clean_options(f.field_type, data["options"])
    changed: list[str] = []
    _set(f, data, list(spec), changed)
    f.save()
    access.audit_write(request, actor, "update", f, fields=changed)
    return f


# --- pipelines and stages -------------------------------------------------------------------

DEFAULT_PIPELINES = {
    m.Pipeline.Kind.GENERAL: ("Sales", [("Lead", 10, False, False), ("Qualified", 25, False, False), ("Proposal", 50, False, False),
                                        ("Negotiation", 75, False, False), ("Won", 100, True, False), ("Lost", 0, False, True)]),
    m.Pipeline.Kind.REAL_ESTATE: ("Real estate", [("New lead", 10, False, False), ("Showing", 30, False, False), ("Offer", 55, False, False),
                                                  ("Under contract", 80, False, False), ("Closed", 100, True, False), ("Lost", 0, False, True)]),
    m.Pipeline.Kind.LENDING: ("Lending", [("Application", 10, False, False), ("Processing", 30, False, False), ("Underwriting", 55, False, False),
                                          ("Approved", 80, False, False), ("Funded", 100, True, False), ("Declined", 0, False, True)]),
}
PROFILE_PIPELINE = {
    m.BusinessProfile.GENERAL: m.Pipeline.Kind.GENERAL,
    m.BusinessProfile.REAL_ESTATE: m.Pipeline.Kind.REAL_ESTATE,
    m.BusinessProfile.LENDING: m.Pipeline.Kind.LENDING,
}


def create_default_pipeline(workspace, kind: str, *, user=None, is_demo: bool = False, currency: str = "USD") -> m.Pipeline:
    name, stages = DEFAULT_PIPELINES[kind]
    position = (m.Pipeline.objects.filter(workspace=workspace).aggregate(p=Max("position"))["p"] or 0) + 10
    is_default = not m.Pipeline.objects.filter(workspace=workspace, is_default=True).exists()
    p = m.Pipeline.objects.create(workspace=workspace, name=name, kind=kind, position=position, is_default=is_default,
                                  currency=currency, created_by=user, is_demo=is_demo)
    for i, (sname, prob, won, lost) in enumerate(stages):
        m.Stage.objects.create(workspace=workspace, pipeline=p, name=sname, position=(i + 1) * 10, probability=prob,
                               is_won=won, is_lost=lost, created_by=user, is_demo=is_demo)
    return p


PIPELINE_SPEC = {
    "name": F.string(max_length=80, required=True, blank=False),
    "kind": F.choice(m.Pipeline.Kind.values, default=m.Pipeline.Kind.GENERAL),
    "position": F.integer(min_value=0, max_value=100_000, default=0),
    "is_default": F.boolean(default=False),
    "currency": currency_field(default="USD"),
    "archived": F.boolean(default=False),
    "stages": F.list(F.string(max_length=80, blank=False), max_items=30),
}


def _single_default(p: m.Pipeline) -> None:
    if p.is_default:
        m.Pipeline.objects.filter(workspace_id=p.workspace_id, is_default=True).exclude(pk=p.pk).update(is_default=False)


def create_pipeline(request, actor: Actor, body: dict) -> m.Pipeline:
    access.require(actor, Cap.CRM_CONFIGURE)
    data = validate(body, PIPELINE_SPEC)
    stage_names = data.pop("stages")
    p = m.Pipeline.objects.create(workspace=actor.workspace, created_by=actor.user, **data)
    if stage_names:
        for i, name in enumerate(stage_names):
            m.Stage.objects.create(workspace=actor.workspace, pipeline=p, name=name, position=(i + 1) * 10, created_by=actor.user)
    else:
        _, template = DEFAULT_PIPELINES[p.kind]
        for i, (name, prob, won, lost) in enumerate(template):
            m.Stage.objects.create(workspace=actor.workspace, pipeline=p, name=name, position=(i + 1) * 10, probability=prob,
                                   is_won=won, is_lost=lost, created_by=actor.user)
    _single_default(p)
    access.audit_write(request, actor, "create", p, fields=list(body))
    return p


def update_pipeline(request, actor: Actor, p: m.Pipeline, body: dict) -> m.Pipeline:
    spec = {k: v for k, v in PIPELINE_SPEC.items() if k != "stages"}
    data = validate(body, spec, partial=True)
    changed: list[str] = []
    _set(p, data, list(spec), changed)
    p.save()
    _single_default(p)
    access.audit_write(request, actor, "update", p, fields=changed)
    return p


def delete_pipeline(request, actor: Actor, p: m.Pipeline) -> None:
    if m.Opportunity.objects.filter(pipeline=p).exists():
        raise Conflict("Move or delete this pipeline's opportunities first, or archive the pipeline.")
    delete_record(request, actor, p)


STAGE_SPEC = {
    "name": F.string(max_length=80, required=True, blank=False),
    "position": F.integer(min_value=0, max_value=100_000),
    "is_won": F.boolean(default=False),
    "is_lost": F.boolean(default=False),
    "probability": F.integer(min_value=0, max_value=100, null=True, default=None),
}


def _check_stage_flags(s: m.Stage) -> None:
    if s.is_won and s.is_lost:
        raise ValidationFailed(fields={"is_won": ["A stage can't be both won and lost."]})


def create_stage(request, actor: Actor, p: m.Pipeline, body: dict) -> m.Stage:
    access.require(actor, Cap.CRM_CONFIGURE)
    data = validate(body, STAGE_SPEC)
    if "position" not in data:
        data["position"] = (p.stages.aggregate(x=Max("position"))["x"] or 0) + 10
    s = m.Stage(workspace=actor.workspace, pipeline=p, created_by=actor.user, **data)
    _check_stage_flags(s)
    s.save()
    access.audit_write(request, actor, "create", s, fields=list(data))
    return s


def update_stage(request, actor: Actor, s: m.Stage, body: dict) -> m.Stage:
    data = validate(body, STAGE_SPEC, partial=True)
    changed: list[str] = []
    _set(s, data, list(STAGE_SPEC), changed)
    _check_stage_flags(s)
    s.save()
    if {"is_won", "is_lost"} & set(changed):
        for o in m.Opportunity.objects.filter(stage=s):
            _apply_status(o)
            o.save(update_fields=["status", "closed_at", "updated_at"])
    access.audit_write(request, actor, "update", s, fields=changed)
    return s


def delete_stage(request, actor: Actor, s: m.Stage) -> None:
    if m.Opportunity.objects.filter(stage=s).exists():
        raise Conflict("Move this stage's opportunities to another stage first.")
    if m.Stage.objects.filter(pipeline_id=s.pipeline_id).count() <= 1:
        raise Conflict("A pipeline needs at least one stage.")
    delete_record(request, actor, s)


def reorder_stages(request, actor: Actor, p: m.Pipeline, body: dict) -> m.Pipeline:
    access.require(actor, Cap.CRM_CONFIGURE)
    data = validate(body, {"stage_ids": F.list(F.uuid(), max_items=50, required=True)})
    current = list(p.stages.all())
    if set(data["stage_ids"]) != {s.pk for s in current} or len(data["stage_ids"]) != len(current):
        raise ValidationFailed(fields={"stage_ids": ["List every stage of this pipeline exactly once."]})
    by_id = {s.pk: s for s in current}
    for i, sid in enumerate(data["stage_ids"]):
        by_id[sid].position = (i + 1) * 10
        by_id[sid].save(update_fields=["position", "updated_at"])
    access.audit_write(request, actor, "reorder", p, fields=["stages"])
    return p


# --- opportunities ----------------------------------------------------------------------------

OPPORTUNITY_SPEC = {
    "name": F.string(max_length=160, required=True, blank=False),
    "pipeline_id": F.uuid(required=True),
    "stage_id": F.uuid(null=True, default=None),
    "contact_ids": F.list(F.uuid(), max_items=20),
    "value": F.decimal(max_digits=14, decimal_places=2, null=True, default=None),
    "currency": currency_field(null=True, default=None),
    "owner_id": F.uuid(null=True),
    "collaborator_ids": F.list(F.uuid(), max_items=20),
    "visibility": F.choice(m.Visibility.values, default=m.Visibility.TEAM),
    "priority": F.choice(m.Priority.values, default=m.Priority.NORMAL),
    "expected_close_date": F.date(null=True, default=None),
    "source": F.string(max_length=60),
    "custom_fields": F.object(max_keys=100),
}


def _apply_status(o: m.Opportunity) -> None:
    status = m.Opportunity.Status.WON if o.stage.is_won else m.Opportunity.Status.LOST if o.stage.is_lost else m.Opportunity.Status.OPEN
    if status != o.status:
        o.status = status
        o.closed_at = timezone.now() if status != m.Opportunity.Status.OPEN else None


def _set_contacts(actor: Actor, o: m.Opportunity, contact_ids: list) -> None:
    contacts = access.resolve(actor, m.Contact, contact_ids, field_name="contact_ids")
    m.OpportunityContact.objects.filter(opportunity=o).exclude(contact__in=contacts).delete()
    existing = set(m.OpportunityContact.objects.filter(opportunity=o).values_list("contact_id", flat=True))
    for i, c in enumerate(contacts):
        if c.pk not in existing:
            m.OpportunityContact.objects.create(
                opportunity=o, contact=c, role=m.OpportunityContact.Role.PRIMARY if i == 0 else m.OpportunityContact.Role.OTHER
            )


def _bottom_position(stage: m.Stage) -> float:
    return (m.Opportunity.objects.filter(stage=stage).aggregate(p=Max("position"))["p"] or 0) + 1024


def create_opportunity(request, actor: Actor, body: dict) -> m.Opportunity:
    access.require(actor, Cap.RECORDS_CREATE)
    data = validate(body, OPPORTUNITY_SPEC)
    pipeline = access.resolve_one(actor, m.Pipeline, data["pipeline_id"], field_name="pipeline_id")
    if data["stage_id"]:
        stage = access.resolve_one(actor, m.Stage, data["stage_id"], field_name="stage_id")
        if stage.pipeline_id != pipeline.pk:
            raise ValidationFailed(fields={"stage_id": ["The stage belongs to another pipeline."]})
    else:
        stage = pipeline.stages.order_by("position", "created_at").first()
        if stage is None:
            raise ValidationFailed(fields={"pipeline_id": ["The pipeline has no stages."]})
    o = m.Opportunity(workspace=actor.workspace, created_by=actor.user, name=data["name"], pipeline=pipeline, stage=stage,
                      value=data["value"], currency=data["currency"] or pipeline.currency, visibility=data["visibility"],
                      priority=data["priority"], expected_close_date=data["expected_close_date"], source=data["source"])
    o.owner = access.resolve_member(actor, data["owner_id"], field_name="owner_id") if "owner_id" in body else actor.user
    o.custom_fields = clean_custom_fields(actor, "opportunity", data["custom_fields"], creating=True)
    o.position = _bottom_position(stage)
    _apply_status(o)
    o.save()
    o.collaborators.set(access.resolve_members(actor, data["collaborator_ids"], field_name="collaborator_ids"))
    _set_contacts(actor, o, data["contact_ids"])
    m.StageHistory.objects.create(workspace=actor.workspace, opportunity=o, to_stage=stage, to_name=stage.name, created_by=actor.user)
    access.audit_write(request, actor, "create", o, fields=list(body))
    return o


def update_opportunity(request, actor: Actor, o: m.Opportunity, body: dict) -> m.Opportunity:
    spec = {k: v for k, v in OPPORTUNITY_SPEC.items() if k != "pipeline_id"}
    spec["name"] = F.string(max_length=160, blank=False)
    spec["currency"] = currency_field()
    data = validate(body, spec, partial=True)
    changed: list[str] = []
    _set(o, data, ["name", "value", "currency", "visibility", "priority", "expected_close_date", "source"], changed)
    if "owner_id" in data:
        owner = access.resolve_member(actor, data["owner_id"], field_name="owner_id")
        if owner != o.owner:
            o.owner = owner
            changed.append("owner")
    if "custom_fields" in data:
        o.custom_fields = clean_custom_fields(actor, "opportunity", data["custom_fields"], o.custom_fields, creating=False)
        changed.append("custom_fields")
    o.save()
    if data.get("stage_id") and data["stage_id"] != o.stage_id:
        move_opportunity(request, actor, o, {"stage_id": str(data["stage_id"])}, audit_it=False)
        changed.append("stage")
    if "collaborator_ids" in data:
        o.collaborators.set(access.resolve_members(actor, data["collaborator_ids"], field_name="collaborator_ids"))
        changed.append("collaborators")
    if "contact_ids" in data:
        _set_contacts(actor, o, data["contact_ids"])
        changed.append("contacts")
    access.audit_write(request, actor, "update", o, fields=changed)
    return o


MOVE_SPEC = {"stage_id": F.uuid(required=True), "index": F.integer(min_value=0, max_value=100_000, null=True, default=None)}


@transaction.atomic
def move_opportunity(request, actor: Actor, o: m.Opportunity, body: dict, *, audit_it: bool = True) -> m.Opportunity:
    """Moves ``o`` to ``stage_id`` (same pipeline) at ``index`` (0 = top; default bottom).
    A stage change is recorded in the stage history and the timeline."""
    data = validate(body, MOVE_SPEC)
    target = access.resolve_one(actor, m.Stage, data["stage_id"], field_name="stage_id")
    if target.pipeline_id != o.pipeline_id:
        raise ValidationFailed(fields={"stage_id": ["The stage belongs to another pipeline."]})
    previous = o.stage
    siblings = list(m.Opportunity.objects.select_for_update().filter(stage=target).exclude(pk=o.pk).order_by("position", "-updated_at"))
    index = len(siblings) if data["index"] is None else min(data["index"], len(siblings))
    ordered = siblings[:index] + [o] + siblings[index:]
    for i, row in enumerate(ordered):
        new_pos = float((i + 1) * 1024)
        if row.pk == o.pk:
            o.position = new_pos
        elif row.position != new_pos:
            m.Opportunity.objects.filter(pk=row.pk).update(position=new_pos)
    o.stage = target
    if previous.pk != target.pk:
        o.stage_entered_at = timezone.now()
        _apply_status(o)
    o.save()
    if previous.pk != target.pk:
        m.StageHistory.objects.create(workspace=actor.workspace, opportunity=o, from_stage=previous, to_stage=target,
                                      from_name=previous.name, to_name=target.name, created_by=actor.user)
        m.Activity.objects.create(
            workspace=actor.workspace, opportunity=o, kind=m.Activity.Kind.STAGE_CHANGE, source=m.Activity.Source.SYSTEM,
            actor=actor.user, created_by=actor.user, summary=f"Moved from {previous.name} to {target.name}",
            metadata={"from_stage_id": str(previous.pk), "to_stage_id": str(target.pk)},
        )
    if audit_it:
        access.audit_write(request, actor, "move", o, fields=["stage", "position"])
    return o


# --- tasks --------------------------------------------------------------------------------------

TASK_SPEC = {
    "title": F.string(max_length=200, required=True, blank=False),
    "description": F.string(max_length=5000, multiline=True),
    "assignee_id": F.uuid(null=True),
    "due_at": F.datetime(null=True, default=None),
    "priority": F.choice(m.Priority.values, default=m.Priority.NORMAL),
    "status": F.choice(m.Task.Status.values, default=m.Task.Status.OPEN),
    "contact_id": F.uuid(null=True, default=None),
    "opportunity_id": F.uuid(null=True, default=None),
    "related": F.object(max_keys=2, null=True, default=None),
    # Clients may only say "manual" or "ai_suggestion_confirmed" (a person confirmed an AI
    # suggestion); automation/integration tasks are created server-side.
    "source": F.choice([m.Task.Source.MANUAL, m.Task.Source.AI_SUGGESTION_CONFIRMED], default=m.Task.Source.MANUAL),
    "visibility": F.choice(m.Visibility.values, default=m.Visibility.TEAM),
}


def _related(actor: Actor, raw: dict | None) -> tuple[str, Any]:
    if not raw:
        return "", None
    obj = access.resolve_ref(actor, str(raw.get("type", "")), raw.get("id"), field_name="related")
    return obj._meta.label_lower, obj.pk


def _task_assignee(actor: Actor, data: dict, body: dict, current=None):
    if "assignee_id" in body:
        assignee = access.resolve_member(actor, data["assignee_id"], field_name="assignee_id")
    else:
        assignee = current if current is not None else actor.user
    if not actor.can(Cap.TASKS_CREATE) and not actor.can(Cap.RECORDS_CHANGE_ALL) and assignee != actor.user:
        raise PermissionDenied("Your role can only assign tasks to yourself.")
    return assignee


def _task_status(t: m.Task, status: str, actor: Actor) -> bool:
    """Sets the status (and completion stamp); True if it changed."""
    if status == t.status:
        return False
    t.status = status
    if status == m.Task.Status.DONE:
        t.completed_at, t.completed_by = timezone.now(), actor.user
    else:
        t.completed_at, t.completed_by = None, None
    return True


def _task_event(actor: Actor, t: m.Task, summary: str) -> None:
    if t.contact_id or t.opportunity_id:
        m.Activity.objects.create(
            workspace=actor.workspace, kind=m.Activity.Kind.TASK_EVENT, source=m.Activity.Source.SYSTEM, actor=actor.user,
            created_by=actor.user, summary=summary[:300], contact_id=t.contact_id, opportunity_id=t.opportunity_id, task=t,
            metadata={"task_id": str(t.pk), "status": t.status},
        )


def create_task(request, actor: Actor, body: dict) -> m.Task:
    if not (actor.can(Cap.TASKS_CREATE) or actor.can(Cap.TASKS_CREATE_OWN)):
        raise PermissionDenied("Your role can't create tasks.")
    data = validate(body, TASK_SPEC)
    t = m.Task(workspace=actor.workspace, created_by=actor.user, title=data["title"], description=data["description"],
               due_at=data["due_at"], priority=data["priority"], source=data["source"], visibility=data["visibility"])
    t.assignee = _task_assignee(actor, data, body)
    t.contact = access.resolve_one(actor, m.Contact, data["contact_id"], field_name="contact_id")
    t.opportunity = access.resolve_one(actor, m.Opportunity, data["opportunity_id"], field_name="opportunity_id")
    t.related_type, t.related_id = _related(actor, data["related"])
    _task_status(t, data["status"], actor)
    t.save()
    _task_event(actor, t, f"Task created: {t.title}")
    access.audit_write(request, actor, "create", t, fields=list(body))
    return t


def update_task(request, actor: Actor, t: m.Task, body: dict) -> m.Task:
    spec = dict(TASK_SPEC)
    spec["title"] = F.string(max_length=200, blank=False)
    spec.pop("source")
    data = validate(body, spec, partial=True)
    changed: list[str] = []
    _set(t, data, ["title", "description", "due_at", "priority", "visibility"], changed)
    if "assignee_id" in data:
        assignee = _task_assignee(actor, data, body, t.assignee)
        if assignee != t.assignee:
            t.assignee = assignee
            changed.append("assignee")
    if "contact_id" in data:
        t.contact = access.resolve_one(actor, m.Contact, data["contact_id"], field_name="contact_id")
        changed.append("contact")
    if "opportunity_id" in data:
        t.opportunity = access.resolve_one(actor, m.Opportunity, data["opportunity_id"], field_name="opportunity_id")
        changed.append("opportunity")
    if "related" in data:
        t.related_type, t.related_id = _related(actor, data["related"])
        changed.append("related")
    status_event = False
    if "status" in data:
        status_event = _task_status(t, data["status"], actor)
        if status_event:
            changed.append("status")
    t.save()
    if status_event:
        _task_event(actor, t, f"Task {'completed' if t.status == m.Task.Status.DONE else t.get_status_display().lower()}: {t.title}")
    access.audit_write(request, actor, "update", t, fields=changed)
    return t


# --- activities -----------------------------------------------------------------------------------

ACTIVITY_SPEC = {
    "kind": F.choice([m.Activity.Kind.NOTE, m.Activity.Kind.CALL, m.Activity.Kind.MEETING, m.Activity.Kind.MESSAGE_LINK], required=True),
    "summary": F.string(max_length=300, required=True, blank=False),
    "body": F.string(max_length=20000, multiline=True),
    "occurred_at": F.datetime(null=True, default=None),
    "contact_id": F.uuid(null=True, default=None),
    "opportunity_id": F.uuid(null=True, default=None),
    "task_id": F.uuid(null=True, default=None),
    "related": F.object(max_keys=2, null=True, default=None),
    "room_id": room_field(),
    "event_id": event_field(),
}


def _touch_contact(contact_id, when) -> None:
    if contact_id:
        m.Contact.objects.filter(pk=contact_id).filter(Q(last_activity_at__isnull=True) | Q(last_activity_at__lt=when)).update(
            last_activity_at=when
        )


def create_activity(request, actor: Actor, body: dict) -> m.Activity:
    access.require(actor, Cap.ACTIVITIES_CREATE)
    data = validate(body, ACTIVITY_SPEC)
    a = m.Activity(workspace=actor.workspace, created_by=actor.user, actor=actor.user, kind=data["kind"], summary=data["summary"],
                   body=data["body"], occurred_at=data["occurred_at"] or timezone.now(), source=m.Activity.Source.NATIVE,
                   untrusted=False, room_id=data["room_id"], event_id=data["event_id"])
    a.contact = access.resolve_one(actor, m.Contact, data["contact_id"], field_name="contact_id")
    a.opportunity = access.resolve_one(actor, m.Opportunity, data["opportunity_id"], field_name="opportunity_id")
    a.task = access.resolve_one(actor, m.Task, data["task_id"], field_name="task_id")
    a.related_type, a.related_id = _related(actor, data["related"])
    if not (a.contact or a.opportunity or a.task or a.related_id):
        raise ValidationFailed(fields={"contact_id": ["Attach the entry to a contact, opportunity, task or record."]})
    if a.kind == m.Activity.Kind.MESSAGE_LINK and not a.room_id:
        raise ValidationFailed(fields={"room_id": ["A linked chat message needs its room ID."]})
    a.save()
    _touch_contact(a.contact_id, a.occurred_at)
    access.audit_write(request, actor, "create", a, fields=list(body))
    return a


def update_activity(request, actor: Actor, a: m.Activity, body: dict) -> m.Activity:
    spec = {k: ACTIVITY_SPEC[k] for k in ("summary", "body", "occurred_at")}
    spec["summary"] = F.string(max_length=300, blank=False)
    data = validate(body, spec, partial=True)
    if data.get("occurred_at") is None:
        data.pop("occurred_at", None)
    changed: list[str] = []
    _set(a, data, list(data), changed)
    a.save()
    access.audit_write(request, actor, "update", a, fields=changed)
    return a


def record_external_activity(workspace, *, provider: str, kind: str, summary: str, body: str = "", external_ref: str = "",
                             occurred_at=None, contact=None, opportunity=None, metadata: dict | None = None) -> m.Activity:
    """Server-side helper for integrations: always marked ``untrusted`` and never attributed
    to a person. The caller has already checked the workspace connection."""
    if provider not in m.Activity.Source.values or provider in {m.Activity.Source.NATIVE, m.Activity.Source.SYSTEM}:
        raise ValueError(f"unknown provider {provider!r}")
    for obj in (contact, opportunity):
        if obj is not None and obj.workspace_id != workspace.pk:
            raise ValueError("record of another workspace")
    a = m.Activity.objects.create(workspace=workspace, kind=kind, source=provider, summary=summary[:300], body=body[:20000],
                                  external_ref=external_ref[:255], occurred_at=occurred_at or timezone.now(), contact=contact,
                                  opportunity=opportunity, untrusted=True, metadata=metadata or {})
    _touch_contact(a.contact_id, a.occurred_at)
    return a


# --- calendar events ----------------------------------------------------------------------------

EVENT_SPEC = {
    "title": F.string(max_length=200, required=True, blank=False),
    "description": F.string(max_length=5000, multiline=True),
    "start_at": F.datetime(required=True),
    "end_at": F.datetime(required=True),
    "all_day": F.boolean(default=False),
    "location": F.string(max_length=200),
    "organizer_id": F.uuid(null=True),
    "attendee_user_ids": F.list(F.uuid(), max_items=50),
    "attendee_contact_ids": F.list(F.uuid(), max_items=50),
    "matrix_room_id": room_field(),
    "contact_id": F.uuid(null=True, default=None),
    "opportunity_id": F.uuid(null=True, default=None),
    "related": F.object(max_keys=2, null=True, default=None),
    "status": F.choice(m.CalendarEvent.Status.values, default=m.CalendarEvent.Status.SCHEDULED),
    "visibility": F.choice(m.Visibility.values, default=m.Visibility.TEAM),
}


def _check_times(e: m.CalendarEvent) -> None:
    if e.end_at < e.start_at:
        raise ValidationFailed(fields={"end_at": ["The end must not be before the start."]})


def _organizer(actor: Actor, data: dict, body: dict, current=None):
    if "organizer_id" in body:
        organizer = access.resolve_member(actor, data["organizer_id"], field_name="organizer_id")
    else:
        organizer = current if current is not None else actor.user
    if organizer != actor.user and not actor.can(Cap.RECORDS_CHANGE_ALL):
        raise PermissionDenied("Only managers can organise events for someone else.")
    return organizer


def create_event(request, actor: Actor, body: dict) -> m.CalendarEvent:
    access.require(actor, Cap.EVENTS_CREATE)
    data = validate(body, EVENT_SPEC)
    e = m.CalendarEvent(workspace=actor.workspace, created_by=actor.user, title=data["title"], description=data["description"],
                        start_at=data["start_at"], end_at=data["end_at"], all_day=data["all_day"], location=data["location"],
                        matrix_room_id=data["matrix_room_id"], status=data["status"], visibility=data["visibility"])
    e.organizer = _organizer(actor, data, body)
    e.contact = access.resolve_one(actor, m.Contact, data["contact_id"], field_name="contact_id")
    e.opportunity = access.resolve_one(actor, m.Opportunity, data["opportunity_id"], field_name="opportunity_id")
    e.related_type, e.related_id = _related(actor, data["related"])
    _check_times(e)
    e.save()
    e.attendee_users.set(access.resolve_members(actor, data["attendee_user_ids"], field_name="attendee_user_ids"))
    e.attendee_contacts.set(access.resolve(actor, m.Contact, data["attendee_contact_ids"], field_name="attendee_contact_ids"))
    access.audit_write(request, actor, "create", e, fields=list(body))
    return e


def update_event(request, actor: Actor, e: m.CalendarEvent, body: dict) -> m.CalendarEvent:
    spec = dict(EVENT_SPEC)
    spec["title"] = F.string(max_length=200, blank=False)
    spec["start_at"], spec["end_at"] = F.datetime(), F.datetime()
    data = validate(body, spec, partial=True)
    changed: list[str] = []
    _set(e, data, ["title", "description", "start_at", "end_at", "all_day", "location", "matrix_room_id", "status", "visibility"], changed)
    if "organizer_id" in data:
        e.organizer = _organizer(actor, data, body, e.organizer)
        changed.append("organizer")
    if "contact_id" in data:
        e.contact = access.resolve_one(actor, m.Contact, data["contact_id"], field_name="contact_id")
        changed.append("contact")
    if "opportunity_id" in data:
        e.opportunity = access.resolve_one(actor, m.Opportunity, data["opportunity_id"], field_name="opportunity_id")
        changed.append("opportunity")
    if "related" in data:
        e.related_type, e.related_id = _related(actor, data["related"])
        changed.append("related")
    _check_times(e)
    e.save()
    if "attendee_user_ids" in data:
        e.attendee_users.set(access.resolve_members(actor, data["attendee_user_ids"], field_name="attendee_user_ids"))
        changed.append("attendee_users")
    if "attendee_contact_ids" in data:
        e.attendee_contacts.set(access.resolve(actor, m.Contact, data["attendee_contact_ids"], field_name="attendee_contact_ids"))
        changed.append("attendee_contacts")
    access.audit_write(request, actor, "update", e, fields=changed)
    return e


# --- conversation links -----------------------------------------------------------------------------

LINK_SPEC = {
    "room_id": room_field(required=True, blank=False),
    "event_id": event_field(),
    "contact_id": F.uuid(null=True, default=None),
    "opportunity_id": F.uuid(null=True, default=None),
}


def create_conversation_link(request, actor: Actor, body: dict) -> m.ConversationLink:
    access.require(actor, Cap.ACTIVITIES_CREATE)
    data = validate(body, LINK_SPEC)
    if bool(data["contact_id"]) == bool(data["opportunity_id"]):
        raise ValidationFailed(fields={"contact_id": ["Link the conversation to one contact or one opportunity."]})
    contact = access.resolve_one(actor, m.Contact, data["contact_id"], field_name="contact_id")
    opp = access.resolve_one(actor, m.Opportunity, data["opportunity_id"], field_name="opportunity_id")
    existing = m.ConversationLink.objects.filter(workspace_id=actor.workspace_id, room_id=data["room_id"], contact=contact, opportunity=opp).first()
    if existing:
        return existing
    link = m.ConversationLink.objects.create(workspace=actor.workspace, created_by=actor.user, room_id=data["room_id"],
                                             event_id=data["event_id"], contact=contact, opportunity=opp)
    m.Activity.objects.create(
        workspace=actor.workspace, kind=m.Activity.Kind.MESSAGE_LINK, source=m.Activity.Source.NATIVE, actor=actor.user,
        created_by=actor.user, summary="Linked a conversation", room_id=link.room_id, event_id=link.event_id,
        contact=contact, opportunity=opp,
    )
    access.audit_write(request, actor, "create", link)
    return link


# --- workspace business settings -------------------------------------------------------------------

ORG_SPEC = {
    "business_profiles": F.list(F.choice(m.BusinessProfile.values), max_items=3),
    "default_currency": currency_field(),
    "save_to_record_enabled": F.boolean(),
}


def org_settings(workspace) -> m.OrgSettings:
    org, _ = m.OrgSettings.objects.get_or_create(workspace=workspace)
    return org


def update_org_settings(request, actor: Actor, body: dict) -> m.OrgSettings:
    access.require(actor, Cap.ORG_SETTINGS, "Only the workspace owner and admins can change business settings.")
    data = validate(body, ORG_SPEC, partial=True)
    org = org_settings(actor.workspace)
    from apps.billing.services import workspace_plan

    plan = workspace_plan(actor.workspace)
    changed: list[str] = []
    if "business_profiles" in data:
        profiles = data["business_profiles"]
        if profiles and not plan.entitlement("crm_enabled"):
            raise PlanLimit(f"The {plan.name} plan doesn't include the business workspace.")
        if {"real_estate", "lending"} & set(profiles) and not plan.entitlement("vertical_profiles"):
            raise PlanLimit(f"The {plan.name} plan doesn't include the real-estate and lending profiles.")
        if profiles != org.business_profiles:
            org.business_profiles = profiles
            changed.append("business_profiles")
            for profile in profiles:
                kind = PROFILE_PIPELINE[profile]
                if not m.Pipeline.objects.filter(workspace=actor.workspace, kind=kind).exists():
                    create_default_pipeline(actor.workspace, kind, user=actor.user, currency=org.default_currency)
    _set(org, data, ["default_currency", "save_to_record_enabled"], changed)
    org.updated_by = actor.user
    org.save()
    from apps.core.audit import audit

    audit(request, "crm.orgsettings.update", target_type="workspace", target_id=str(actor.workspace_id), actor=actor.user,
          metadata={"workspace": str(actor.workspace_id), "fields": sorted(changed)})
    return org


def ensure_actor_can(actor: Actor, model, obj, action: str) -> None:
    """For callers holding an object already: re-check ``action`` through the policy."""
    if action not in (CHANGE, DELETE):
        return
    if not access.for_actor(actor, model, action).filter(pk=obj.pk).exists():
        raise PermissionDenied("You can view this record but not change it.")
