"""JSON API of the vertical records, milestones, meetings and reports, under
/api/v1/workspaces/<workspace_id>/crm/ (see ``api_urls.py``).

Feature flags: properties, preferences and viewings need ``real_estate``; applications,
checklists and documents need ``lending``; milestones, meetings and reports need ``crm``.
Everything is authorized through ``apps.crm.access`` (404 for invisible IDs, the uniform 400
for invisible IDs in bodies) and every write is audited.
"""

from __future__ import annotations

import urllib.parse

from django.db.models import Count, Q
from django.http import Http404, HttpResponse
from django.utils import timezone

from apps.api.decorators import api_endpoint
from apps.api.errors import NotFound, PayloadTooLarge, ValidationFailed, error_response
from apps.api.http import created, json_body, no_content, ok, paginated
from apps.api.schema import F, query_bool, query_param, validate

from . import access, documents, lending, meetings, realestate, reports, services
from . import models as m
from . import serializers as s
from . import serializers_verticals as sv
from .access import CHANGE, DELETE, Actor, Cap

re_endpoint = lambda methods: api_endpoint(methods=methods, feature="real_estate")  # noqa: E731
lending_endpoint = lambda methods: api_endpoint(methods=methods, feature="lending")  # noqa: E731
crm_endpoint = lambda methods: api_endpoint(methods=methods, feature="crm")  # noqa: E731
Q_FIELD = F.string(max_length=100)


def _user_filter(actor: Actor, request, name: str):
    raw = request.GET.get(name)
    if not raw:
        return None
    if raw == "me":
        return actor.user
    return access.resolve_members(actor, [raw], field_name=name)[0]


# --- properties ----------------------------------------------------------------------------------------


def _property_list(request, actor, qs):
    ctx = s.Ctx(actor)
    return paginated(request, qs.select_related("owner", "created_by"), lambda p: sv.property_json(ctx, p),
                     prepare=lambda rows: sv.prepare_properties(ctx, rows))


@re_endpoint(["GET", "POST"])
def properties(request, actor: Actor):
    """GET filters: q, status, city, owner (me|id), contact (related contact), archived
    (bool), sort (updated|price|-price)."""
    if request.method == "POST":
        p = realestate.create_property(request, actor, json_body(request))
        return created(sv.property_json(s.Ctx(actor), p))
    qs = realestate.search_properties(
        actor, q=query_param(request, "q", Q_FIELD) or "", status=query_param(request, "status", F.choice(m.Property.Status.values)) or "",
        city=query_param(request, "city", F.string(max_length=100)) or "", owner=_user_filter(actor, request, "owner"),
        include_archived=bool(query_bool(request, "archived", False)),
    )
    if query_bool(request, "archived", False):
        qs = qs.filter(archived_at__isnull=False)
    contact_id = query_param(request, "contact", F.uuid())
    if contact_id:
        contact = access.resolve_one(actor, m.Contact, str(contact_id), field_name="contact")
        qs = qs.filter(pk__in=m.PropertyContact.objects.filter(contact=contact).values("property_id"))
    sort = query_param(request, "sort", F.choice(["updated", "price", "-price"]), default="updated")
    order = {"updated": ["-updated_at"], "price": ["list_price"], "-price": ["-list_price"]}[sort]
    return _property_list(request, actor, qs.order_by(*order, "pk"))


@re_endpoint(["GET", "PATCH", "DELETE"])
def property_detail(request, actor: Actor, property_id):
    ctx = s.Ctx(actor)
    if request.method == "DELETE":
        p = access.get_for_actor(actor, m.Property, property_id, DELETE)
        services.delete_record(request, actor, p)
        return no_content()
    if request.method == "PATCH":
        p = access.get_for_actor(actor, m.Property, property_id, CHANGE)
        realestate.update_property(request, actor, p, json_body(request))
        return ok(sv.property_json(ctx, m.Property.objects.select_related("owner", "created_by").get(pk=p.pk)))
    p = access.get_for_actor(actor, m.Property, property_id, queryset=access.for_actor(actor, m.Property).select_related("owner", "created_by"))
    contacts = [r for r in (sv.property_contact_json(ctx, link) for link in access.for_actor(actor, m.PropertyContact)
                            .filter(property=p).select_related("contact")) if r]
    deals = [r for r in (sv.opportunity_property_json(ctx, link) for link in access.for_actor(actor, m.OpportunityProperty)
                         .filter(property=p).select_related("opportunity", "property")) if r]
    viewings = list(s.event_queryset(realestate.viewings(actor, property=p))[:50])
    s.prepare_events(ctx, viewings)
    return ok({**sv.property_json(ctx, p), "contacts": contacts, "deals": deals, "viewings": [s.event(ctx, e) for e in viewings]})


@re_endpoint(["POST"])
def property_contacts(request, actor: Actor, property_id):
    """Body: {"contact_id", "role": seller|buyer|landlord|tenant|interested|other}."""
    p = access.get_for_actor(actor, m.Property, property_id, CHANGE)
    link = realestate.link_property_contact(request, actor, p, json_body(request))
    return created(sv.property_contact_json(s.Ctx(actor), link))


@re_endpoint(["DELETE"])
def property_contact_detail(request, actor: Actor, link_id):
    link = access.get_for_actor(actor, m.PropertyContact, link_id, DELETE)
    services.delete_record(request, actor, link)
    return no_content()


@re_endpoint(["GET", "POST"])
def property_viewings(request, actor: Actor, property_id):
    """GET: viewings of the property. POST: schedule one ({start_at, end_at?, contact_ids,
    attendee_user_ids, title?, description?, opportunity_id?, matrix_room_id?})."""
    p = access.get_for_actor(actor, m.Property, property_id)
    ctx = s.Ctx(actor)
    if request.method == "POST":
        body = json_body(request)
        if not isinstance(body, dict):
            raise ValidationFailed("The body must be a JSON object.")
        e = realestate.schedule_viewing(request, actor, {**body, "property_id": str(p.pk)})
        return created(s.event(ctx, s.event_queryset(m.CalendarEvent.objects).get(pk=e.pk)))
    qs = s.event_queryset(realestate.viewings(actor, property=p))
    return paginated(request, qs, lambda e: s.event(ctx, e), prepare=lambda rows: s.prepare_events(ctx, rows))


@re_endpoint(["POST"])
def opportunity_properties(request, actor: Actor, opportunity_id):
    """Body: {"property_id", "role": listing|purchase|considering|other}."""
    o = access.get_for_actor(actor, m.Opportunity, opportunity_id, CHANGE)
    link = realestate.link_opportunity_property(request, actor, o, json_body(request))
    return created(sv.opportunity_property_json(s.Ctx(actor), link))


@re_endpoint(["DELETE"])
def opportunity_property_detail(request, actor: Actor, link_id):
    link = access.get_for_actor(actor, m.OpportunityProperty, link_id, DELETE)
    services.delete_record(request, actor, link)
    return no_content()


@re_endpoint(["GET", "PUT", "PATCH"])
def contact_preferences(request, actor: Actor, contact_id):
    """GET: the buyer's structured preferences (or null) and matching properties of the
    workspace. PUT/PATCH: create or update them (partial updates once they exist; the SPA
    uses PATCH, which CORS allows)."""
    c = access.get_for_actor(actor, m.Contact, contact_id)
    if request.method in ("PUT", "PATCH"):
        access.get_for_actor(actor, m.Contact, contact_id, CHANGE)
        pref = realestate.save_preferences(request, actor, c, json_body(request))
    else:
        pref = realestate.get_preferences(actor, c)
    ctx = s.Ctx(actor)
    matches = list(realestate.matching_properties(actor, pref)) if pref else []
    sv.prepare_properties(ctx, matches)
    return ok({"preferences": sv.preference_json(pref), "matches": [sv.property_json(ctx, p) for p in matches],
               "can_edit": ctx.allowed(m.Contact, c.pk, CHANGE)})


# --- the deal page and the buyer page (vertical summaries) -------------------------------------------------------


@crm_endpoint(["GET"])
def opportunity_vertical(request, actor: Actor, opportunity_id):
    """Everything vertical about a deal for its page: contacts with roles, properties (real
    estate), milestones and deadlines with urgency, linked lending applications (only the
    ones the actor may see)."""
    o = access.get_for_actor(actor, m.Opportunity, opportunity_id, queryset=s.opportunity_queryset(access.for_actor(actor, m.Opportunity)))
    ctx = s.Ctx(actor)
    s.prepare_opportunities(ctx, [o])
    contacts = [{"id": str(link.contact_id), "display_name": link.contact.display_name, "role": link.role,
                 "role_label": m.OpportunityContact.Role(link.role).label} for link in o.contact_links.all() if ctx.allowed(m.Contact, link.contact_id)]
    props = []
    if actor.features.get("real_estate"):
        props = [r for r in (sv.opportunity_property_json(ctx, link) for link in access.for_actor(actor, m.OpportunityProperty)
                             .filter(opportunity=o).select_related("opportunity", "property")) if r]
    milestones = list(realestate.milestones_for(actor, opportunity=o, status="all"))
    today = timezone.localdate()
    apps_ = []
    if actor.features.get("lending"):
        rows = list(sv.application_queryset(access.for_actor(actor, m.LendingApplication).filter(opportunity=o)))
        sv.prepare_applications(ctx, rows)
        apps_ = [sv.application_json(ctx, a) for a in rows]
    return ok({
        "opportunity": s.opportunity(ctx, o),
        "contacts": contacts,
        "properties": props,
        "milestones": [sv.milestone_json(ctx, ms, today) for ms in milestones],
        "applications": apps_,
        "deadline_templates": list(realestate.DEADLINE_TEMPLATES),
        "due_soon_days": realestate.due_soon_days(),
        "can_change": ctx.allowed(m.Opportunity, o.pk, CHANGE),
    })


@crm_endpoint(["POST"])
def opportunity_contact_roles(request, actor: Actor, opportunity_id):
    """Body: {"contact_id", "role": primary|buyer|seller|borrower|co_borrower|other}."""
    o = access.get_for_actor(actor, m.Opportunity, opportunity_id, CHANGE)
    link = realestate.set_opportunity_contact_role(request, actor, o, json_body(request))
    return ok({"contact_id": str(link.contact_id), "role": link.role})


@crm_endpoint(["POST"])
def opportunity_deadline_template(request, actor: Actor, opportunity_id):
    """Body: {"template": purchase|listing, "base_date"?: YYYY-MM-DD}. Adds the standard
    deadlines that aren't there yet."""
    o = access.get_for_actor(actor, m.Opportunity, opportunity_id, CHANGE)
    created_rows = realestate.apply_deadline_template(request, actor, json_body(request), opportunity=o)
    ctx = s.Ctx(actor)
    return created([sv.milestone_json(ctx, ms) for ms in created_rows])


@crm_endpoint(["GET"])
def contact_vertical(request, actor: Actor, contact_id):
    """The buyer/borrower side of a contact: preferences, viewings, related properties and
    (for people with lending access) their applications."""
    c = access.get_for_actor(actor, m.Contact, contact_id)
    ctx = s.Ctx(actor)
    out: dict = {"real_estate": None, "lending": None}
    if actor.features.get("real_estate"):
        pref = realestate.get_preferences(actor, c)
        views = list(s.event_queryset(realestate.viewings(actor, contact=c))[:30])
        s.prepare_events(ctx, views)
        links = [r for r in (sv.property_contact_json(ctx, link) for link in access.for_actor(actor, m.PropertyContact)
                             .filter(contact=c).select_related("property", "contact")) if r]
        for row, link in zip(links, access.for_actor(actor, m.PropertyContact).filter(contact=c).select_related("property")):
            row["property"] = sv.property_brief(ctx, link.property)
        out["real_estate"] = {"preferences": sv.preference_json(pref), "viewings": [s.event(ctx, e) for e in views],
                              "properties": links, "can_edit": ctx.allowed(m.Contact, c.pk, CHANGE)}
    if actor.features.get("lending") and actor.can(Cap.LENDING_ACCESS):
        rows = list(sv.application_queryset(access.for_actor(actor, m.LendingApplication).filter(borrowers=c).distinct()))
        sv.prepare_applications(ctx, rows)
        out["lending"] = {"applications": [sv.application_json(ctx, a) for a in rows]}
    return ok(out)


# --- milestones and deadlines ------------------------------------------------------------------------------


@crm_endpoint(["GET", "POST"])
def milestones(request, actor: Actor):
    """GET filters: opportunity, application, due (overdue|soon|week|month), status
    (open [default] | done | all)."""
    ctx = s.Ctx(actor)
    if request.method == "POST":
        ms = realestate.create_milestone(request, actor, json_body(request))
        return created(sv.milestone_json(ctx, m.Milestone.objects.select_related("opportunity", "application").get(pk=ms.pk)))
    opp = app = None
    oid = query_param(request, "opportunity", F.uuid())
    if oid:
        opp = access.resolve_one(actor, m.Opportunity, str(oid), field_name="opportunity")
    aid = query_param(request, "application", F.uuid())
    if aid:
        app = access.resolve_one(actor, m.LendingApplication, str(aid), field_name="application")
    qs = realestate.milestones_for(actor, opportunity=opp, application=app,
                                   due=query_param(request, "due", F.choice(["overdue", "soon", "week", "month"])) or "",
                                   status=query_param(request, "status", F.choice(["open", "done", "all"]), default="open"))
    today = timezone.localdate()
    return paginated(request, qs, lambda ms: sv.milestone_json(ctx, ms, today))


@crm_endpoint(["PATCH", "DELETE"])
def milestone_detail(request, actor: Actor, milestone_id):
    ms = access.get_for_actor(actor, m.Milestone, milestone_id, CHANGE if request.method == "PATCH" else DELETE)
    if request.method == "DELETE":
        services.delete_record(request, actor, ms)
        return no_content()
    realestate.update_milestone(request, actor, ms, json_body(request))
    return ok(sv.milestone_json(s.Ctx(actor), m.Milestone.objects.select_related("opportunity", "application").get(pk=ms.pk)))


# --- lending -------------------------------------------------------------------------------------------------


def _app_detail(request, actor: Actor, app: m.LendingApplication) -> dict:
    ctx = s.Ctx(actor)
    app = sv.application_queryset(m.LendingApplication.objects).get(pk=app.pk)
    sv.prepare_applications(ctx, [app])
    items = list(app.checklist.select_related("requested_by", "reviewed_by").order_by("position", "created_at"))
    docs = list(access.for_actor(actor, m.SecureDocument).filter(application=app).select_related("created_by").order_by("-created_at"))
    by_item: dict = {}
    loose = []
    for d in docs:
        (by_item.setdefault(d.checklist_item_id, []) if d.checklist_item_id else loose).append(d)
    ctx.prime(m.DocumentChecklistItem, [i.pk for i in items], CHANGE)
    today = timezone.localdate()
    milestones_ = list(realestate.milestones_for(actor, application=app, status="all"))
    return {
        **sv.application_json(ctx, app, items=items),
        "checklist_items": [sv.checklist_item_json(ctx, it, by_item.get(it.pk, []), today) for it in items],
        "other_documents": [sv.document_json(d) for d in loose],
        "outstanding_work": lending.outstanding_work(actor, app),
        "milestones": [sv.milestone_json(ctx, ms, today) for ms in milestones_],
        "pipeline": s.pipeline(app.pipeline),
        "can_request_from_borrower": False,
        "storage_ready": documents.is_configured(),
        "max_upload_bytes": documents.max_bytes(),
        "allowed_types": sorted(documents.ALLOWED_TYPES),
    }


@lending_endpoint(["GET", "POST"])
def applications(request, actor: Actor):
    """GET filters: q, pipeline, stage, status, officer (me|id), missing_documents (bool).
    Only applications the actor may see (managers: all; brokers: assigned to them)."""
    access.require(actor, Cap.LENDING_ACCESS, "Your role doesn't include lending applications.")
    ctx = s.Ctx(actor)
    if request.method == "POST":
        app = lending.create_application(request, actor, json_body(request))
        return created(_app_detail(request, actor, app))
    pipeline = stage = None
    pid = query_param(request, "pipeline", F.uuid())
    if pid:
        pipeline = access.resolve_one(actor, m.Pipeline, str(pid), field_name="pipeline")
    sid = query_param(request, "stage", F.uuid())
    if sid:
        stage = access.resolve_one(actor, m.Stage, str(sid), field_name="stage")
    qs = lending.search_applications(actor, q=query_param(request, "q", Q_FIELD) or "", stage=stage, pipeline=pipeline,
                                     status=query_param(request, "status", F.choice(m.LendingApplication.Status.values)) or "",
                                     officer=_user_filter(actor, request, "officer"),
                                     missing_documents=bool(query_bool(request, "missing_documents", False)))
    return paginated(request, sv.application_queryset(qs.order_by("-updated_at", "pk")), lambda a: sv.application_json(ctx, a),
                     prepare=lambda rows: sv.prepare_applications(ctx, rows))


@lending_endpoint(["GET"])
def lending_board(request, actor: Actor):
    """The application pipeline view: stages of a lending pipeline (default: the
    workspace's), each with the visible applications and their checklist progress."""
    access.require(actor, Cap.LENDING_ACCESS, "Your role doesn't include lending applications.")
    pid = query_param(request, "pipeline", F.uuid())
    pipeline = access.resolve_one(actor, m.Pipeline, str(pid), field_name="pipeline") if pid else lending.lending_pipelines(actor).first()
    if pipeline is None or pipeline.kind != m.Pipeline.Kind.LENDING:
        if pid:
            raise ValidationFailed(fields={"pipeline": ["Choose a lending pipeline."]})
        return ok({"pipeline": None, "pipelines": [], "columns": [], "can_create": actor.can(Cap.LENDING_ACCESS)})
    stages = list(pipeline.stages.order_by("position", "created_at"))
    qs = access.for_actor(actor, m.LendingApplication).filter(pipeline=pipeline).exclude(status="withdrawn")
    officer = _user_filter(actor, request, "officer")
    if officer:
        qs = qs.filter(loan_officer=officer)
    ctx = s.Ctx(actor)
    rows = list(sv.application_queryset(qs).order_by("position", "-updated_at")[:500])
    sv.prepare_applications(ctx, rows)
    columns = []
    for st in stages:
        apps_ = [sv.application_json(ctx, a) for a in rows if a.stage_id == st.pk]
        columns.append({"stage": s.stage(st), "count": len(apps_), "applications": apps_})
    return ok({"pipeline": s.pipeline(pipeline, stages=stages), "pipelines": [s.pipeline(p) for p in lending.lending_pipelines(actor)],
               "columns": columns, "can_create": actor.can(Cap.LENDING_ACCESS), "can_configure": actor.can(Cap.CRM_CONFIGURE)})


@lending_endpoint(["GET", "PATCH", "DELETE"])
def application_detail(request, actor: Actor, application_id):
    if request.method == "DELETE":
        app = access.get_for_actor(actor, m.LendingApplication, application_id, DELETE)
        services.delete_record(request, actor, app)  # its documents' ciphertext goes too (signals.py)
        return no_content()
    if request.method == "PATCH":
        app = access.get_for_actor(actor, m.LendingApplication, application_id, CHANGE)
        lending.update_application(request, actor, app, json_body(request))
        return ok(_app_detail(request, actor, app))
    app = access.get_for_actor(actor, m.LendingApplication, application_id)
    access.audit_read(request, actor, app, reason="lending_application_detail")
    return ok(_app_detail(request, actor, app))


@lending_endpoint(["POST"])
def application_move(request, actor: Actor, application_id):
    """Body: {"stage_id", "index"?}. Moving never records a decision."""
    app = access.get_for_actor(actor, m.LendingApplication, application_id, CHANGE)
    lending.move_application(request, actor, app, json_body(request))
    ctx = s.Ctx(actor)
    row = sv.application_queryset(m.LendingApplication.objects).get(pk=app.pk)
    sv.prepare_applications(ctx, [row])
    return ok(sv.application_json(ctx, row))


@lending_endpoint(["POST"])
def application_decision(request, actor: Actor, application_id):
    """Owners, admins, managers: {"decision": approved|conditional|declined|"", "note",
    "confirm": true}. A person's decision, recorded; never automatic."""
    app = access.get_for_actor(actor, m.LendingApplication, application_id, CHANGE)
    lending.record_decision(request, actor, app, json_body(request))
    return ok(_app_detail(request, actor, app))


@lending_endpoint(["GET"])
def application_history(request, actor: Actor, application_id):
    app = access.get_for_actor(actor, m.LendingApplication, application_id)
    qs = access.for_actor(actor, m.LendingStageHistory).filter(application=app).select_related("created_by").order_by("-created_at")
    return paginated(request, qs, sv.lending_history_json)


@lending_endpoint(["GET", "POST"])
def application_notes(request, actor: Actor, application_id):
    app = access.get_for_actor(actor, m.LendingApplication, application_id)
    ctx = s.Ctx(actor)
    if request.method == "POST":
        note = lending.create_note(request, actor, app, json_body(request))
        return created(sv.note_json(ctx, note))
    qs = access.for_actor(actor, m.ApplicationNote).filter(application=app).select_related("created_by").order_by("-created_at")
    return paginated(request, qs, lambda n: sv.note_json(ctx, n))


@lending_endpoint(["PATCH", "DELETE"])
def application_note_detail(request, actor: Actor, note_id):
    note = access.get_for_actor(actor, m.ApplicationNote, note_id, CHANGE if request.method == "PATCH" else DELETE)
    if request.method == "DELETE":
        services.delete_record(request, actor, note)
        return no_content()
    return ok(sv.note_json(s.Ctx(actor), lending.update_note(request, actor, note, json_body(request))))


@lending_endpoint(["POST"])
def application_checklist(request, actor: Actor, application_id):
    """Adds a checklist item: {name, description?, required?, due_date?, internal_note?}."""
    app = access.get_for_actor(actor, m.LendingApplication, application_id, CHANGE)
    item = lending.add_checklist_item(request, actor, app, json_body(request))
    return created(sv.checklist_item_json(s.Ctx(actor), item))


@lending_endpoint(["POST"])
def application_apply_template(request, actor: Actor, application_id):
    app = access.get_for_actor(actor, m.LendingApplication, application_id, CHANGE)
    lending.apply_checklist_template(request, actor, app, json_body(request))
    return ok(_app_detail(request, actor, app))


@lending_endpoint(["POST"])
def application_deadline_template(request, actor: Actor, application_id):
    app = access.get_for_actor(actor, m.LendingApplication, application_id, CHANGE)
    body = json_body(request)
    if isinstance(body, dict):
        body.setdefault("template", "lending")
    rows = realestate.apply_deadline_template(request, actor, body, application=app)
    ctx = s.Ctx(actor)
    return created([sv.milestone_json(ctx, ms) for ms in rows])


@lending_endpoint(["PATCH", "DELETE"])
def checklist_item_detail(request, actor: Actor, item_id):
    item = access.get_for_actor(actor, m.DocumentChecklistItem, item_id, CHANGE if request.method == "PATCH" else DELETE)
    if request.method == "DELETE":
        services.delete_record(request, actor, item)
        return no_content()
    lending.update_checklist_item(request, actor, item, json_body(request))
    return ok(sv.checklist_item_json(s.Ctx(actor), item))


@lending_endpoint(["POST"])
def checklist_item_request(request, actor: Actor, item_id):
    """"Request document": {due_date?, assignee_id?, note?}. Creates a private task and marks
    the item requested. Sending the request to the borrower is not possible yet."""
    item = access.get_for_actor(actor, m.DocumentChecklistItem, item_id, CHANGE)
    item, task = lending.request_document(request, actor, item, json_body(request))
    ctx = s.Ctx(actor)
    return ok({"item": sv.checklist_item_json(ctx, item), "task": s.task(ctx, s.task_queryset(m.Task.objects).get(pk=task.pk)),
               "sent_to_borrower": False,
               "notice": "A task was created for your team. Nexus can't send the request to the borrower yet: contact them the usual way."})


@lending_endpoint(["GET", "POST"])
def application_documents(request, actor: Actor, application_id):
    """GET: document metadata. POST: upload one document as the raw request body, with the
    file's own ``Content-Type`` and its name in ``X-Nexus-Filename`` (percent-encoded);
    ``?checklist_item=<id>`` attaches it to a checklist item. Encrypted before it is stored;
    never virus-scanned in this build."""
    if request.method == "GET":
        app = access.get_for_actor(actor, m.LendingApplication, application_id)
        qs = access.for_actor(actor, m.SecureDocument).filter(application=app).select_related("created_by").order_by("-created_at")
        return paginated(request, qs, sv.document_json)
    app = access.get_for_actor(actor, m.LendingApplication, application_id, CHANGE)
    item = None
    item_id = query_param(request, "checklist_item", F.uuid())
    if item_id:
        item = access.resolve_one(actor, m.DocumentChecklistItem, str(item_id), field_name="checklist_item", action=CHANGE)
    limit = documents.max_bytes()
    declared = int(request.META.get("CONTENT_LENGTH") or 0)
    if declared > limit:
        raise PayloadTooLarge(f"Documents can be at most {limit // (1024 * 1024)} MB.")
    data = request.read(limit + 1)  # straight from the request stream into memory: never a temporary file
    if len(data) > limit:
        raise PayloadTooLarge(f"Documents can be at most {limit // (1024 * 1024)} MB.")
    filename = urllib.parse.unquote(request.META.get("HTTP_X_NEXUS_FILENAME", ""))[:400]
    doc = lending.upload_document(request, actor, app, data=data, content_type=request.META.get("CONTENT_TYPE", ""), filename=filename,
                                  checklist_item=item)
    del data
    return created(sv.document_json(doc))


@lending_endpoint(["DELETE"])
def document_detail(request, actor: Actor, document_id):
    doc = access.get_for_actor(actor, m.SecureDocument, document_id, DELETE)
    lending.delete_document(request, actor, doc)
    return no_content()


@lending_endpoint(["POST"])
def document_download_token(request, actor: Actor, document_id):
    """A single-use token valid for ``NEXUS_DOCUMENT_TOKEN_SECONDS`` for this user and
    document. Redeem it with POST .../lending/documents/download."""
    doc = access.get_for_actor(actor, m.SecureDocument, document_id)
    return created(lending.issue_download(request, actor, doc))


@lending_endpoint(["POST"])
def document_download(request, actor: Actor):
    """Body: {"token"}. Re-checks access, decrypts and returns the file as an attachment.
    The token travels in the body (never in a URL, so it can't end up in access logs)."""
    data = validate(json_body(request), {"token": F.string(max_length=600, required=True, blank=False)})
    try:
        doc, plaintext = lending.redeem_download(request, actor, data["token"])
    except lending.DownloadRefused as exc:
        # Answer without raising, so the refusal's audit and access-log entries are committed.
        return error_response(exc, request)
    except Http404:
        return error_response(NotFound(), request)
    response = HttpResponse(plaintext, content_type=doc.content_type)
    quoted = urllib.parse.quote(doc.original_name)
    response["Content-Disposition"] = f"attachment; filename*=UTF-8''{quoted}"
    response["Cache-Control"] = "no-store"
    response["X-Content-Type-Options"] = "nosniff"
    response["Content-Security-Policy"] = "sandbox; default-src 'none'"
    response["Content-Length"] = str(len(plaintext))
    return response


@lending_endpoint(["GET"])
def application_access_log(request, actor: Actor, application_id):
    """Managers: who uploaded, downloaded, was refused or deleted which document."""
    app = access.get_for_actor(actor, m.LendingApplication, application_id)
    return paginated(request, lending.access_log(actor, app), sv.access_log_json)


@lending_endpoint(["GET", "POST"])
def checklist_templates(request, actor: Actor):
    access.require(actor, Cap.LENDING_ACCESS)
    if request.method == "POST":
        return created(sv.template_json(lending.create_template(request, actor, json_body(request))))
    lending.ensure_default_templates(actor.workspace)
    qs = access.for_actor(actor, m.ChecklistTemplate)
    if not query_bool(request, "include_archived", False):
        qs = qs.filter(archived=False)
    return paginated(request, qs.order_by("product_type", "name", "pk"), sv.template_json, default_limit=100)


@lending_endpoint(["PATCH", "DELETE"])
def checklist_template_detail(request, actor: Actor, template_id):
    t = access.get_for_actor(actor, m.ChecklistTemplate, template_id, CHANGE if request.method == "PATCH" else DELETE)
    if request.method == "DELETE":
        services.delete_record(request, actor, t)
        return no_content()
    return ok(sv.template_json(lending.update_template(request, actor, t, json_body(request))))


# --- meetings: notes and action items --------------------------------------------------------------------------


@crm_endpoint(["GET"])
def upcoming_meetings(request, actor: Actor):
    """Scheduled events from now on. Filters: days (1-60, default 14), scope (mine [default]
    | team)."""
    days = int(query_param(request, "days", F.choice([str(i) for i in range(1, 61)]), default="14"))
    mine = query_param(request, "scope", F.choice(["mine", "team"]), default="mine") == "mine"
    ctx = s.Ctx(actor)
    rows = list(s.event_queryset(m.CalendarEvent.objects.filter(pk__in=[e.pk for e in meetings.upcoming_meetings(actor, days=days, mine=mine)]))
                .order_by("start_at"))
    s.prepare_events(ctx, rows)
    counts = {r["event_id"]: r["n"] for r in access.for_actor(actor, m.MeetingNote).filter(event__in=[e.pk for e in rows])
              .values("event_id").annotate(n=Count("pk"))}
    return ok([{**s.event(ctx, e), "note_count": counts.get(e.pk, 0)} for e in rows])


@crm_endpoint(["GET", "POST"])
def meeting_notes(request, actor: Actor):
    """GET filters: event, contact, opportunity."""
    ctx = s.Ctx(actor)
    if request.method == "POST":
        n = meetings.create_meeting_note(request, actor, json_body(request))
        return created(sv.meeting_note_json(ctx, n))
    qs = access.for_actor(actor, m.MeetingNote)
    for name, model in (("event", m.CalendarEvent), ("contact", m.Contact), ("opportunity", m.Opportunity)):
        val = query_param(request, name, F.uuid())
        if val:
            qs = qs.filter(**{name: access.resolve_one(actor, model, str(val), field_name=name)})
    qs = qs.select_related("event", "contact", "opportunity", "created_by").order_by("-created_at", "pk")
    return paginated(request, qs, lambda n: sv.meeting_note_json(ctx, n))


@crm_endpoint(["GET", "PATCH", "DELETE"])
def meeting_note_detail(request, actor: Actor, note_id):
    ctx = s.Ctx(actor)
    if request.method == "GET":
        return ok(sv.meeting_note_json(ctx, access.get_for_actor(actor, m.MeetingNote, note_id)))
    n = access.get_for_actor(actor, m.MeetingNote, note_id, CHANGE if request.method == "PATCH" else DELETE)
    if request.method == "DELETE":
        services.delete_record(request, actor, n)
        return no_content()
    return ok(sv.meeting_note_json(ctx, meetings.update_meeting_note(request, actor, n, json_body(request))))


@crm_endpoint(["GET", "POST"])
def action_items(request, actor: Actor):
    """GET filters: status (proposed [default] | confirmed | dismissed | all), event, note,
    mine (bool: suggested for me or proposed by me)."""
    ctx = s.Ctx(actor)
    if request.method == "POST":
        item = meetings.propose_action_item(request, actor, json_body(request))
        return created(sv.action_item_json(ctx, item))
    qs = access.for_actor(actor, m.ActionItem)
    status = query_param(request, "status", F.choice(m.ActionItem.Status.values + ["all"]), default="proposed")
    if status != "all":
        qs = qs.filter(status=status)
    for name, model in (("event", m.CalendarEvent), ("note", m.MeetingNote)):
        val = query_param(request, name, F.uuid())
        if val:
            qs = qs.filter(**{name: access.resolve_one(actor, model, str(val), field_name=name)})
    if query_bool(request, "mine", False):
        qs = qs.filter(Q(suggested_assignee=actor.user) | Q(created_by=actor.user))
    qs = qs.select_related("event", "contact", "opportunity", "created_by", "suggested_assignee", "decided_by").order_by("-created_at", "pk")
    return paginated(request, qs, lambda a: sv.action_item_json(ctx, a))


@crm_endpoint(["PATCH", "DELETE"])
def action_item_detail(request, actor: Actor, item_id):
    item = access.get_for_actor(actor, m.ActionItem, item_id, CHANGE if request.method == "PATCH" else DELETE)
    if request.method == "DELETE":
        services.delete_record(request, actor, item)
        return no_content()
    return ok(sv.action_item_json(s.Ctx(actor), meetings.update_action_item(request, actor, item, json_body(request))))


@crm_endpoint(["POST"])
def action_item_confirm(request, actor: Actor, item_id):
    """A person confirms a suggested next step: {title?, assignee_id?, due_at?, priority?}.
    Returns the item and the task it became."""
    item = access.get_for_actor(actor, m.ActionItem, item_id)
    item, task = meetings.confirm_action_item(request, actor, item, json_body(request))
    ctx = s.Ctx(actor)
    return ok({"item": sv.action_item_json(ctx, item), "task": s.task(ctx, s.task_queryset(m.Task.objects).get(pk=task.pk))})


@crm_endpoint(["POST"])
def action_item_dismiss(request, actor: Actor, item_id):
    item = access.get_for_actor(actor, m.ActionItem, item_id)
    return ok(sv.action_item_json(s.Ctx(actor), meetings.dismiss_action_item(request, actor, item)))


# --- reports --------------------------------------------------------------------------------------------------


def _reports(actor: Actor) -> None:
    access.require(actor, Cap.REPORTS_VIEW, "Reports are for owners, admins and managers.")


def _days(request, default: int = 30) -> int:
    raw = query_param(request, "days", F.choice(["7", "14", "30", "60", "90"]), default=str(default))
    return int(raw)


@crm_endpoint(["GET"])
def report_pipeline(request, actor: Actor):
    """Filters: pipeline (default: the default sales/real-estate pipeline)."""
    _reports(actor)
    pid = query_param(request, "pipeline", F.uuid())
    pipeline = access.resolve_one(actor, m.Pipeline, str(pid), field_name="pipeline") if pid else None
    return ok(reports.pipeline_report(actor, pipeline))


@crm_endpoint(["GET"])
def report_team_week(request, actor: Actor):
    _reports(actor)
    return ok(reports.team_week(actor))


@crm_endpoint(["GET"])
def report_activity(request, actor: Actor):
    _reports(actor)
    return ok(reports.activity_report(actor, _days(request)))


@crm_endpoint(["GET"])
def report_tasks(request, actor: Actor):
    _reports(actor)
    return ok(reports.task_report(actor, _days(request)))


@crm_endpoint(["GET"])
def report_lending(request, actor: Actor):
    _reports(actor)
    if not actor.features.get("lending"):
        return ok({"available": False})
    return ok(reports.lending_report(actor))


@crm_endpoint(["GET"])
def report_deadlines(request, actor: Actor):
    _reports(actor)
    return ok(reports.deadlines_report(actor, _days(request, 14)))
