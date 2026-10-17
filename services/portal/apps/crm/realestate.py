"""Real-estate services: properties, who is related to them, buyer/seller roles on deals,
structured client preferences, viewings, and deal milestones / transaction deadlines.

Every function takes an ``Actor`` and authorizes through ``apps.crm.access``; IDs in a body
are resolved with ``access.resolve*`` (unknown and inaccessible look the same); every write is
audited with field names only. Other teams (the AI assistant's tools) call these functions,
never the ORM.

Honesty: a property's ``source`` says where it came from (``manual`` by default). Imports
must be labelled; Nexus has no MLS access and never invents listings.
"""

from __future__ import annotations

import datetime as dt

from django.conf import settings
from django.db.models import Max, Q
from django.utils import timezone

from apps.api.errors import ValidationFailed
from apps.api.schema import F, validate

from . import access, services
from . import models as m
from .access import CHANGE, Actor, Cap

# --- properties -----------------------------------------------------------------------------------

PROPERTY_SPEC = {
    "address_line1": F.string(max_length=200, required=True, blank=False),
    "address_line2": F.string(max_length=200),
    "city": F.string(max_length=100),
    "region": F.string(max_length=100),
    "postal_code": F.string(max_length=20),
    "country": F.string(max_length=2, default="US"),
    "listing_type": F.choice(m.Property.ListingType.values, default=m.Property.ListingType.SALE),
    "property_type": F.choice(m.Property.PropertyType.values, default=m.Property.PropertyType.HOUSE),
    "status": F.choice(m.Property.Status.values, default=m.Property.Status.PROSPECT),
    "list_price": F.decimal(max_digits=14, decimal_places=2, null=True, default=None),
    "currency": services.currency_field(default="USD"),
    "bedrooms": F.integer(min_value=0, max_value=200, null=True, default=None),
    "bathrooms": F.decimal(max_digits=4, decimal_places=1, null=True, default=None),
    "area": F.integer(min_value=0, max_value=10_000_000, null=True, default=None),
    "area_unit": F.choice(m.Property.AreaUnit.values, default=m.Property.AreaUnit.SQFT),
    "year_built": F.integer(min_value=1000, max_value=2200, null=True, default=None),
    "headline": F.string(max_length=200),
    "description": F.string(max_length=5000, multiline=True),
    "listed_at": F.date(null=True, default=None),
    "notes": F.string(max_length=5000, multiline=True),
    # Clients may say "manual" or "import" (with a label); "integration" is server-side only.
    "source": F.choice([m.Property.Source.MANUAL, m.Property.Source.IMPORT], default=m.Property.Source.MANUAL),
    "source_detail": F.string(max_length=200),
    "owner_id": F.uuid(null=True),
    "visibility": F.choice(m.Visibility.values, default=m.Visibility.TEAM),
    "archived": F.boolean(default=False),
}
_PROPERTY_SCALARS = ["address_line1", "address_line2", "city", "region", "postal_code", "country", "listing_type", "property_type",
                     "status", "list_price", "currency", "bedrooms", "bathrooms", "area", "area_unit", "year_built", "headline",
                     "description", "listed_at", "notes", "source", "source_detail", "visibility"]


def _check_property(p: m.Property) -> None:
    p.country = (p.country or "").upper()
    if p.country and (len(p.country) != 2 or not p.country.isalpha()):
        raise ValidationFailed(fields={"country": ["Use a two-letter country code, e.g. US."]})
    if p.source == m.Property.Source.IMPORT and not p.source_detail:
        raise ValidationFailed(fields={"source_detail": ["Say where the imported listing came from."]})


def create_property(request, actor: Actor, body: dict) -> m.Property:
    """Creates a property (``source`` "manual" unless the caller labels an import)."""
    access.require(actor, Cap.RECORDS_CREATE)
    data = validate(body, PROPERTY_SPEC)
    p = m.Property(workspace=actor.workspace, created_by=actor.user)
    for key in _PROPERTY_SCALARS:
        setattr(p, key, data[key])
    p.owner = access.resolve_member(actor, data["owner_id"], field_name="owner_id") if "owner_id" in body else actor.user
    p.archived_at = timezone.now() if data["archived"] else None
    _check_property(p)
    p.save()
    access.audit_write(request, actor, "create", p, fields=list(body))
    return p


def update_property(request, actor: Actor, p: m.Property, body: dict) -> m.Property:
    """Changes the given fields of ``p`` (the caller checked CHANGE access)."""
    spec = dict(PROPERTY_SPEC)
    spec["address_line1"] = F.string(max_length=200, blank=False)
    spec["currency"] = services.currency_field()
    data = validate(body, spec, partial=True)
    if p.source == m.Property.Source.INTEGRATION:
        data.pop("source", None)  # a synced listing stays labelled as such
    changed: list[str] = []
    services._set(p, data, _PROPERTY_SCALARS, changed)
    if "owner_id" in data:
        owner = access.resolve_member(actor, data["owner_id"], field_name="owner_id")
        if owner != p.owner:
            p.owner = owner
            changed.append("owner")
    if "archived" in data and data["archived"] != (p.archived_at is not None):
        p.archived_at = timezone.now() if data["archived"] else None
        changed.append("archived")
    _check_property(p)
    p.save()
    access.audit_write(request, actor, "update", p, fields=changed)
    return p


def search_properties(actor: Actor, *, q: str = "", status: str = "", city: str = "", owner=None, include_archived: bool = False):
    """Properties the actor may see, filtered (for lists and the AI assistant's tools)."""
    qs = access.for_actor(actor, m.Property)
    if not include_archived:
        qs = qs.filter(archived_at__isnull=True)
    for term in (q or "").split()[:5]:
        qs = qs.filter(Q(address_line1__icontains=term) | Q(address_line2__icontains=term) | Q(city__icontains=term)
                       | Q(postal_code__icontains=term) | Q(headline__icontains=term))
    if status:
        qs = qs.filter(status=status)
    if city:
        qs = qs.filter(city__iexact=city)
    if owner is not None:
        qs = qs.filter(owner=owner)
    return qs


# --- relations: property <-> contact, deal <-> property, buyer/seller roles on deals ---------------

PROPERTY_CONTACT_SPEC = {"contact_id": F.uuid(required=True), "role": F.choice(m.PropertyContact.Role.values, default="interested")}


def link_property_contact(request, actor: Actor, prop: m.Property, body: dict) -> m.PropertyContact:
    """Relates a contact to a property with a role (seller, buyer, ...). Idempotent."""
    services.ensure_actor_can(actor, m.Property, prop, CHANGE)
    data = validate(body, PROPERTY_CONTACT_SPEC)
    contact = access.resolve_one(actor, m.Contact, data["contact_id"], field_name="contact_id")
    link, created = m.PropertyContact.objects.get_or_create(
        workspace=actor.workspace, property=prop, contact=contact, role=data["role"], defaults={"created_by": actor.user}
    )
    if created:
        access.audit_write(request, actor, "create", link, fields=["contact", "role"])
    return link


OPP_PROPERTY_SPEC = {"property_id": F.uuid(required=True), "role": F.choice(m.OpportunityProperty.Role.values, default="purchase")}


def link_opportunity_property(request, actor: Actor, opp: m.Opportunity, body: dict) -> m.OpportunityProperty:
    """Relates a property to a deal (listing, purchase, considering). Updates the role if the
    property is linked already."""
    services.ensure_actor_can(actor, m.Opportunity, opp, CHANGE)
    data = validate(body, OPP_PROPERTY_SPEC)
    prop = access.resolve_one(actor, m.Property, data["property_id"], field_name="property_id")
    link = m.OpportunityProperty.objects.filter(opportunity=opp, property=prop).first()
    if link is None:
        link = m.OpportunityProperty.objects.create(workspace=actor.workspace, opportunity=opp, property=prop, role=data["role"],
                                                    created_by=actor.user)
        access.audit_write(request, actor, "create", link, fields=["property", "role"])
    elif link.role != data["role"]:
        link.role = data["role"]
        link.save(update_fields=["role", "updated_at"])
        access.audit_write(request, actor, "update", link, fields=["role"])
    return link


CONTACT_ROLE_SPEC = {"contact_id": F.uuid(required=True), "role": F.choice(m.OpportunityContact.Role.values, required=True)}


def set_opportunity_contact_role(request, actor: Actor, opp: m.Opportunity, body: dict) -> m.OpportunityContact:
    """Sets a contact's role on a deal (buyer, seller, borrower, ...), adding the contact to
    the deal if needed."""
    services.ensure_actor_can(actor, m.Opportunity, opp, CHANGE)
    data = validate(body, CONTACT_ROLE_SPEC)
    contact = access.resolve_one(actor, m.Contact, data["contact_id"], field_name="contact_id")
    link, created = m.OpportunityContact.objects.get_or_create(opportunity=opp, contact=contact, defaults={"role": data["role"]})
    if not created and link.role != data["role"]:
        link.role = data["role"]
        link.save(update_fields=["role"])
    access.audit_write(request, actor, "update", opp, fields=["contacts"])
    return link


# --- client preferences -----------------------------------------------------------------------------

_LIST_OF_TEXT = F.list(F.string(max_length=80, blank=False), max_items=30)
PREFERENCE_SPEC = {
    "listing_type": F.choice(m.Property.ListingType.values, default=m.Property.ListingType.SALE),
    "budget_min": F.decimal(max_digits=14, decimal_places=2, null=True, default=None),
    "budget_max": F.decimal(max_digits=14, decimal_places=2, null=True, default=None),
    "currency": services.currency_field(default="USD"),
    "areas": _LIST_OF_TEXT,
    "property_types": F.list(F.choice(m.Property.PropertyType.values), max_items=10),
    "bedrooms_min": F.integer(min_value=0, max_value=50, null=True, default=None),
    "bathrooms_min": F.decimal(max_digits=4, decimal_places=1, null=True, default=None),
    "area_min": F.integer(min_value=0, max_value=10_000_000, null=True, default=None),
    "must_haves": _LIST_OF_TEXT,
    "nice_to_haves": _LIST_OF_TEXT,
    "timeline": F.choice([""] + m.ClientPreference.Timeline.values, default=""),
    "move_by": F.date(null=True, default=None),
    "notes": F.string(max_length=2000, multiline=True),
}


def get_preferences(actor: Actor, contact: m.Contact) -> m.ClientPreference | None:
    """The contact's preferences, if the actor may see the contact (else ``None``)."""
    return access.for_actor(actor, m.ClientPreference).filter(contact=contact).first()


def save_preferences(request, actor: Actor, contact: m.Contact, body: dict) -> m.ClientPreference:
    """Creates or updates (partially) the contact's preferences. Needs CHANGE on the contact."""
    services.ensure_actor_can(actor, m.Contact, contact, CHANGE)
    pref = m.ClientPreference.objects.filter(contact=contact).first()
    creating = pref is None
    data = validate(body, PREFERENCE_SPEC, partial=not creating)
    if creating:
        pref = m.ClientPreference(workspace=actor.workspace, contact=contact, created_by=actor.user)
    changed: list[str] = []
    services._set(pref, data, list(PREFERENCE_SPEC), changed)
    lo, hi = pref.budget_min, pref.budget_max
    if lo is not None and hi is not None and lo > hi:
        raise ValidationFailed(fields={"budget_max": ["The maximum budget is below the minimum."]})
    pref.save()
    access.audit_write(request, actor, "create" if creating else "update", pref, fields=changed or list(body))
    return pref


def matching_properties(actor: Actor, pref: m.ClientPreference, limit: int = 10):
    """Visible, available properties that fit a preference set (budget, bedrooms, bathrooms,
    type, area). Only the workspace's own records: never external listings."""
    qs = search_properties(actor).filter(status__in=[m.Property.Status.ACTIVE, m.Property.Status.COMING_SOON],
                                         listing_type=pref.listing_type)
    if pref.budget_max is not None:
        qs = qs.filter(Q(list_price__isnull=True) | Q(list_price__lte=pref.budget_max))
    if pref.budget_min is not None:
        qs = qs.filter(Q(list_price__isnull=True) | Q(list_price__gte=pref.budget_min))
    if pref.bedrooms_min is not None:
        qs = qs.filter(bedrooms__gte=pref.bedrooms_min)
    if pref.bathrooms_min is not None:
        qs = qs.filter(bathrooms__gte=pref.bathrooms_min)
    if pref.property_types:
        qs = qs.filter(property_type__in=pref.property_types)
    if pref.areas:
        area_q = Q()
        for a in pref.areas[:10]:
            area_q |= Q(city__icontains=a) | Q(address_line1__icontains=a) | Q(postal_code__iexact=a) | Q(headline__icontains=a)
        qs = qs.filter(area_q)
    return qs.order_by("list_price", "-updated_at")[:limit]


# --- viewings -------------------------------------------------------------------------------------

VIEWING_SPEC = {
    "property_id": F.uuid(required=True),
    "contact_ids": F.list(F.uuid(), max_items=10),
    "start_at": F.datetime(required=True),
    "end_at": F.datetime(null=True, default=None),
    "title": F.string(max_length=200),
    "description": F.string(max_length=5000, multiline=True),
    "attendee_user_ids": F.list(F.uuid(), max_items=20),
    "opportunity_id": F.uuid(null=True, default=None),
    "matrix_room_id": services.room_field(),
}


def schedule_viewing(request, actor: Actor, body: dict) -> m.CalendarEvent:
    """A calendar event of kind ``viewing`` at a property with buyers/tenants (internal
    calendar only: nobody outside the workspace is emailed)."""
    data = validate(body, VIEWING_SPEC)
    prop = access.resolve_one(actor, m.Property, data["property_id"], field_name="property_id")
    access.resolve(actor, m.Contact, data["contact_ids"], field_name="contact_ids")
    end = data["end_at"] or data["start_at"] + dt.timedelta(minutes=45)
    contact_ids = [str(c) for c in data["contact_ids"]]
    event_body = {
        "kind": m.CalendarEvent.Kind.VIEWING,
        "title": data["title"] or f"Viewing: {prop.display_name}",
        "description": data["description"],
        "start_at": data["start_at"].isoformat(),
        "end_at": end.isoformat(),
        "location": ", ".join(x for x in [prop.address_line1, prop.city] if x)[:200],
        "attendee_contact_ids": contact_ids,
        "attendee_user_ids": [str(u) for u in data["attendee_user_ids"]] or [str(actor.user.public_id)],
        "contact_id": contact_ids[0] if contact_ids else None,
        "opportunity_id": str(data["opportunity_id"]) if data["opportunity_id"] else None,
        "related": {"type": "crm.property", "id": str(prop.pk)},
        "matrix_room_id": data["matrix_room_id"],
    }
    return services.create_event(request, actor, event_body)


def viewings(actor: Actor, *, property: m.Property | None = None, contact: m.Contact | None = None):
    """Viewing appointments the actor may see, for a property and/or a contact."""
    qs = access.for_actor(actor, m.CalendarEvent).filter(kind=m.CalendarEvent.Kind.VIEWING)
    if property is not None:
        qs = qs.filter(related_type="crm.property", related_id=property.pk)
    if contact is not None:
        qs = qs.filter(Q(contact=contact) | Q(attendee_contacts=contact)).distinct()
    return qs.order_by("-start_at")


# --- milestones and deadlines ------------------------------------------------------------------------

MILESTONE_SPEC = {
    "opportunity_id": F.uuid(null=True, default=None),
    "application_id": F.uuid(null=True, default=None),
    "category": F.choice(m.Milestone.Category.values, default=m.Milestone.Category.DEADLINE),
    "milestone_type": F.choice(m.Milestone.Type.values, default=m.Milestone.Type.CUSTOM),
    "title": F.string(max_length=160, required=True, blank=False),
    "due_date": F.date(null=True, default=None),
    "status": F.choice(m.Milestone.Status.values, default=m.Milestone.Status.PENDING),
    "amount": F.decimal(max_digits=14, decimal_places=2, null=True, default=None),
    "currency": services.currency_field(default="USD"),
    "notes": F.string(max_length=2000, multiline=True),
    "responsible_id": F.uuid(null=True, default=None),
}

# Standard transaction deadlines, in days after the accepted offer (editable after creation).
DEADLINE_TEMPLATES = {
    "purchase": [
        ("milestone", "offer_accepted", "Offer accepted", 0),
        ("deadline", "earnest_money", "Earnest money due", 3),
        ("deadline", "inspection", "Inspection contingency ends", 10),
        ("deadline", "appraisal", "Appraisal due", 21),
        ("deadline", "financing", "Financing contingency ends", 30),
        ("deadline", "final_walkthrough", "Final walk-through", 44),
        ("deadline", "closing", "Closing", 45),
    ],
    "listing": [
        ("milestone", "offer_accepted", "Offer accepted", 0),
        ("deadline", "inspection", "Buyer's inspection period ends", 10),
        ("deadline", "appraisal", "Buyer's appraisal due", 21),
        ("deadline", "title", "Title commitment", 25),
        ("deadline", "closing", "Closing", 45),
    ],
    "lending": [
        ("milestone", "application", "Application received", 0),
        ("deadline", "disclosures", "Initial disclosures sent", 3),
        ("deadline", "documents", "Documents due", 10),
        ("deadline", "appraisal", "Appraisal ordered", 12),
        ("deadline", "conditions", "Conditions cleared", 25),
        ("deadline", "closing", "Target closing", 35),
    ],
}


def due_soon_days() -> int:
    return int(getattr(settings, "NEXUS_DEADLINE_SOON_DAYS", 3))


def milestone_urgency(ms: m.Milestone, today: dt.date | None = None) -> str:
    """``done`` | ``overdue`` | ``due_soon`` (within NEXUS_DEADLINE_SOON_DAYS) | ``upcoming`` |
    ``no_date``: what the UI highlights."""
    if ms.status != m.Milestone.Status.PENDING:
        return "done"
    if ms.due_date is None:
        return "no_date"
    today = today or timezone.localdate()
    if ms.due_date < today:
        return "overdue"
    if ms.due_date <= today + dt.timedelta(days=due_soon_days()):
        return "due_soon"
    return "upcoming"


def _milestone_parent(actor: Actor, data: dict, body: dict, current: m.Milestone | None = None):
    opp_id, app_id = data.get("opportunity_id"), data.get("application_id")
    if current is None and bool(opp_id) == bool(app_id):
        raise ValidationFailed(fields={"opportunity_id": ["Attach the milestone to one deal or one lending application."]})
    opp = access.resolve_one(actor, m.Opportunity, opp_id, field_name="opportunity_id", action=CHANGE) if opp_id else None
    app = access.resolve_one(actor, m.LendingApplication, app_id, field_name="application_id", action=CHANGE) if app_id else None
    return opp, app


def _apply_milestone_status(ms: m.Milestone, status: str, actor: Actor) -> None:
    if status == ms.status:
        return
    ms.status = status
    if status in (m.Milestone.Status.DONE, m.Milestone.Status.WAIVED):
        ms.completed_at, ms.completed_by = timezone.now(), actor.user
    else:
        ms.completed_at, ms.completed_by = None, None


def create_milestone(request, actor: Actor, body: dict) -> m.Milestone:
    """A milestone or deadline on a deal (CHANGE on the deal) or a lending application
    (CHANGE on the application)."""
    data = validate(body, MILESTONE_SPEC)
    opp, app = _milestone_parent(actor, data, body)
    ms = m.Milestone(workspace=actor.workspace, created_by=actor.user, opportunity=opp, application=app, category=data["category"],
                     milestone_type=data["milestone_type"], title=data["title"], due_date=data["due_date"], amount=data["amount"],
                     currency=data["currency"], notes=data["notes"])
    ms.responsible = access.resolve_member(actor, data["responsible_id"], field_name="responsible_id") if data["responsible_id"] else None
    _apply_milestone_status(ms, data["status"], actor)
    parent_filter = {"opportunity": opp} if opp else {"application": app}
    ms.position = (m.Milestone.objects.filter(**parent_filter).aggregate(p=Max("position"))["p"] or 0) + 10
    ms.save()
    access.audit_write(request, actor, "create", ms, fields=list(body))
    return ms


def update_milestone(request, actor: Actor, ms: m.Milestone, body: dict) -> m.Milestone:
    """Changes a milestone (the caller checked CHANGE). Completing it stamps who and when."""
    spec = {k: v for k, v in MILESTONE_SPEC.items() if k not in {"opportunity_id", "application_id"}}
    spec["title"] = F.string(max_length=160, blank=False)
    spec["currency"] = services.currency_field()
    data = validate(body, spec, partial=True)
    changed: list[str] = []
    services._set(ms, data, ["category", "milestone_type", "title", "due_date", "amount", "currency", "notes"], changed)
    if "responsible_id" in data:
        ms.responsible = access.resolve_member(actor, data["responsible_id"], field_name="responsible_id") if data["responsible_id"] else None
        changed.append("responsible")
    if "status" in data and data["status"] != ms.status:
        _apply_milestone_status(ms, data["status"], actor)
        changed.append("status")
    ms.save()
    access.audit_write(request, actor, "update", ms, fields=changed)
    return ms


TEMPLATE_SPEC = {
    "template": F.choice(list(DEADLINE_TEMPLATES), required=True),
    "base_date": F.date(null=True, default=None),
    "currency": services.currency_field(default="USD"),
}


def apply_deadline_template(request, actor: Actor, body: dict, *, opportunity: m.Opportunity | None = None,
                            application: m.LendingApplication | None = None) -> list[m.Milestone]:
    """Adds the standard deadlines of ``template`` counted from ``base_date`` (default today).
    Types already present on the record are skipped, so applying twice adds nothing."""
    data = validate(body, TEMPLATE_SPEC)
    if (opportunity is None) == (application is None):
        raise ValueError("one parent")
    if opportunity is not None:
        services.ensure_actor_can(actor, m.Opportunity, opportunity, CHANGE)
        parent = {"opportunity": opportunity}
    else:
        services.ensure_actor_can(actor, m.LendingApplication, application, CHANGE)
        parent = {"application": application}
    base_date = data["base_date"] or timezone.localdate()
    existing = set(m.Milestone.objects.filter(**parent).values_list("milestone_type", flat=True))
    created = []
    for i, (category, mtype, title, days) in enumerate(DEADLINE_TEMPLATES[data["template"]]):
        if mtype in existing:
            continue
        ms = m.Milestone.objects.create(workspace=actor.workspace, created_by=actor.user, category=category, milestone_type=mtype,
                                        title=title, due_date=base_date + dt.timedelta(days=days), position=(i + 1) * 10,
                                        currency=data["currency"], **parent)
        created.append(ms)
    if created:
        target = opportunity or application
        access.audit_write(request, actor, "deadlines", target, fields=["milestones"], extra={"count": len(created)})
    return created


def milestones_for(actor: Actor, *, opportunity=None, application=None, due: str = "", status: str = "open"):
    """Milestones the actor may see. ``due``: overdue | soon | week | month; ``status``: open
    (pending) | done | all."""
    qs = access.for_actor(actor, m.Milestone)
    if opportunity is not None:
        qs = qs.filter(opportunity=opportunity)
    if application is not None:
        qs = qs.filter(application=application)
    if status == "open":
        qs = qs.filter(status=m.Milestone.Status.PENDING)
    elif status == "done":
        qs = qs.exclude(status=m.Milestone.Status.PENDING)
    today = timezone.localdate()
    if due == "overdue":
        qs = qs.filter(due_date__lt=today)
    elif due == "soon":
        qs = qs.filter(due_date__lte=today + dt.timedelta(days=due_soon_days()))
    elif due == "week":
        qs = qs.filter(due_date__lte=today + dt.timedelta(days=7))
    elif due == "month":
        qs = qs.filter(due_date__lte=today + dt.timedelta(days=31))
    return qs.select_related("opportunity", "application", "responsible", "completed_by").order_by("due_date", "position")


def approaching_deadlines(actor: Actor, days: int = 14, limit: int = 20) -> list[m.Milestone]:
    """Open deadlines and milestones due within ``days`` (overdue ones included)."""
    today = timezone.localdate()
    qs = access.for_actor(actor, m.Milestone).filter(status=m.Milestone.Status.PENDING, due_date__isnull=False,
                                                     due_date__lte=today + dt.timedelta(days=days))
    return list(qs.select_related("opportunity", "application", "responsible").order_by("due_date", "position")[:limit])
