"""JSON API of business records: /api/v1/workspaces/<workspace_id>/crm/...

Every view is wrapped by ``@api_endpoint`` (bearer auth, scopes, rate limits, tenancy,
the ``crm`` feature, error format) and reads/writes only through ``access`` and
``services``. Lists are paginated (``?limit=&cursor=``); filters are documented on each view
and in docs/nexus/ARCHITECTURE.md.
"""

from __future__ import annotations

import datetime as dt

from django.db.models import Case, Count, IntegerField, Q, Sum, Value, When
from django.utils import timezone

from apps.api.decorators import api_endpoint
from apps.api.errors import ValidationFailed
from apps.api.http import created, json_body, no_content, ok, paginated
from apps.api.schema import F, query_bool, query_param

from . import access, services
from . import models as m
from . import serializers as s
from .access import CHANGE, DELETE, Actor, Cap
from .home import home_extras

crm_endpoint = lambda methods: api_endpoint(methods=methods, feature="crm")  # noqa: E731


def _user_filter(actor: Actor, request, name: str):
    """``?owner=me`` or ``?owner=<public_id>`` -> user (or ValidationFailed)."""
    raw = request.GET.get(name)
    if not raw:
        return None
    if raw == "me":
        return actor.user
    users = access.resolve_members(actor, [raw], field_name=name)
    return users[0]


def _search(qs, q: str, fields: list[str]):
    cond = Q()
    for term in q.split()[:5]:
        part = Q()
        for f in fields:
            part |= Q(**{f"{f}__icontains": term})
        cond &= part
    return qs.filter(cond)


Q_FIELD = F.string(max_length=100)
PRIORITY_RANK = Case(
    When(priority=m.Priority.URGENT, then=Value(0)),
    When(priority=m.Priority.HIGH, then=Value(1)),
    When(priority=m.Priority.NORMAL, then=Value(2)),
    default=Value(3),
    output_field=IntegerField(),
)


# --- contacts ---------------------------------------------------------------------------

CONTACT_SORTS = {
    "updated": "-updated_at", "-updated": "updated_at", "name": "last_name", "created": "-created_at",
    "follow_up": "follow_up_at", "last_activity": "-last_activity_at",
}


@crm_endpoint(["GET", "POST"])
def contacts(request, actor: Actor):
    """GET filters: q, kind, role, owner (me|id), assignee (me|id), tag (id), priority,
    visibility, follow_up (overdue|today|upcoming|none), archived (bool, default false),
    sort (updated, name, created, follow_up, last_activity)."""
    if request.method == "POST":
        c = services.create_contact(request, actor, json_body(request))
        ctx = s.Ctx(actor)
        return created(s.contact(ctx, s.contact_queryset(m.Contact.objects).get(pk=c.pk)))
    qs = access.for_actor(actor, m.Contact)
    q = query_param(request, "q", Q_FIELD)
    if q:
        qs = _search(qs, q, ["first_name", "last_name", "company", "email", "phone"])
    kind = query_param(request, "kind", F.choice(m.Contact.Kind.values))
    if kind:
        qs = qs.filter(kind=kind)
    role = query_param(request, "role", F.choice(m.Contact.Role.values))
    if role:
        qs = qs.filter(roles__contains=[role])
    owner = _user_filter(actor, request, "owner")
    if owner:
        qs = qs.filter(owner=owner)
    assignee = _user_filter(actor, request, "assignee")
    if assignee:
        qs = qs.filter(pk__in=m.Contact.assignees.through.objects.filter(user_id=assignee.pk).values("contact_id"))
    tag_id = query_param(request, "tag", F.uuid())
    if tag_id:
        tag = access.resolve_one(actor, m.Tag, str(tag_id), field_name="tag")
        qs = qs.filter(tags=tag)
    priority = query_param(request, "priority", F.choice(m.Priority.values))
    if priority:
        qs = qs.filter(priority=priority)
    visibility = query_param(request, "visibility", F.choice(m.Visibility.values))
    if visibility:
        qs = qs.filter(visibility=visibility)
    now = timezone.now()
    follow = query_param(request, "follow_up", F.choice(["overdue", "today", "upcoming", "none"]))
    if follow == "overdue":
        qs = qs.filter(follow_up_at__lt=now)
    elif follow == "today":
        start = now.replace(hour=0, minute=0, second=0, microsecond=0)
        qs = qs.filter(follow_up_at__gte=start, follow_up_at__lt=start + dt.timedelta(days=1))
    elif follow == "upcoming":
        qs = qs.filter(follow_up_at__gte=now)
    elif follow == "none":
        qs = qs.filter(follow_up_at__isnull=True)
    archived = query_bool(request, "archived", False)
    qs = qs.filter(archived_at__isnull=not archived)
    sort = query_param(request, "sort", F.choice(list(CONTACT_SORTS)), default="updated")
    order = CONTACT_SORTS[sort]
    if sort == "name":
        qs = qs.order_by("last_name", "first_name", "company", "pk")
    elif sort == "follow_up":
        qs = qs.order_by(F_nulls_last("follow_up_at"), "pk")
    elif sort == "last_activity":
        qs = qs.order_by(F_nulls_last("last_activity_at", desc=True), "pk")
    else:
        qs = qs.order_by(order, "pk")
    ctx = s.Ctx(actor)
    return paginated(request, s.contact_queryset(qs), lambda c: s.contact(ctx, c), prepare=lambda rows: s.prepare_contacts(ctx, rows))


def F_nulls_last(field: str, desc: bool = False):
    from django.db.models import F as DbF

    expr = DbF(field)
    return expr.desc(nulls_last=True) if desc else expr.asc(nulls_last=True)


@crm_endpoint(["GET", "PATCH", "DELETE"])
def contact_detail(request, actor: Actor, contact_id):
    if request.method == "GET":
        c = access.get_for_actor(actor, m.Contact, contact_id, queryset=s.contact_queryset(access.for_actor(actor, m.Contact)))
        access.audit_read(request, actor, c, reason="contact_detail")
        ctx = s.Ctx(actor)
        return ok(s.contact(ctx, c))
    if request.method == "DELETE":
        c = access.get_for_actor(actor, m.Contact, contact_id, DELETE)
        services.delete_record(request, actor, c)
        return no_content()
    c = access.get_for_actor(actor, m.Contact, contact_id, CHANGE)
    services.update_contact(request, actor, c, json_body(request))
    ctx = s.Ctx(actor)
    return ok(s.contact(ctx, s.contact_queryset(m.Contact.objects).get(pk=c.pk)))


def _open_tasks(actor: Actor, **filters):
    return (
        access.for_actor(actor, m.Task)
        .filter(status__in=[m.Task.Status.OPEN, m.Task.Status.IN_PROGRESS], **filters)
        .order_by(F_nulls_last("due_at"), "created_at")
    )


@crm_endpoint(["GET"])
def contact_summary(request, actor: Actor, contact_id):
    """Compact view for the room side panel: the contact, open tasks, the next event,
    the latest timeline entry and open opportunities."""
    c = access.get_for_actor(actor, m.Contact, contact_id, queryset=s.contact_queryset(access.for_actor(actor, m.Contact)))
    ctx = s.Ctx(actor)
    now = timezone.now()
    tasks = list(s.task_queryset(_open_tasks(actor, contact=c))[:5])
    s.prepare_tasks(ctx, tasks)
    events = access.for_actor(actor, m.CalendarEvent).filter(
        Q(contact=c) | Q(attendee_contacts=c), end_at__gte=now, status=m.CalendarEvent.Status.SCHEDULED
    ).distinct().order_by("start_at")
    next_event = s.event_queryset(events).first()
    last = s.activity_queryset(access.for_actor(actor, m.Activity).filter(contact=c)).first()
    opps = list(s.opportunity_queryset(access.for_actor(actor, m.Opportunity).filter(contacts=c, status=m.Opportunity.Status.OPEN))[:5])
    s.prepare_opportunities(ctx, opps)
    return ok(
        {
            "contact": s.contact(ctx, c),
            "open_tasks": [s.task(ctx, t, now=now) for t in tasks],
            "open_task_count": _open_tasks(actor, contact=c).count(),
            "next_event": s.event(ctx, next_event) if next_event else None,
            "last_activity": s.activity(ctx, last) if last else None,
            "open_opportunities": [s.opportunity(ctx, o) for o in opps],
        }
    )


# --- tags & custom fields ------------------------------------------------------------------------


@crm_endpoint(["GET", "POST"])
def tags(request, actor: Actor):
    if request.method == "POST":
        return created(s.tag(services.create_tag(request, actor, json_body(request))))
    qs = access.for_actor(actor, m.Tag).annotate(n=Count("contacts")).order_by("name")
    return paginated(request, qs, lambda t: {**s.tag(t), "contact_count": t.n}, default_limit=200)


@crm_endpoint(["PATCH", "DELETE"])
def tag_detail(request, actor: Actor, tag_id):
    t = access.get_for_actor(actor, m.Tag, tag_id, CHANGE if request.method == "PATCH" else DELETE)
    if request.method == "DELETE":
        services.delete_record(request, actor, t)
        return no_content()
    return ok(s.tag(services.update_tag(request, actor, t, json_body(request))))


@crm_endpoint(["GET", "POST"])
def field_definitions(request, actor: Actor):
    if request.method == "POST":
        return created(s.field_definition(services.create_field_definition(request, actor, json_body(request))))
    qs = access.for_actor(actor, m.FieldDefinition)
    entity = query_param(request, "entity", F.choice(m.FieldDefinition.Entity.values))
    if entity:
        qs = qs.filter(entity=entity)
    if not query_bool(request, "include_archived", False):
        qs = qs.filter(archived=False)
    return paginated(request, qs.order_by("entity", "position", "label"), s.field_definition, default_limit=200)


@crm_endpoint(["PATCH", "DELETE"])
def field_definition_detail(request, actor: Actor, field_id):
    f = access.get_for_actor(actor, m.FieldDefinition, field_id, CHANGE if request.method == "PATCH" else DELETE)
    if request.method == "DELETE":
        services.delete_record(request, actor, f)
        return no_content()
    return ok(s.field_definition(services.update_field_definition(request, actor, f, json_body(request))))


# --- pipelines -------------------------------------------------------------------------------------


@crm_endpoint(["GET", "POST"])
def pipelines(request, actor: Actor):
    if request.method == "POST":
        p = services.create_pipeline(request, actor, json_body(request))
        return created(s.pipeline(p))
    qs = access.for_actor(actor, m.Pipeline).prefetch_related("stages")
    if not query_bool(request, "include_archived", False):
        qs = qs.filter(archived=False)
    return paginated(request, qs.order_by("position", "name"), s.pipeline, default_limit=100)


@crm_endpoint(["GET", "PATCH", "DELETE"])
def pipeline_detail(request, actor: Actor, pipeline_id):
    if request.method == "GET":
        return ok(s.pipeline(access.get_for_actor(actor, m.Pipeline, pipeline_id)))
    p = access.get_for_actor(actor, m.Pipeline, pipeline_id, CHANGE if request.method == "PATCH" else DELETE)
    if request.method == "DELETE":
        services.delete_pipeline(request, actor, p)
        return no_content()
    return ok(s.pipeline(services.update_pipeline(request, actor, p, json_body(request))))


@crm_endpoint(["GET"])
def pipeline_board(request, actor: Actor, pipeline_id):
    """The kanban: stages in order, each with its visible opportunities (top 200 per
    stage), count and value total. Filters: owner (me|id), q."""
    p = access.get_for_actor(actor, m.Pipeline, pipeline_id)
    stages = list(p.stages.order_by("position", "created_at"))
    qs = access.for_actor(actor, m.Opportunity).filter(pipeline=p)
    owner = _user_filter(actor, request, "owner")
    if owner:
        qs = qs.filter(owner=owner)
    q = query_param(request, "q", Q_FIELD)
    if q:
        matching = _search(m.Opportunity.objects.filter(pipeline=p), q, ["name", "contacts__first_name", "contacts__last_name", "contacts__company"])
        qs = qs.filter(pk__in=matching.values("pk"))
    totals = {row["stage_id"]: row for row in qs.values("stage_id").annotate(n=Count("pk"), total=Sum("value"))}
    ctx = s.Ctx(actor)
    columns = []
    for st in stages:
        rows = list(s.opportunity_queryset(qs.filter(stage=st)).order_by("position", "-updated_at")[:200])
        s.prepare_opportunities(ctx, rows)
        t = totals.get(st.pk, {})
        columns.append({"stage": s.stage(st), "count": t.get("n", 0), "total_value": s.money(t.get("total")) or "0.00",
                        "opportunities": [s.opportunity(ctx, o) for o in rows]})
    return ok({"pipeline": s.pipeline(p, stages=stages), "columns": columns,
               "can_configure": actor.can(Cap.CRM_CONFIGURE), "can_create": actor.can(Cap.RECORDS_CREATE)})


@crm_endpoint(["POST"])
def pipeline_stages(request, actor: Actor, pipeline_id):
    p = access.get_for_actor(actor, m.Pipeline, pipeline_id, CHANGE)
    return created(s.stage(services.create_stage(request, actor, p, json_body(request))))


@crm_endpoint(["POST"])
def pipeline_stage_order(request, actor: Actor, pipeline_id):
    p = access.get_for_actor(actor, m.Pipeline, pipeline_id, CHANGE)
    services.reorder_stages(request, actor, p, json_body(request))
    return ok(s.pipeline(m.Pipeline.objects.prefetch_related("stages").get(pk=p.pk)))


@crm_endpoint(["PATCH", "DELETE"])
def stage_detail(request, actor: Actor, stage_id):
    st = access.get_for_actor(actor, m.Stage, stage_id, CHANGE if request.method == "PATCH" else DELETE)
    if request.method == "DELETE":
        services.delete_stage(request, actor, st)
        return no_content()
    return ok(s.stage(services.update_stage(request, actor, st, json_body(request))))


# --- opportunities -----------------------------------------------------------------------------------


@crm_endpoint(["GET", "POST"])
def opportunities(request, actor: Actor):
    """GET filters: q, pipeline, stage, status (open|won|lost), owner (me|id), contact."""
    if request.method == "POST":
        o = services.create_opportunity(request, actor, json_body(request))
        ctx = s.Ctx(actor)
        return created(s.opportunity(ctx, s.opportunity_queryset(m.Opportunity.objects).get(pk=o.pk)))
    qs = access.for_actor(actor, m.Opportunity)
    q = query_param(request, "q", Q_FIELD)
    if q:
        qs = _search(qs, q, ["name"])
    for name, fld in (("pipeline", "pipeline"), ("stage", "stage")):
        val = query_param(request, name, F.uuid())
        if val:
            model = m.Pipeline if name == "pipeline" else m.Stage
            qs = qs.filter(**{fld: access.resolve_one(actor, model, str(val), field_name=name)})
    status = query_param(request, "status", F.choice(m.Opportunity.Status.values))
    if status:
        qs = qs.filter(status=status)
    owner = _user_filter(actor, request, "owner")
    if owner:
        qs = qs.filter(owner=owner)
    contact_id = query_param(request, "contact", F.uuid())
    if contact_id:
        qs = qs.filter(contacts=access.resolve_one(actor, m.Contact, str(contact_id), field_name="contact"))
    ctx = s.Ctx(actor)
    return paginated(request, s.opportunity_queryset(qs.order_by("-updated_at", "pk")), lambda o: s.opportunity(ctx, o),
                     prepare=lambda rows: s.prepare_opportunities(ctx, rows))


@crm_endpoint(["GET", "PATCH", "DELETE"])
def opportunity_detail(request, actor: Actor, opportunity_id):
    ctx = s.Ctx(actor)
    if request.method == "GET":
        o = access.get_for_actor(actor, m.Opportunity, opportunity_id, queryset=s.opportunity_queryset(access.for_actor(actor, m.Opportunity)))
        s.prepare_opportunities(ctx, [o])
        return ok(s.opportunity(ctx, o))
    if request.method == "DELETE":
        services.delete_record(request, actor, access.get_for_actor(actor, m.Opportunity, opportunity_id, DELETE))
        return no_content()
    o = access.get_for_actor(actor, m.Opportunity, opportunity_id, CHANGE)
    services.update_opportunity(request, actor, o, json_body(request))
    return ok(s.opportunity(ctx, s.opportunity_queryset(m.Opportunity.objects).get(pk=o.pk)))


@crm_endpoint(["POST"])
def opportunity_move(request, actor: Actor, opportunity_id):
    """Body: {"stage_id": ..., "index": 0-based position in the stage (optional)}."""
    o = access.get_for_actor(actor, m.Opportunity, opportunity_id, CHANGE)
    services.move_opportunity(request, actor, o, json_body(request))
    ctx = s.Ctx(actor)
    return ok(s.opportunity(ctx, s.opportunity_queryset(m.Opportunity.objects).get(pk=o.pk)))


@crm_endpoint(["GET"])
def opportunity_history(request, actor: Actor, opportunity_id):
    o = access.get_for_actor(actor, m.Opportunity, opportunity_id)
    qs = access.for_actor(actor, m.StageHistory).filter(opportunity=o).select_related("created_by").order_by("-created_at")
    return paginated(request, qs, s.stage_history)


# --- tasks ---------------------------------------------------------------------------------------------


@crm_endpoint(["GET", "POST"])
def tasks(request, actor: Actor):
    """GET filters: scope (mine [default] | team | created), status (open [default] |
    done | all), due (overdue|today|week|none), assignee (me|id), contact, opportunity, q."""
    if request.method == "POST":
        t = services.create_task(request, actor, json_body(request))
        ctx = s.Ctx(actor)
        return created(s.task(ctx, s.task_queryset(m.Task.objects).get(pk=t.pk)))
    qs = access.for_actor(actor, m.Task)
    scope = query_param(request, "scope", F.choice(["mine", "team", "created"]), default="mine")
    if scope == "mine":
        qs = qs.filter(assignee=actor.user)
    elif scope == "created":
        qs = qs.filter(created_by=actor.user)
    status = query_param(request, "status", F.choice(["open", "done", "canceled", "all"]), default="open")
    if status == "open":
        qs = qs.filter(status__in=[m.Task.Status.OPEN, m.Task.Status.IN_PROGRESS])
    elif status in {"done", "canceled"}:
        qs = qs.filter(status=status)
    now = timezone.now()
    start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    due = query_param(request, "due", F.choice(["overdue", "today", "week", "none"]))
    if due == "overdue":
        qs = qs.filter(due_at__lt=now)
    elif due == "today":
        qs = qs.filter(due_at__gte=start, due_at__lt=start + dt.timedelta(days=1))
    elif due == "week":
        qs = qs.filter(due_at__gte=start, due_at__lt=start + dt.timedelta(days=7))
    elif due == "none":
        qs = qs.filter(due_at__isnull=True)
    assignee = _user_filter(actor, request, "assignee")
    if assignee:
        qs = qs.filter(assignee=assignee)
    for name, model in (("contact", m.Contact), ("opportunity", m.Opportunity)):
        val = query_param(request, name, F.uuid())
        if val:
            qs = qs.filter(**{name: access.resolve_one(actor, model, str(val), field_name=name)})
    q = query_param(request, "q", Q_FIELD)
    if q:
        qs = _search(qs, q, ["title", "description"])
    qs = qs.order_by(F_nulls_last("due_at"), PRIORITY_RANK, "created_at", "pk")
    ctx = s.Ctx(actor)
    return paginated(request, s.task_queryset(qs), lambda t: s.task(ctx, t, now=now), prepare=lambda rows: s.prepare_tasks(ctx, rows))


@crm_endpoint(["GET", "PATCH", "DELETE"])
def task_detail(request, actor: Actor, task_id):
    ctx = s.Ctx(actor)
    if request.method == "GET":
        t = access.get_for_actor(actor, m.Task, task_id, queryset=s.task_queryset(access.for_actor(actor, m.Task)))
        s.prepare_tasks(ctx, [t])
        return ok(s.task(ctx, t))
    if request.method == "DELETE":
        services.delete_record(request, actor, access.get_for_actor(actor, m.Task, task_id, DELETE))
        return no_content()
    t = access.get_for_actor(actor, m.Task, task_id, CHANGE)
    services.update_task(request, actor, t, json_body(request))
    return ok(s.task(ctx, s.task_queryset(m.Task.objects).get(pk=t.pk)))


# --- activities (timeline) -------------------------------------------------------------------------------


@crm_endpoint(["GET", "POST"])
def activities(request, actor: Actor):
    """GET filters: contact, opportunity, task, kind, before (date-time), q. Newest first."""
    if request.method == "POST":
        a = services.create_activity(request, actor, json_body(request))
        ctx = s.Ctx(actor)
        return created(s.activity(ctx, s.activity_queryset(m.Activity.objects).get(pk=a.pk)))
    qs = access.for_actor(actor, m.Activity)
    for name, model in (("contact", m.Contact), ("opportunity", m.Opportunity), ("task", m.Task)):
        val = query_param(request, name, F.uuid())
        if val:
            qs = qs.filter(**{name: access.resolve_one(actor, model, str(val), field_name=name)})
    kind = query_param(request, "kind", F.choice(m.Activity.Kind.values))
    if kind:
        qs = qs.filter(kind=kind)
    before = query_param(request, "before", F.datetime())
    if before:
        qs = qs.filter(occurred_at__lt=before)
    q = query_param(request, "q", Q_FIELD)
    if q:
        qs = _search(qs, q, ["summary", "body"])
    ctx = s.Ctx(actor)
    return paginated(request, s.activity_queryset(qs.order_by("-occurred_at", "-created_at", "pk")), lambda a: s.activity(ctx, a),
                     prepare=lambda rows: s.prepare_activities(ctx, rows))


@crm_endpoint(["GET", "PATCH", "DELETE"])
def activity_detail(request, actor: Actor, activity_id):
    ctx = s.Ctx(actor)
    if request.method == "GET":
        a = access.get_for_actor(actor, m.Activity, activity_id, queryset=s.activity_queryset(access.for_actor(actor, m.Activity)))
        s.prepare_activities(ctx, [a])
        return ok(s.activity(ctx, a))
    if request.method == "DELETE":
        services.delete_record(request, actor, access.get_for_actor(actor, m.Activity, activity_id, DELETE))
        return no_content()
    a = access.get_for_actor(actor, m.Activity, activity_id, CHANGE)
    services.update_activity(request, actor, a, json_body(request))
    return ok(s.activity(ctx, s.activity_queryset(m.Activity.objects).get(pk=a.pk)))


# --- calendar events -------------------------------------------------------------------------------------


@crm_endpoint(["GET", "POST"])
def events(request, actor: Actor):
    """GET filters: from, to (date-times; overlapping events), contact, opportunity,
    organizer (me|id), attending (me: organizer or attendee), status, kind."""
    if request.method == "POST":
        e = services.create_event(request, actor, json_body(request))
        ctx = s.Ctx(actor)
        return created(s.event(ctx, s.event_queryset(m.CalendarEvent.objects).get(pk=e.pk)))
    qs = access.for_actor(actor, m.CalendarEvent)
    start = query_param(request, "from", F.datetime())
    end = query_param(request, "to", F.datetime())
    if start:
        qs = qs.filter(end_at__gte=start)
    if end:
        qs = qs.filter(start_at__lt=end)
    for name, model in (("contact", m.Contact), ("opportunity", m.Opportunity)):
        val = query_param(request, name, F.uuid())
        if val:
            qs = qs.filter(**{name: access.resolve_one(actor, model, str(val), field_name=name)})
    organizer = _user_filter(actor, request, "organizer")
    if organizer:
        qs = qs.filter(organizer=organizer)
    status = query_param(request, "status", F.choice(m.CalendarEvent.Status.values))
    if status:
        qs = qs.filter(status=status)
    kind = query_param(request, "kind", F.choice(m.CalendarEvent.Kind.values))
    if kind:
        qs = qs.filter(kind=kind)
    if query_param(request, "attending", F.choice(["me"])):
        attending = m.CalendarEvent.attendee_users.through.objects.filter(user_id=actor.user.pk).values("calendarevent_id")
        qs = qs.filter(Q(organizer=actor.user) | Q(pk__in=attending))
    ctx = s.Ctx(actor)
    return paginated(request, s.event_queryset(qs.order_by("start_at", "pk")), lambda e: s.event(ctx, e),
                     prepare=lambda rows: s.prepare_events(ctx, rows))


@crm_endpoint(["GET", "PATCH", "DELETE"])
def event_detail(request, actor: Actor, event_id):
    ctx = s.Ctx(actor)
    if request.method == "GET":
        e = access.get_for_actor(actor, m.CalendarEvent, event_id, queryset=s.event_queryset(access.for_actor(actor, m.CalendarEvent)))
        s.prepare_events(ctx, [e])
        return ok(s.event(ctx, e))
    if request.method == "DELETE":
        services.delete_record(request, actor, access.get_for_actor(actor, m.CalendarEvent, event_id, DELETE))
        return no_content()
    e = access.get_for_actor(actor, m.CalendarEvent, event_id, CHANGE)
    services.update_event(request, actor, e, json_body(request))
    return ok(s.event(ctx, s.event_queryset(m.CalendarEvent.objects).get(pk=e.pk)))


# --- conversation links (room <-> record) ------------------------------------------------------------------


@crm_endpoint(["GET", "POST"])
def room_links(request, actor: Actor):
    """GET filters: room_id (Matrix room ID), contact, opportunity (at least one)."""
    if request.method == "POST":
        link = services.create_conversation_link(request, actor, json_body(request))
        return created(s.conversation_link(s.Ctx(actor), link))
    qs = access.for_actor(actor, m.ConversationLink).select_related("contact", "opportunity", "created_by")
    room_id = query_param(request, "room_id", services.room_field())
    contact_id = query_param(request, "contact", F.uuid())
    opp_id = query_param(request, "opportunity", F.uuid())
    if not (room_id or contact_id or opp_id):
        raise ValidationFailed(fields={"room_id": ["Filter by room_id, contact or opportunity."]})
    if room_id:
        qs = qs.filter(room_id=room_id)
    if contact_id:
        qs = qs.filter(contact=access.resolve_one(actor, m.Contact, str(contact_id), field_name="contact"))
    if opp_id:
        qs = qs.filter(opportunity=access.resolve_one(actor, m.Opportunity, str(opp_id), field_name="opportunity"))
    ctx = s.Ctx(actor)
    return paginated(request, qs.order_by("-created_at", "pk"), lambda link: s.conversation_link(ctx, link))


@crm_endpoint(["DELETE"])
def room_link_detail(request, actor: Actor, link_id):
    link = access.get_for_actor(actor, m.ConversationLink, link_id, DELETE)
    services.delete_record(request, actor, link)
    return no_content()


# --- external mappings (read-only) ----------------------------------------------------------------------------


@crm_endpoint(["GET"])
def mappings(request, actor: Actor):
    """Managers and up: external record mappings. Filters: provider, object_type, object_id."""
    access.require(actor, Cap.MAPPINGS_VIEW)
    qs = access.for_actor(actor, m.ExternalRecordMapping)
    provider = query_param(request, "provider", F.string(max_length=40))
    if provider:
        qs = qs.filter(provider=provider)
    otype = query_param(request, "object_type", F.string(max_length=60))
    if otype:
        qs = qs.filter(object_type=otype)
    oid = query_param(request, "object_id", F.uuid())
    if oid:
        qs = qs.filter(object_id=oid)
    return paginated(request, qs.order_by("provider", "external_id"), s.mapping)


# --- search and dashboard --------------------------------------------------------------------------------------


@crm_endpoint(["GET"])
def search(request, actor: Actor):
    """Contacts and opportunities matching ``q`` (for pickers, e.g. linking a room)."""
    q = query_param(request, "q", Q_FIELD) or ""
    if len(q) < 1:
        return ok({"contacts": [], "opportunities": []})
    ctx = s.Ctx(actor)
    contacts_qs = _search(access.for_actor(actor, m.Contact).filter(archived_at__isnull=True), q,
                          ["first_name", "last_name", "company", "email", "phone"])
    cs = list(s.contact_queryset(contacts_qs.order_by("-updated_at"))[:8])
    s.prepare_contacts(ctx, cs)
    os_ = list(s.opportunity_queryset(_search(access.for_actor(actor, m.Opportunity), q, ["name"]).order_by("-updated_at"))[:8])
    s.prepare_opportunities(ctx, os_)
    return ok({"contacts": [s.contact(ctx, c) for c in cs], "opportunities": [s.opportunity(ctx, o) for o in os_]})


@crm_endpoint(["GET"])
def dashboard(request, actor: Actor):
    """Home: today's tasks, overdue follow-ups, assigned leads, recent activity and a
    pipeline summary, all from records the actor may see. ``scope=team`` widens tasks,
    follow-ups and leads to the team (roles that can see all records)."""
    now = timezone.now()
    start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    team = query_param(request, "scope", F.choice(["mine", "team"]), default="mine") == "team"
    ctx = s.Ctx(actor)
    mine_contacts = access.for_actor(actor, m.Contact).filter(archived_at__isnull=True)
    if not team:
        assigned = m.Contact.assignees.through.objects.filter(user_id=actor.user.pk).values("contact_id")
        mine_contacts = mine_contacts.filter(Q(owner=actor.user) | Q(pk__in=assigned))
    open_tasks = _open_tasks(actor) if team else _open_tasks(actor, assignee=actor.user)
    today = list(s.task_queryset(open_tasks.filter(due_at__lt=start + dt.timedelta(days=1)))[:20])
    s.prepare_tasks(ctx, today)
    overdue_follow = list(s.contact_queryset(mine_contacts.filter(follow_up_at__lt=now).order_by("follow_up_at"))[:10])
    leads = list(s.contact_queryset(mine_contacts.filter(kind=m.Contact.Kind.LEAD).order_by("-updated_at"))[:10])
    s.prepare_contacts(ctx, overdue_follow + leads)
    recent = list(s.activity_queryset(access.for_actor(actor, m.Activity).order_by("-occurred_at", "-created_at"))[:10])
    s.prepare_activities(ctx, recent)
    pipeline = (access.for_actor(actor, m.Pipeline).filter(archived=False).exclude(kind=m.Pipeline.Kind.LENDING)
                .order_by("-is_default", "position").first())
    summary = None
    if pipeline:
        stages = list(pipeline.stages.order_by("position", "created_at"))
        opps = access.for_actor(actor, m.Opportunity).filter(pipeline=pipeline)
        agg = {r["stage_id"]: r for r in opps.values("stage_id").annotate(n=Count("pk"), total=Sum("value"))}
        summary = {
            "pipeline": {"id": str(pipeline.pk), "name": pipeline.name, "currency": pipeline.currency},
            "stages": [
                {"id": str(st.pk), "name": st.name, "is_won": st.is_won, "is_lost": st.is_lost,
                 "count": agg.get(st.pk, {}).get("n", 0), "total_value": s.money(agg.get(st.pk, {}).get("total")) or "0.00"}
                for st in stages
            ],
            "open_value": s.money(opps.filter(status=m.Opportunity.Status.OPEN).aggregate(t=Sum("value"))["t"]) or "0.00",
        }
    return ok(
        {
            "scope": "team" if team else "mine",
            "generated_at": now,
            "tasks_today": [s.task(ctx, t, now=now) for t in today],
            "overdue_task_count": open_tasks.filter(due_at__lt=now).count(),
            "overdue_follow_ups": [s.contact(ctx, c) for c in overdue_follow],
            "assigned_leads": [s.contact(ctx, c) for c in leads],
            "recent_activity": [s.activity(ctx, a) for a in recent],
            "pipeline_summary": summary,
            # Verticals team: meetings, deadlines, lending, next steps, connected services.
            **home_extras(actor, ctx, team=team, now=now),
        }
    )

