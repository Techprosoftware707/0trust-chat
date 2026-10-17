"""Lending services: applications through a lending pipeline, borrowers, internal notes,
document checklists (with templates per product), "Request document", encrypted documents with
short-lived single-use download tokens, the document access log, and staff decisions.

Access (``policies_verticals.py``): owners, admins and managers see every application
(``Cap.LENDING_SENSITIVE``); an agent / broker sees only applications assigned to them
(``loan_officer``). Team members and read-only people see none. Decisions are recorded by
owners, admins and managers only (``Cap.LENDING_DECIDE``): **nothing in Nexus approves or
rejects automatically**, and no automation action can record one.

Sending a document request to the borrower is NOT possible yet (no outbound email or portal
for borrowers in this phase): "Request document" creates an internal task and marks the
checklist item requested, and the UI says so.
"""

from __future__ import annotations

import datetime as dt
import re
import uuid

from django.conf import settings
from django.core import signing
from django.core.exceptions import PermissionDenied
from django.db import IntegrityError, transaction
from django.db.models import Count, Max, Q
from django.http import Http404
from django.utils import timezone

from apps.api.errors import Conflict, PermissionDeniedError, ValidationFailed
from apps.api.schema import F, validate
from apps.core.audit import audit

from . import access, documents, services
from . import models as m
from .access import CHANGE, VIEW, Actor, Cap

TOKEN_SALT = "nexus.document-download.v1"

# --- checklist templates -----------------------------------------------------------------------------

DEFAULT_TEMPLATES = [
    ("Purchase mortgage", "purchase", [
        ("Government-issued photo ID", True, 3), ("Pay stubs (last 30 days)", True, 7), ("W-2s (last 2 years)", True, 7),
        ("Bank statements (last 2 months)", True, 7), ("Signed purchase agreement", True, 10), ("Gift letter", False, 10),
        ("Homeowner's insurance quote", True, 21),
    ]),
    ("Refinance", "refinance", [
        ("Government-issued photo ID", True, 3), ("Pay stubs (last 30 days)", True, 7), ("Current mortgage statement", True, 7),
        ("Homeowner's insurance declaration", True, 10), ("Bank statements (last 2 months)", True, 7),
    ]),
    ("Cash-out refinance", "cash_out_refinance", [
        ("Government-issued photo ID", True, 3), ("Pay stubs (last 30 days)", True, 7), ("Current mortgage statement", True, 7),
        ("Tax returns (last 2 years)", True, 10), ("Purpose of funds statement", False, 10),
    ]),
    ("General loan", "", [
        ("Government-issued photo ID", True, 3), ("Proof of income", True, 7), ("Bank statements (last 2 months)", True, 7),
    ]),
]


def ensure_default_templates(workspace, user=None, *, is_demo: bool = False) -> int:
    """Creates the default checklist templates once per workspace (editable afterwards)."""
    if m.ChecklistTemplate.objects.filter(workspace=workspace).exists():
        return 0
    for name, product, items in DEFAULT_TEMPLATES:
        m.ChecklistTemplate.objects.create(
            workspace=workspace, name=name, product_type=product, created_by=user, is_demo=is_demo,
            items=[{"name": n, "required": r, "description": "", "due_in_days": d} for n, r, d in items],
        )
    return len(DEFAULT_TEMPLATES)


TEMPLATE_ITEM = F.object(max_keys=4)
TEMPLATE_SPEC = {
    "name": F.string(max_length=120, required=True, blank=False),
    "product_type": F.choice([""] + m.LendingApplication.ProductType.values, default=""),
    "items": F.list(TEMPLATE_ITEM, max_items=60, unique=False),
    "archived": F.boolean(default=False),
}


def _clean_template_items(items: list) -> list:
    out = []
    for i, it in enumerate(items):
        name = str(it.get("name", "")).strip()[:160]
        if not name:
            raise ValidationFailed(fields={f"items.{i}.name": ["Each item needs a name."]})
        days = it.get("due_in_days")
        if days is not None and (isinstance(days, bool) or not isinstance(days, int) or not 0 <= days <= 365):
            raise ValidationFailed(fields={f"items.{i}.due_in_days": ["Between 0 and 365 days."]})
        out.append({"name": name, "required": bool(it.get("required", True)), "description": str(it.get("description", ""))[:500],
                    "due_in_days": days})
    return out


def create_template(request, actor: Actor, body: dict) -> m.ChecklistTemplate:
    access.require(actor, Cap.CRM_CONFIGURE)
    data = validate(body, TEMPLATE_SPEC)
    if m.ChecklistTemplate.objects.filter(workspace=actor.workspace, name__iexact=data["name"]).exists():
        raise Conflict("A template with that name exists already.")
    t = m.ChecklistTemplate.objects.create(workspace=actor.workspace, created_by=actor.user, name=data["name"],
                                           product_type=data["product_type"], items=_clean_template_items(data["items"]),
                                           archived=data["archived"])
    access.audit_write(request, actor, "create", t, fields=list(body))
    return t


def update_template(request, actor: Actor, t: m.ChecklistTemplate, body: dict) -> m.ChecklistTemplate:
    spec = dict(TEMPLATE_SPEC)
    spec["name"] = F.string(max_length=120, blank=False)
    data = validate(body, spec, partial=True)
    if "items" in data:
        data["items"] = _clean_template_items(data["items"])
    changed: list[str] = []
    services._set(t, data, ["name", "product_type", "items", "archived"], changed)
    t.save()
    access.audit_write(request, actor, "update", t, fields=changed)
    return t


def template_for(workspace_id, product_type: str) -> m.ChecklistTemplate | None:
    qs = m.ChecklistTemplate.objects.filter(workspace_id=workspace_id, archived=False)
    return qs.filter(product_type=product_type).order_by("created_at").first() or qs.filter(product_type="").order_by("created_at").first()


def _add_items_from_template(actor: Actor, app: m.LendingApplication, template: m.ChecklistTemplate) -> list[m.DocumentChecklistItem]:
    existing = {n.lower() for n in app.checklist.values_list("name", flat=True)}
    pos = (app.checklist.aggregate(p=Max("position"))["p"] or 0)
    today = timezone.localdate()
    created = []
    for it in template.items or []:
        if it["name"].lower() in existing:
            continue
        pos += 10
        due = today + dt.timedelta(days=it["due_in_days"]) if it.get("due_in_days") is not None else None
        created.append(m.DocumentChecklistItem.objects.create(
            workspace=actor.workspace, application=app, name=it["name"], description=it.get("description", ""),
            required=it.get("required", True), due_date=due, position=pos, created_by=actor.user, is_demo=app.is_demo,
        ))
    return created


# --- applications ---------------------------------------------------------------------------------------

BORROWER = F.object(max_keys=2)
APPLICATION_SPEC = {
    "title": F.string(max_length=160, required=True, blank=False),
    "pipeline_id": F.uuid(null=True, default=None),
    "stage_id": F.uuid(null=True, default=None),
    "borrowers": F.list(BORROWER, max_items=6, unique=False),
    "loan_officer_id": F.uuid(null=True),
    "product_type": F.choice(m.LendingApplication.ProductType.values, default=m.LendingApplication.ProductType.PURCHASE),
    "amount_requested": F.decimal(max_digits=14, decimal_places=2, null=True, default=None),
    "currency": services.currency_field(default="USD"),
    "status": F.choice(m.LendingApplication.Status.values, default=m.LendingApplication.Status.ACTIVE),
    "opportunity_id": F.uuid(null=True, default=None),
    "property_id": F.uuid(null=True, default=None),
    "target_close_date": F.date(null=True, default=None),
    "source": F.string(max_length=60),
    "apply_template": F.boolean(default=True),
}


def lending_pipelines(actor: Actor):
    return access.for_actor(actor, m.Pipeline).filter(kind=m.Pipeline.Kind.LENDING, archived=False).order_by("-is_default", "position")


def _pipeline(actor: Actor, pipeline_id) -> m.Pipeline:
    if pipeline_id:
        p = access.resolve_one(actor, m.Pipeline, str(pipeline_id), field_name="pipeline_id")
        if p.kind != m.Pipeline.Kind.LENDING:
            raise ValidationFailed(fields={"pipeline_id": ["Choose a lending pipeline."]})
        return p
    p = lending_pipelines(actor).first()
    if p is None:
        p = services.create_default_pipeline(actor.workspace, m.Pipeline.Kind.LENDING, user=actor.user)
    return p


def _next_reference(workspace) -> str:
    last = m.LendingApplication.objects.filter(workspace=workspace, reference__regex=r"^APP-\d+$").values_list("reference", flat=True)
    n = max((int(r[4:]) for r in last), default=0)
    return f"APP-{n + 1:04d}"


def _set_borrowers(actor: Actor, app: m.LendingApplication, borrowers: list) -> None:
    roles = m.ApplicationBorrower.Role.values
    wanted: list[tuple[m.Contact, str]] = []
    ids = []
    for i, b in enumerate(borrowers):
        role = b.get("role") or ("borrower" if i == 0 else "co_borrower")
        if role not in roles:
            raise ValidationFailed(fields={f"borrowers.{i}.role": [f"Choose one of: {', '.join(roles)}."]})
        ids.append(b.get("contact_id"))
        wanted.append((None, role))
    contacts = access.resolve(actor, m.Contact, ids, field_name="borrowers")
    wanted = [(c, r) for c, (_, r) in zip(contacts, wanted)]
    keep = {c.pk for c, _ in wanted}
    m.ApplicationBorrower.objects.filter(application=app).exclude(contact_id__in=keep).delete()
    for c, role in wanted:
        link, created = m.ApplicationBorrower.objects.get_or_create(
            workspace=actor.workspace, application=app, contact=c, defaults={"role": role, "created_by": actor.user, "is_demo": app.is_demo}
        )
        if not created and link.role != role:
            link.role = role
            link.save(update_fields=["role", "updated_at"])


def _loan_officer(actor: Actor, data: dict, body: dict, current=None):
    if "loan_officer_id" in body:
        officer = access.resolve_member(actor, data["loan_officer_id"], field_name="loan_officer_id") if data["loan_officer_id"] else None
    else:
        officer = current if current is not None else actor.user
    if officer != (current if current is not None else actor.user) and not actor.can(Cap.LENDING_SENSITIVE):
        raise PermissionDenied("Only owners, admins and managers can assign an application to another broker.")
    if officer is not None:
        officer_actor = access.actor_for(officer, actor.workspace_id)
        if not officer_actor.can(Cap.LENDING_ACCESS):
            raise ValidationFailed(fields={"loan_officer_id": ["This person's role can't work on lending applications."]})
    return officer


@transaction.atomic
def create_application(request, actor: Actor, body: dict) -> m.LendingApplication:
    """A new application in a lending pipeline (default: the workspace's lending pipeline,
    first stage). The checklist template for the product is applied unless
    ``apply_template`` is false."""
    access.require(actor, Cap.LENDING_ACCESS, "Your role doesn't work on lending applications.")
    data = validate(body, APPLICATION_SPEC)
    pipeline = _pipeline(actor, data["pipeline_id"])
    if data["stage_id"]:
        stage = access.resolve_one(actor, m.Stage, str(data["stage_id"]), field_name="stage_id")
        if stage.pipeline_id != pipeline.pk:
            raise ValidationFailed(fields={"stage_id": ["The stage belongs to another pipeline."]})
    else:
        stage = pipeline.stages.order_by("position", "created_at").first()
    app = m.LendingApplication(
        workspace=actor.workspace, created_by=actor.user, title=data["title"], pipeline=pipeline, stage=stage,
        product_type=data["product_type"], amount_requested=data["amount_requested"], currency=data["currency"],
        status=data["status"], target_close_date=data["target_close_date"], source=data["source"],
    )
    app.loan_officer = _loan_officer(actor, data, body)
    app.opportunity = access.resolve_one(actor, m.Opportunity, data["opportunity_id"], field_name="opportunity_id") if data["opportunity_id"] else None
    app.property = access.resolve_one(actor, m.Property, data["property_id"], field_name="property_id") if data["property_id"] else None
    app.position = (m.LendingApplication.objects.filter(stage=stage).aggregate(p=Max("position"))["p"] or 0) + 1024
    for _ in range(5):
        app.reference = _next_reference(actor.workspace)
        try:
            with transaction.atomic():
                app.save()
            break
        except IntegrityError:
            app.pk = uuid.uuid4()
    else:  # pragma: no cover - five concurrent creations in a row
        raise Conflict("Try again: another application was created at the same moment.")
    _set_borrowers(actor, app, data["borrowers"])
    m.LendingStageHistory.objects.create(workspace=actor.workspace, application=app, to_stage=stage, to_name=stage.name, created_by=actor.user)
    if data["apply_template"]:
        ensure_default_templates(actor.workspace, actor.user)
        tpl = template_for(actor.workspace_id, app.product_type)
        if tpl is not None:
            _add_items_from_template(actor, app, tpl)
    access.audit_write(request, actor, "create", app, fields=list(body))
    return app


def update_application(request, actor: Actor, app: m.LendingApplication, body: dict) -> m.LendingApplication:
    """Changes an application (the caller checked CHANGE). Stage changes go through
    ``move_application``; decisions through ``record_decision`` only."""
    spec = {k: v for k, v in APPLICATION_SPEC.items() if k not in {"pipeline_id", "apply_template"}}
    spec["title"] = F.string(max_length=160, blank=False)
    spec["currency"] = services.currency_field()
    data = validate(body, spec, partial=True)
    changed: list[str] = []
    services._set(app, data, ["title", "product_type", "amount_requested", "currency", "status", "target_close_date", "source"], changed)
    if "loan_officer_id" in data:
        officer = _loan_officer(actor, data, body, app.loan_officer)
        if officer != app.loan_officer:
            app.loan_officer = officer
            changed.append("loan_officer")
    for key, model in (("opportunity_id", m.Opportunity), ("property_id", m.Property)):
        if key in data:
            setattr(app, key[:-3], access.resolve_one(actor, model, str(data[key]), field_name=key) if data[key] else None)
            changed.append(key[:-3])
    app.save()
    if "borrowers" in data:
        _set_borrowers(actor, app, data["borrowers"])
        changed.append("borrowers")
    if data.get("stage_id") and data["stage_id"] != app.stage_id:
        move_application(request, actor, app, {"stage_id": str(data["stage_id"])}, audit_it=False)
        changed.append("stage")
    access.audit_write(request, actor, "update", app, fields=changed)
    return app


MOVE_SPEC = {"stage_id": F.uuid(required=True), "index": F.integer(min_value=0, max_value=100_000, null=True, default=None)}


@transaction.atomic
def move_application(request, actor: Actor, app: m.LendingApplication, body: dict, *, audit_it: bool = True) -> m.LendingApplication:
    """Moves an application to another stage of its pipeline (at ``index``, default bottom).
    Recorded in the application's stage history. A stage is never a decision."""
    services.ensure_actor_can(actor, m.LendingApplication, app, CHANGE)
    data = validate(body, MOVE_SPEC)
    target = access.resolve_one(actor, m.Stage, str(data["stage_id"]), field_name="stage_id")
    if target.pipeline_id != app.pipeline_id:
        raise ValidationFailed(fields={"stage_id": ["The stage belongs to another pipeline."]})
    previous = app.stage
    siblings = list(m.LendingApplication.objects.select_for_update().filter(stage=target).exclude(pk=app.pk).order_by("position", "-updated_at"))
    index = len(siblings) if data["index"] is None else min(data["index"], len(siblings))
    ordered = siblings[:index] + [app] + siblings[index:]
    for i, row in enumerate(ordered):
        pos = float((i + 1) * 1024)
        if row.pk == app.pk:
            app.position = pos
        elif row.position != pos:
            m.LendingApplication.objects.filter(pk=row.pk).update(position=pos)
    app.stage = target
    if previous.pk != target.pk:
        app.stage_entered_at = timezone.now()
    app.save()
    if previous.pk != target.pk:
        m.LendingStageHistory.objects.create(workspace=actor.workspace, application=app, from_stage=previous, to_stage=target,
                                             from_name=previous.name, to_name=target.name, created_by=actor.user)
    if audit_it:
        access.audit_write(request, actor, "move", app, fields=["stage", "position"])
    return app


DECISION_SPEC = {
    "decision": F.choice(m.LendingApplication.Decision.values, required=True),
    "note": F.string(max_length=2000, multiline=True),
    "confirm": F.boolean(required=True),
}


def record_decision(request, actor: Actor, app: m.LendingApplication, body: dict) -> m.LendingApplication:
    """Records a decision made by an authorised person (owner, admin, manager). Requires
    ``confirm: true``; an empty decision clears it. Never called by automations."""
    access.require(actor, Cap.LENDING_DECIDE, "Only owners, admins and managers record lending decisions.")
    services.ensure_actor_can(actor, m.LendingApplication, app, CHANGE)
    data = validate(body, DECISION_SPEC)
    if not data["confirm"]:
        raise ValidationFailed(fields={"confirm": ["Confirm that an authorised person made this decision."]})
    app.decision = data["decision"]
    app.decision_note = data["note"]
    app.decision_by = actor.user if app.decision else None
    app.decision_at = timezone.now() if app.decision else None
    app.save(update_fields=["decision", "decision_note", "decision_by", "decision_at", "updated_at"])
    access.audit_write(request, actor, "decision", app, fields=["decision", "decision_note"])
    return app


def search_applications(actor: Actor, *, q: str = "", stage=None, status: str = "", officer=None, missing_documents: bool = False,
                        pipeline=None):
    """Applications the actor may see (sensitive: managers and the assigned broker only)."""
    qs = access.for_actor(actor, m.LendingApplication)
    for term in (q or "").split()[:5]:
        qs = qs.filter(Q(title__icontains=term) | Q(reference__icontains=term) | Q(borrowers__first_name__icontains=term)
                       | Q(borrowers__last_name__icontains=term)).distinct()
    if pipeline is not None:
        qs = qs.filter(pipeline=pipeline)
    if stage is not None:
        qs = qs.filter(stage=stage)
    if status:
        qs = qs.filter(status=status)
    if officer is not None:
        qs = qs.filter(loan_officer=officer)
    if missing_documents:
        qs = qs.filter(pk__in=outstanding_items().values("application_id"))
    return qs


def outstanding_items():
    return m.DocumentChecklistItem.objects.filter(required=True, status__in=m.DocumentChecklistItem.OUTSTANDING)


def checklist_progress(app: m.LendingApplication, items=None) -> dict:
    """Counts of the checklist by status, how many required items are still outstanding and
    how many are past due."""
    items = list(items if items is not None else app.checklist.all())
    today = timezone.localdate()
    counts = {s: 0 for s in m.DocumentChecklistItem.Status.values}
    for it in items:
        counts[it.status] += 1
    required = [it for it in items if it.required]
    done = [it for it in required if it.status in (m.DocumentChecklistItem.Status.ACCEPTED, m.DocumentChecklistItem.Status.WAIVED)]
    outstanding = [it for it in items if it.is_outstanding]
    return {
        "total": len(items),
        "required": len(required),
        "complete": len(done),
        "outstanding": len(outstanding),
        "awaiting_review": counts[m.DocumentChecklistItem.Status.RECEIVED],
        "overdue": sum(1 for it in outstanding if it.due_date and it.due_date < today),
        "by_status": counts,
        "percent": round(100 * len(done) / len(required)) if required else 100,
    }


def outstanding_work(actor: Actor, app: m.LendingApplication) -> list[dict]:
    """What still has to happen on an application: missing and rejected documents, documents
    waiting for review, open milestones, open tasks."""
    today = timezone.localdate()
    work = []
    for it in app.checklist.all():
        if it.is_outstanding:
            kind = "rejected_document" if it.status == m.DocumentChecklistItem.Status.REJECTED else "missing_document"
            work.append({"kind": kind, "id": str(it.pk), "title": it.name, "due_date": it.due_date,
                         "overdue": bool(it.due_date and it.due_date < today), "status": it.status})
        elif it.status == m.DocumentChecklistItem.Status.RECEIVED:
            work.append({"kind": "review_document", "id": str(it.pk), "title": it.name, "due_date": it.due_date, "overdue": False,
                         "status": it.status})
    for ms in access.for_actor(actor, m.Milestone).filter(application=app, status=m.Milestone.Status.PENDING).order_by("due_date"):
        work.append({"kind": "milestone", "id": str(ms.pk), "title": ms.title, "due_date": ms.due_date,
                     "overdue": bool(ms.due_date and ms.due_date < today), "status": ms.status})
    tasks = access.for_actor(actor, m.Task).filter(related_type="crm.lendingapplication", related_id=app.pk,
                                                   status__in=[m.Task.Status.OPEN, m.Task.Status.IN_PROGRESS])
    for t in tasks.order_by("due_at")[:50]:
        work.append({"kind": "task", "id": str(t.pk), "title": t.title, "due_date": t.due_at.date() if t.due_at else None,
                     "overdue": bool(t.due_at and t.due_at < timezone.now()), "status": t.status})
    work.sort(key=lambda w: (not w["overdue"], w["due_date"] or dt.date.max))
    return work


def applications_missing_documents(actor: Actor, limit: int = 10) -> list[dict]:
    """Visible applications with required documents still outstanding (for Home)."""
    qs = (search_applications(actor, missing_documents=True).exclude(status__in=["withdrawn", "completed"])
          .annotate(missing=Count("checklist", filter=Q(checklist__required=True, checklist__status__in=m.DocumentChecklistItem.OUTSTANDING)))
          .order_by("-missing", "target_close_date")[:limit])
    return [{"id": str(a.pk), "reference": a.reference, "title": a.title, "missing": a.missing, "stage": a.stage.name,
             "target_close_date": a.target_close_date} for a in qs.select_related("stage")]


# --- notes -------------------------------------------------------------------------------------------------

NOTE_SPEC = {
    "body": F.string(max_length=5000, multiline=True, required=True, blank=False),
    "visibility": F.choice(m.ApplicationNote.Visibility.values, default=m.ApplicationNote.Visibility.STAFF),
}


def create_note(request, actor: Actor, app: m.LendingApplication, body: dict) -> m.ApplicationNote:
    """An internal note (never shown to the borrower). ``managers`` notes are visible to
    owners, admins and managers only; ``private`` ones to the author and them."""
    services.ensure_actor_can(actor, m.LendingApplication, app, CHANGE)
    data = validate(body, NOTE_SPEC)
    if data["visibility"] == m.ApplicationNote.Visibility.MANAGERS and not actor.can(Cap.LENDING_SENSITIVE):
        data["visibility"] = m.ApplicationNote.Visibility.PRIVATE  # they could not read it back otherwise
    note = m.ApplicationNote.objects.create(workspace=actor.workspace, application=app, created_by=actor.user, **data)
    access.audit_write(request, actor, "create", note, fields=list(body))
    return note


def update_note(request, actor: Actor, note: m.ApplicationNote, body: dict) -> m.ApplicationNote:
    spec = dict(NOTE_SPEC)
    spec["body"] = F.string(max_length=5000, multiline=True, blank=False)
    data = validate(body, spec, partial=True)
    if data.get("visibility") == m.ApplicationNote.Visibility.MANAGERS and not actor.can(Cap.LENDING_SENSITIVE):
        raise PermissionDenied("Only managers can write manager-only notes.")
    changed: list[str] = []
    services._set(note, data, ["body", "visibility"], changed)
    note.save()
    access.audit_write(request, actor, "update", note, fields=changed)
    return note


# --- checklist ---------------------------------------------------------------------------------------------

ITEM_SPEC = {
    "name": F.string(max_length=160, required=True, blank=False),
    "description": F.string(max_length=500),
    "required": F.boolean(default=True),
    "status": F.choice(m.DocumentChecklistItem.Status.values, default=m.DocumentChecklistItem.Status.PENDING),
    "due_date": F.date(null=True, default=None),
    "internal_note": F.string(max_length=2000, multiline=True),
}
REVIEW_STATES = {m.DocumentChecklistItem.Status.ACCEPTED, m.DocumentChecklistItem.Status.REJECTED, m.DocumentChecklistItem.Status.WAIVED}


def _apply_item_status(item: m.DocumentChecklistItem, status: str, actor: Actor) -> None:
    if status == item.status:
        return
    now = timezone.now()
    item.status = status
    if status == m.DocumentChecklistItem.Status.REQUESTED:
        item.requested_at, item.requested_by = now, actor.user
    elif status == m.DocumentChecklistItem.Status.RECEIVED:
        item.received_at = item.received_at or now
    if status in REVIEW_STATES:
        item.reviewed_at, item.reviewed_by = now, actor.user
    elif status != m.DocumentChecklistItem.Status.RECEIVED:
        item.reviewed_at, item.reviewed_by = None, None


def add_checklist_item(request, actor: Actor, app: m.LendingApplication, body: dict) -> m.DocumentChecklistItem:
    services.ensure_actor_can(actor, m.LendingApplication, app, CHANGE)
    data = validate(body, ITEM_SPEC)
    status = data.pop("status")
    item = m.DocumentChecklistItem(workspace=actor.workspace, application=app, created_by=actor.user, **data)
    item.position = (app.checklist.aggregate(p=Max("position"))["p"] or 0) + 10
    _apply_item_status(item, status, actor)
    item.save()
    access.audit_write(request, actor, "create", item, fields=list(body))
    return item


def update_checklist_item(request, actor: Actor, item: m.DocumentChecklistItem, body: dict) -> m.DocumentChecklistItem:
    """Changes an item. Accepting, rejecting or waiving stamps the reviewer: a person always
    makes that call (nothing is accepted automatically)."""
    spec = dict(ITEM_SPEC)
    spec["name"] = F.string(max_length=160, blank=False)
    spec["status"] = F.choice(m.DocumentChecklistItem.Status.values)
    data = validate(body, spec, partial=True)
    changed: list[str] = []
    services._set(item, data, ["name", "description", "required", "due_date", "internal_note"], changed)
    if "status" in data and data["status"] != item.status:
        _apply_item_status(item, data["status"], actor)
        changed.append("status")
    item.save()
    access.audit_write(request, actor, "update", item, fields=changed)
    return item


APPLY_TEMPLATE_SPEC = {"template_id": F.uuid(required=True)}


def apply_checklist_template(request, actor: Actor, app: m.LendingApplication, body: dict) -> list[m.DocumentChecklistItem]:
    services.ensure_actor_can(actor, m.LendingApplication, app, CHANGE)
    data = validate(body, APPLY_TEMPLATE_SPEC)
    tpl = access.resolve_one(actor, m.ChecklistTemplate, str(data["template_id"]), field_name="template_id")
    created = _add_items_from_template(actor, app, tpl)
    access.audit_write(request, actor, "checklist", app, fields=["checklist"], extra={"count": len(created)})
    return created


REQUEST_SPEC = {
    "due_date": F.date(null=True, default=None),
    "assignee_id": F.uuid(null=True, default=None),
    "note": F.string(max_length=500),
}


def request_document(request, actor: Actor, item: m.DocumentChecklistItem, body: dict) -> tuple[m.DocumentChecklistItem, m.Task]:
    """"Request document": marks the item requested and creates a private follow-up task for
    the team (the loan officer by default). Nothing is sent to the borrower: there is no
    outbound channel for borrowers in this phase."""
    app = item.application
    services.ensure_actor_can(actor, m.LendingApplication, app, CHANGE)
    data = validate(body, REQUEST_SPEC)
    if item.status in (m.DocumentChecklistItem.Status.ACCEPTED, m.DocumentChecklistItem.Status.WAIVED):
        raise Conflict("This item is complete already.")
    assignee = (access.resolve_member(actor, str(data["assignee_id"]), field_name="assignee_id") if data["assignee_id"]
                else app.loan_officer or actor.user)
    due_date = data["due_date"] or item.due_date or timezone.localdate() + dt.timedelta(days=5)
    due_at = timezone.make_aware(dt.datetime.combine(due_date, dt.time(17, 0)))
    task = services.create_task(request, actor, {
        "title": f"Collect “{item.name}” for {app.reference}"[:200],
        "description": ("Requested document for a lending application. Sending the request to the borrower isn't possible from "
                        "Nexus yet: contact them the usual way." + (f"\n\n{data['note']}" if data["note"] else "")),
        "assignee_id": str(assignee.public_id),
        "due_at": due_at.isoformat(),
        "priority": "high" if item.required else "normal",
        "visibility": "private",
        "related": {"type": "crm.lendingapplication", "id": str(app.pk)},
    })
    _apply_item_status(item, m.DocumentChecklistItem.Status.REQUESTED, actor)
    item.due_date = due_date
    item.task = task
    item.save()
    access.audit_write(request, actor, "request", item, fields=["status", "due_date", "task"])
    return item, task


# --- documents ------------------------------------------------------------------------------------------------


def _log(actor: Actor, app: m.LendingApplication, doc, action: str, reason: str = "") -> None:
    m.DocumentAccessLog.objects.create(workspace=actor.workspace, application=app, document=doc,
                                       document_name=(doc.original_name if doc else "")[:200], user=actor.user, action=action,
                                       reason=reason[:60], created_by=actor.user)


def upload_document(request, actor: Actor, app: m.LendingApplication, *, data: bytes, content_type: str, filename: str,
                    checklist_item: m.DocumentChecklistItem | None = None) -> m.SecureDocument:
    """Checks, encrypts and stores a document for an application (CHANGE on the
    application). Attaching it to a checklist item marks the item received (not accepted:
    a person reviews it)."""
    services.ensure_actor_can(actor, m.LendingApplication, app, CHANGE)
    if checklist_item is not None and checklist_item.application_id != app.pk:
        raise ValidationFailed(fields={"checklist_item": ["Unknown or inaccessible ID."]})
    if not documents.is_configured():
        raise documents.StorageNotConfigured()
    ctype, name = documents.check_upload(content_type, filename, data)
    doc_id = uuid.uuid4()
    sealed = documents.seal(actor.workspace_id, doc_id, data)
    try:
        with transaction.atomic():
            doc = m.SecureDocument.objects.create(
                id=doc_id, workspace=actor.workspace, application=app, checklist_item=checklist_item, original_name=name,
                content_type=ctype, size=len(data), storage_name=sealed.storage_name, key_id=sealed.key_id,
                wrapped_key=sealed.wrapped_key, created_by=actor.user,
            )
            if checklist_item is not None and checklist_item.status in m.DocumentChecklistItem.OUTSTANDING:
                _apply_item_status(checklist_item, m.DocumentChecklistItem.Status.RECEIVED, actor)
                checklist_item.save()
            _log(actor, app, doc, m.DocumentAccessLog.Action.UPLOAD)
            access.audit_write(request, actor, "upload", doc, fields=["content_type", "size"], extra={"application": str(app.pk)})
    except BaseException:
        # Nothing refers to the ciphertext: don't leave it behind.
        documents.remove_sealed(sealed.storage_name)
        raise
    return doc


def delete_document(request, actor: Actor, doc: m.SecureDocument) -> None:
    services.ensure_actor_can(actor, m.SecureDocument, doc, CHANGE)
    app = doc.application
    _log(actor, app, doc, m.DocumentAccessLog.Action.DELETE)
    access.audit_write(request, actor, "delete", doc, extra={"application": str(app.pk)})
    doc.delete()  # the ciphertext file is removed after commit (signals.py)


def token_seconds() -> int:
    return int(getattr(settings, "NEXUS_DOCUMENT_TOKEN_SECONDS", 60))


def issue_download(request, actor: Actor, doc: m.SecureDocument) -> dict:
    """A short-lived (``NEXUS_DOCUMENT_TOKEN_SECONDS``), single-use token for this user and
    this document. Access is checked again when it is redeemed."""
    if not access.for_actor(actor, m.SecureDocument).filter(pk=doc.pk).exists():
        raise Http404()
    expires = timezone.now() + dt.timedelta(seconds=token_seconds())
    grant = m.DocumentDownloadGrant.objects.create(workspace=actor.workspace, document=doc, user=actor.user, expires_at=expires,
                                                   created_by=actor.user)
    token = signing.dumps({"g": str(grant.pk), "d": str(doc.pk), "u": str(actor.user.public_id), "w": str(actor.workspace_id)},
                          salt=TOKEN_SALT, compress=False)
    _log(actor, doc.application, doc, m.DocumentAccessLog.Action.GRANT)
    access.audit_write(request, actor, "grant", doc, extra={"application": str(doc.application_id), "expires_in": token_seconds()})
    return {"token": token, "expires_at": expires}


class DownloadRefused(PermissionDeniedError):
    message = "This download link has expired, was used already or isn't yours. Ask for a new one."


_TOKEN_RE = re.compile(r"^[A-Za-z0-9_\-:.]{20,600}$")


def redeem_download(request, actor: Actor, token: str) -> tuple[m.SecureDocument, bytes]:
    """Checks a download token (signature, expiry, user, workspace, single use) and the
    actor's access to the document *now*, then decrypts it. Every outcome is audited."""

    def refuse(reason: str, doc=None, *, not_found: bool = False):
        audit(request, "crm.securedocument.download_refused", target_type="securedocument", target_id=str(doc.pk) if doc else "",
              actor=actor.user, metadata={"workspace": str(actor.workspace_id), "reason": reason})
        if doc is not None:
            _log(actor, doc.application, doc, m.DocumentAccessLog.Action.DENIED, reason)
        if not_found:
            raise Http404()
        raise DownloadRefused()

    if not isinstance(token, str) or not _TOKEN_RE.match(token):
        refuse("malformed")
    try:
        payload = signing.loads(token, salt=TOKEN_SALT, max_age=token_seconds())
    except signing.SignatureExpired:
        refuse("expired")
    except signing.BadSignature:
        refuse("bad_signature")
    if not isinstance(payload, dict) or payload.get("w") != str(actor.workspace_id):
        refuse("other_workspace", not_found=True)
    grant = m.DocumentDownloadGrant.objects.filter(workspace_id=actor.workspace_id, pk=payload.get("g"),
                                                   document_id=payload.get("d")).select_related("document").first()
    doc = grant.document if grant else None
    if grant is None:
        refuse("unknown_grant")
    if payload.get("u") != str(actor.user.public_id) or grant.user_id != actor.user.pk:
        refuse("other_user", doc)
    if grant.expires_at < timezone.now():
        refuse("expired", doc)
    # Access is checked again now: a broker who was unassigned since can't use an old link.
    if not access.for_actor(actor, m.SecureDocument).filter(pk=doc.pk).exists():
        refuse("access_revoked", doc, not_found=True)
    if m.DocumentDownloadGrant.objects.filter(pk=grant.pk, used_at__isnull=True).update(used_at=timezone.now()) != 1:
        refuse("already_used", doc)
    try:
        plaintext = documents.open_sealed(doc)
    except (documents.DocumentIntegrityError, FileNotFoundError):
        audit(request, "crm.securedocument.integrity_error", target=doc, actor=actor.user, metadata={"workspace": str(actor.workspace_id)})
        raise
    _log(actor, doc.application, doc, m.DocumentAccessLog.Action.DOWNLOAD)
    access.audit_write(request, actor, "download", doc, extra={"application": str(doc.application_id)})
    return doc, plaintext


def access_log(actor: Actor, app: m.LendingApplication):
    """Uploads, downloads, refusals and deletions of an application's documents (managers)."""
    access.require(actor, Cap.LENDING_SENSITIVE, "Only owners, admins and managers see the document access log.")
    return access.for_actor(actor, m.DocumentAccessLog).filter(application=app).select_related("user").order_by("-created_at")


def visible_application(actor: Actor, pk, action: str = VIEW) -> m.LendingApplication:
    return access.get_for_actor(actor, m.LendingApplication, pk, action)
