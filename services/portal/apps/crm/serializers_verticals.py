"""JSON shapes of the vertical records, milestones, meeting notes and action items.

Same rules as ``serializers.py``: related records appear only when the actor may see them
(``Ctx``), people by ``public_id``. Secure documents are metadata only — their contents are
never serialized anywhere.
"""

from __future__ import annotations

from django.utils import timezone

from . import lending, realestate
from . import models as m
from .access import Cap
from .serializers import Ctx, contact_ref, money, opportunity_ref, user_ref

# --- real estate ---------------------------------------------------------------------------------


def property_brief(ctx: Ctx, p: m.Property | None) -> dict | None:
    if p is None or not ctx.allowed(m.Property, p.pk):
        return None
    return {"id": str(p.pk), "display_name": p.display_name, "status": p.status, "list_price": money(p.list_price), "currency": p.currency,
            "city": p.city}


def property_json(ctx: Ctx, p: m.Property) -> dict:
    return {
        "id": str(p.pk),
        "type": "crm.property",
        "display_name": p.display_name,
        "address_line1": p.address_line1,
        "address_line2": p.address_line2,
        "city": p.city,
        "region": p.region,
        "postal_code": p.postal_code,
        "country": p.country,
        "listing_type": p.listing_type,
        "property_type": p.property_type,
        "status": p.status,
        "status_label": m.Property.Status(p.status).label,
        "list_price": money(p.list_price),
        "currency": p.currency,
        "bedrooms": p.bedrooms,
        "bathrooms": str(p.bathrooms) if p.bathrooms is not None else None,
        "area": p.area,
        "area_unit": p.area_unit,
        "year_built": p.year_built,
        "headline": p.headline,
        "description": p.description,
        "listed_at": p.listed_at,
        "notes": p.notes,
        "source": p.source,
        "source_label": m.Property.Source(p.source).label,
        "source_detail": p.source_detail,
        "owner": user_ref(p.owner),
        "visibility": p.visibility,
        "archived": p.archived_at is not None,
        "is_demo": p.is_demo,
        "created_at": p.created_at,
        "updated_at": p.updated_at,
        "created_by": user_ref(p.created_by),
        "permissions": ctx.perms(m.Property, p.pk),
    }


def prepare_properties(ctx: Ctx, rows) -> list:
    ids = [p.pk for p in rows]
    for action in ("view", "change", "delete"):
        ctx.prime(m.Property, ids, action)
    return rows


def property_contact_json(ctx: Ctx, link: m.PropertyContact) -> dict | None:
    ref = contact_ref(ctx, link.contact)
    if ref is None:
        return None
    return {"id": str(link.pk), "contact": ref, "role": link.role, "role_label": m.PropertyContact.Role(link.role).label,
            "permissions": ctx.perms(m.PropertyContact, link.pk)}


def opportunity_property_json(ctx: Ctx, link: m.OpportunityProperty) -> dict | None:
    prop = property_brief(ctx, link.property)
    opp = opportunity_ref(ctx, link.opportunity)
    if prop is None or opp is None:
        return None
    return {"id": str(link.pk), "property": prop, "opportunity": opp, "role": link.role,
            "role_label": m.OpportunityProperty.Role(link.role).label, "permissions": ctx.perms(m.OpportunityProperty, link.pk)}


def preference_json(pref: m.ClientPreference | None) -> dict | None:
    if pref is None:
        return None
    return {
        "id": str(pref.pk),
        "listing_type": pref.listing_type,
        "budget_min": money(pref.budget_min),
        "budget_max": money(pref.budget_max),
        "currency": pref.currency,
        "areas": pref.areas or [],
        "property_types": pref.property_types or [],
        "bedrooms_min": pref.bedrooms_min,
        "bathrooms_min": str(pref.bathrooms_min) if pref.bathrooms_min is not None else None,
        "area_min": pref.area_min,
        "must_haves": pref.must_haves or [],
        "nice_to_haves": pref.nice_to_haves or [],
        "timeline": pref.timeline,
        "timeline_label": m.ClientPreference.Timeline(pref.timeline).label if pref.timeline else "",
        "move_by": pref.move_by,
        "notes": pref.notes,
        "updated_at": pref.updated_at,
    }


def milestone_json(ctx: Ctx, ms: m.Milestone, today=None) -> dict:
    today = today or timezone.localdate()
    return {
        "id": str(ms.pk),
        "type": "crm.milestone",
        "category": ms.category,
        "milestone_type": ms.milestone_type,
        "milestone_type_label": m.Milestone.Type(ms.milestone_type).label,
        "title": ms.title,
        "due_date": ms.due_date,
        "status": ms.status,
        "urgency": realestate.milestone_urgency(ms, today),
        "completed_at": ms.completed_at,
        "completed_by": user_ref(ms.completed_by),
        "amount": money(ms.amount),
        "currency": ms.currency,
        "notes": ms.notes,
        "responsible": user_ref(ms.responsible),
        "opportunity": opportunity_ref(ctx, ms.opportunity) if ms.opportunity_id else None,
        "application": ({"id": str(ms.application_id), "reference": ms.application.reference, "title": ms.application.title}
                        if ms.application_id and ctx.allowed(m.LendingApplication, ms.application_id) else None),
        "is_demo": ms.is_demo,
        "permissions": ctx.perms(m.Milestone, ms.pk),
    }


# --- lending ---------------------------------------------------------------------------------------


def document_json(doc: m.SecureDocument) -> dict:
    return {
        "id": str(doc.pk),
        "name": doc.original_name,
        "content_type": doc.content_type,
        "size": doc.size,
        "checklist_item_id": str(doc.checklist_item_id) if doc.checklist_item_id else None,
        "uploaded_by": user_ref(doc.created_by),
        "uploaded_at": doc.created_at,
        "encrypted": True,
    }


def checklist_item_json(ctx: Ctx, item: m.DocumentChecklistItem, docs: list | None = None, today=None) -> dict:
    today = today or timezone.localdate()
    return {
        "id": str(item.pk),
        "name": item.name,
        "description": item.description,
        "required": item.required,
        "status": item.status,
        "status_label": m.DocumentChecklistItem.Status(item.status).label,
        "outstanding": item.is_outstanding,
        "overdue": bool(item.is_outstanding and item.due_date and item.due_date < today),
        "due_date": item.due_date,
        "requested_at": item.requested_at,
        "requested_by": user_ref(item.requested_by),
        "received_at": item.received_at,
        "reviewed_at": item.reviewed_at,
        "reviewed_by": user_ref(item.reviewed_by),
        "internal_note": item.internal_note,
        "task_id": str(item.task_id) if item.task_id else None,
        "documents": [document_json(d) for d in (docs or [])],
        "permissions": ctx.perms(m.DocumentChecklistItem, item.pk),
    }


def application_json(ctx: Ctx, app: m.LendingApplication, *, items=None) -> dict:
    links = list(app.borrower_links.all())
    borrowers = []
    hidden = 0
    for link in links:
        ref = contact_ref(ctx, link.contact)
        if ref is None:
            hidden += 1
            continue
        borrowers.append({**ref, "role": link.role})
    return {
        "id": str(app.pk),
        "type": "crm.lendingapplication",
        "reference": app.reference,
        "title": app.title,
        "pipeline_id": str(app.pipeline_id),
        "stage": {"id": str(app.stage_id), "name": app.stage.name, "position": app.stage.position},
        "stage_entered_at": app.stage_entered_at,
        "position": app.position,
        "borrowers": borrowers,
        "hidden_borrowers": hidden,
        "loan_officer": user_ref(app.loan_officer),
        "product_type": app.product_type,
        "product_label": m.LendingApplication.ProductType(app.product_type).label,
        "amount_requested": money(app.amount_requested),
        "currency": app.currency,
        "status": app.status,
        "decision": app.decision,
        "decision_label": m.LendingApplication.Decision(app.decision).label,
        "decision_note": app.decision_note,
        "decision_by": user_ref(app.decision_by),
        "decision_at": app.decision_at,
        "opportunity": opportunity_ref(ctx, app.opportunity) if app.opportunity_id else None,
        "property": property_brief(ctx, app.property) if app.property_id else None,
        "target_close_date": app.target_close_date,
        "source": app.source,
        "checklist": lending.checklist_progress(app, items),
        "is_demo": app.is_demo,
        "created_at": app.created_at,
        "updated_at": app.updated_at,
        "created_by": user_ref(app.created_by),
        "permissions": {**ctx.perms(m.LendingApplication, app.pk), "decide": ctx.actor.can(Cap.LENDING_DECIDE),
                        "view_access_log": ctx.actor.can(Cap.LENDING_SENSITIVE)},
    }


def application_queryset(qs):
    return qs.select_related("stage", "loan_officer", "decision_by", "opportunity", "property", "created_by").prefetch_related(
        "borrower_links__contact", "checklist")


def prepare_applications(ctx: Ctx, rows) -> list:
    ids = [a.pk for a in rows]
    for action in ("view", "change", "delete"):
        ctx.prime(m.LendingApplication, ids, action)
    ctx.prime(m.Contact, [link.contact_id for a in rows for link in a.borrower_links.all()])
    ctx.prime(m.Opportunity, [a.opportunity_id for a in rows])
    ctx.prime(m.Property, [a.property_id for a in rows])
    return rows


def note_json(ctx: Ctx, note: m.ApplicationNote) -> dict:
    return {"id": str(note.pk), "body": note.body, "visibility": note.visibility,
            "visibility_label": m.ApplicationNote.Visibility(note.visibility).label, "author": user_ref(note.created_by),
            "created_at": note.created_at, "updated_at": note.updated_at, "permissions": ctx.perms(m.ApplicationNote, note.pk)}


def access_log_json(row: m.DocumentAccessLog) -> dict:
    return {"id": str(row.pk), "action": row.action, "action_label": m.DocumentAccessLog.Action(row.action).label,
            "document_id": str(row.document_id) if row.document_id else None, "document_name": row.document_name,
            "user": user_ref(row.user), "reason": row.reason, "at": row.created_at}


def template_json(t: m.ChecklistTemplate) -> dict:
    return {"id": str(t.pk), "name": t.name, "product_type": t.product_type, "items": t.items or [], "archived": t.archived,
            "is_demo": t.is_demo}


def lending_history_json(h: m.LendingStageHistory) -> dict:
    return {"id": str(h.pk), "from_name": h.from_name, "to_name": h.to_name, "changed_by": user_ref(h.created_by), "changed_at": h.created_at}


# --- meetings ----------------------------------------------------------------------------------------


def event_brief(ctx: Ctx, e: m.CalendarEvent | None) -> dict | None:
    if e is None or not ctx.allowed(m.CalendarEvent, e.pk):
        return None
    return {"id": str(e.pk), "title": e.title, "kind": e.kind, "start_at": e.start_at, "end_at": e.end_at,
            "matrix_room_id": e.matrix_room_id}


def meeting_note_json(ctx: Ctx, n: m.MeetingNote) -> dict:
    return {
        "id": str(n.pk),
        "type": "crm.meetingnote",
        "title": n.title,
        "body": n.body,
        "visibility": n.visibility,
        "visibility_label": m.MeetingNote.Visibility(n.visibility).label,
        "event": event_brief(ctx, n.event),
        "contact": contact_ref(ctx, n.contact),
        "opportunity": opportunity_ref(ctx, n.opportunity),
        "room_id": n.room_id,
        "author": user_ref(n.created_by),
        "is_demo": n.is_demo,
        "created_at": n.created_at,
        "updated_at": n.updated_at,
        "permissions": ctx.perms(m.MeetingNote, n.pk),
    }


def action_item_json(ctx: Ctx, a: m.ActionItem) -> dict:
    return {
        "id": str(a.pk),
        "type": "crm.actionitem",
        "title": a.title,
        "description": a.description,
        "status": a.status,
        "source": a.source,
        "source_label": m.ActionItem.Source(a.source).label,
        "suggested_assignee": user_ref(a.suggested_assignee),
        "suggested_due_at": a.suggested_due_at,
        "note_id": str(a.note_id) if a.note_id and ctx.allowed(m.MeetingNote, a.note_id) else None,
        "event": event_brief(ctx, a.event),
        "contact": contact_ref(ctx, a.contact),
        "opportunity": opportunity_ref(ctx, a.opportunity),
        "proposed_by": user_ref(a.created_by),
        "decided_by": user_ref(a.decided_by),
        "decided_at": a.decided_at,
        "task_id": str(a.task_id) if a.task_id else None,
        "is_demo": a.is_demo,
        "created_at": a.created_at,
        "permissions": ctx.perms(m.ActionItem, a.pk),
    }
