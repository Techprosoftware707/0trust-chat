"""AI tools on the vertical records (real estate, lending, meetings, reports), built on the
verticals team's services (``realestate``, ``lending``, ``meetings``, ``reports``), which
authorise through ``apps.crm.access`` with the acting person.

Lending: only application status, stages, checklist item names and due dates are returned.
Amounts, borrowers' details, internal notes and decisions are lending-sensitive and only
included when the workspace allowed sensitive data in AI context AND the person may see it
(``ctx.allow_sensitive``). Document CONTENTS are never returned by any tool; there is no
tool that records a lending decision.

Drafts are drafts: ``draft_viewing_confirmation`` returns text built only from the viewing
record. Nothing is sent and nothing is stored.
"""

from __future__ import annotations

import datetime as dt

from django.db.models import Q
from django.utils import timezone

from apps.assistant import fmt
from apps.assistant.registry import READ, WRITE, Source, Tool, ToolContext, ToolError, ToolResult, register_link
from apps.assistant.schema import BOOL, INT, NSTR, STR, Args, P, arr, nullable, obj

from . import access, lending, meetings, realestate, reports
from . import models as m
from .access import Cap

register_link("crm.property", lambda i: f"#/properties/{i}")
register_link("crm.lendingapplication", lambda i: f"#/lending/{i}")
register_link("crm.milestone", lambda i: "#/home")
register_link("crm.meetingnote", lambda i: "#/calendar")
register_link("crm.actionitem", lambda i: "#/tasks")

REF = nullable(obj(["id", "name"], id=STR, name=STR))
DOCS_NOTE = "Only checklist names and statuses are shared with AI. Document contents never are."


def _iso_date(d) -> str | None:
    return d.isoformat() if d else None


# --- lending ------------------------------------------------------------------------------------------


def _need_lending(ctx: ToolContext) -> None:
    if not ctx.actor.can(Cap.LENDING_ACCESS):
        raise ToolError("Your role doesn't include lending applications.", code="permission_denied")


def _application_brief(ctx: ToolContext, app: m.LendingApplication) -> dict:
    src = ctx.source(app, f"{app.reference} {app.title}".strip())
    progress = lending.checklist_progress(app)
    items = [{"name": it.name, "status": it.status, "due_date": _iso_date(it.due_date),
              "overdue": bool(it.due_date and it.due_date < ctx.now.date())}
             for it in app.checklist.all() if it.is_outstanding]
    out = {
        "id": str(app.pk), "type": "crm.lendingapplication", "reference": app.reference, "title": app.title, "stage": app.stage.name,
        "status": app.status, "product_type": app.product_type, "target_close_date": _iso_date(app.target_close_date),
        "loan_officer": fmt.person(app.loan_officer), "checklist": {k: progress[k] for k in ("required", "complete", "outstanding", "overdue", "percent")},
        "missing_documents": items, "url": src.url,
        "deal": {"id": str(app.opportunity_id), "name": app.opportunity.name} if app.opportunity_id and access.ref_visible(
            ctx.actor, "crm.opportunity", app.opportunity_id) else None,
    }
    if ctx.allow_sensitive:
        out["amount_requested"] = fmt.money_str(app.amount_requested)
        out["currency"] = app.currency
    return out


def _app_line(a: dict) -> str:
    names = ", ".join(f"{d['name']}{' (overdue)' if d['overdue'] else ''}" for d in a["missing_documents"][:6]) or "none"
    close = f", target close {fmt.day(dt.date.fromisoformat(a['target_close_date']))}" if a["target_close_date"] else ""
    return f"{a['reference']} “{a['title']}” ({a['stage']}{close}): {a['checklist']['outstanding']} missing — {names}."


def _missing_apps(ctx: ToolContext, limit: int):
    qs = (lending.search_applications(ctx.actor, missing_documents=True).exclude(status__in=["withdrawn", "completed"])
          .select_related("stage", "loan_officer", "opportunity").prefetch_related("checklist").order_by("target_close_date", "-updated_at"))
    return qs[:limit], qs.count()


def _apps_missing_documents(ctx: ToolContext, args: dict) -> ToolResult:
    _need_lending(ctx)
    rows, total = _missing_apps(ctx, args["limit"])
    apps = [_application_brief(ctx, a) for a in rows]
    facts = [f"{total} open application(s) are waiting on required documents."] + [_app_line(a) for a in apps]
    return ToolResult(data={"total": total, "applications": apps, "notes": [DOCS_NOTE]}, facts=facts,
                      sources=[Source("crm.lendingapplication", a["id"], f"{a['reference']} {a['title']}") for a in apps])


def _deals_waiting(ctx: ToolContext, args: dict) -> ToolResult:
    _need_lending(ctx)
    rows, total = _missing_apps(ctx, 100)
    deals: dict[str, dict] = {}
    unlinked = []
    for app in rows:
        brief = _application_brief(ctx, app)
        if brief["deal"]:
            d = deals.setdefault(brief["deal"]["id"], {"id": brief["deal"]["id"], "type": "crm.opportunity", "name": brief["deal"]["name"],
                                                        "applications": [], "missing": 0,
                                                        "url": Source("crm.opportunity", brief["deal"]["id"], "").url})
            d["applications"].append(brief)
            d["missing"] += brief["checklist"]["outstanding"]
        else:
            unlinked.append(brief)
    out = sorted(deals.values(), key=lambda d: -d["missing"])[: args["limit"]]
    facts = [f"{len(deals)} deal(s) are waiting on documents for their lending application(s)."]
    for d in out:
        facts.append(f"Deal “{d['name']}”: " + " ".join(_app_line(a) for a in d["applications"]))
    if unlinked:
        facts.append(f"{len(unlinked)} more application(s) waiting on documents aren't linked to a deal: "
                     + ", ".join(a["reference"] for a in unlinked[:10]) + ".")
    sources = [Source("crm.opportunity", d["id"], d["name"]) for d in out] + [
        Source("crm.lendingapplication", a["id"], f"{a['reference']} {a['title']}") for a in unlinked[:10]]
    return ToolResult(data={"deals": out, "unlinked_applications": unlinked[:20], "notes": [DOCS_NOTE]}, facts=facts, sources=sources)


def _application(ctx: ToolContext, args: dict) -> ToolResult:
    _need_lending(ctx)
    app = lending.visible_application(ctx.actor, args["application_id"])
    brief = _application_brief(ctx, app)
    work = [{**w, "due_date": _iso_date(w["due_date"])} for w in lending.outstanding_work(ctx.actor, app)][:30]
    facts = [_app_line(brief)] + [f"To do: {w['title']} ({w['kind'].replace('_', ' ')}{', overdue' if w['overdue'] else ''})" for w in work[:10]]
    if not ctx.allow_sensitive:
        facts.append("Amounts and borrower details are not shared with AI in this workspace.")
    return ToolResult(data={"application": brief, "outstanding_work": work, "notes": [DOCS_NOTE]}, facts=facts,
                      sources=[Source("crm.lendingapplication", brief["id"], f"{brief['reference']} {brief['title']}")])


# --- deadlines, properties, viewings ------------------------------------------------------------------


def _deadlines(ctx: ToolContext, args: dict) -> ToolResult:
    today = timezone.localdate()
    rows = realestate.approaching_deadlines(ctx.actor, days=args["days"], limit=args["limit"])
    items = []
    for ms in rows:
        ctx.touch(ms)
        parent = None
        if ms.opportunity_id:
            parent = {"type": "crm.opportunity", "id": str(ms.opportunity_id), "name": ms.opportunity.name}
        elif ms.application_id:
            parent = {"type": "crm.lendingapplication", "id": str(ms.application_id), "name": ms.application.reference}
        items.append({"id": str(ms.pk), "type": "crm.milestone", "title": ms.title, "milestone_type": ms.milestone_type,
                      "category": ms.category, "due_date": _iso_date(ms.due_date), "urgency": realestate.milestone_urgency(ms, today),
                      "responsible": fmt.person(ms.responsible), "parent": parent,
                      "url": Source(parent["type"], parent["id"], "").url if parent else Source("crm.milestone", str(ms.pk), "").url})
    overdue = sum(1 for i in items if i["urgency"] == "overdue")
    facts = [f"{len(items)} open deadline(s) in the next {args['days']} days ({overdue} overdue)."] + [
        f"{fmt.day(dt.date.fromisoformat(i['due_date']))} · {i['title']} ({i['urgency'].replace('_', ' ')})"
        + (f" — {i['parent']['name']}" if i["parent"] else "") for i in items]
    sources = [Source(i["parent"]["type"], i["parent"]["id"], i["parent"]["name"]) for i in items if i["parent"]]
    return ToolResult(data={"days": args["days"], "deadlines": items}, facts=facts, sources=sources)


def _property_brief(ctx: ToolContext, p: m.Property) -> dict:
    src = ctx.source(p, p.display_name)
    return {"id": str(p.pk), "type": "crm.property", "name": p.display_name, "address": ", ".join(x for x in [p.address_line1, p.city] if x),
            "status": p.status, "listing_type": p.listing_type, "property_type": p.property_type, "list_price": fmt.money_str(p.list_price),
            "currency": p.currency, "bedrooms": p.bedrooms, "bathrooms": str(p.bathrooms) if p.bathrooms is not None else None,
            "headline": p.headline, "source": p.source, "source_detail": p.source_detail, "url": src.url}


def _property_line(p: dict) -> str:
    price = f"{p['currency']} {p['list_price']}" if p["list_price"] else "no price"
    beds = f", {p['bedrooms']} bed" if p["bedrooms"] is not None else ""
    label = "" if p["source"] == "manual" else f" [imported: {p['source_detail'] or p['source']}]"
    return f"{p['name']} — {p['status'].replace('_', ' ')}, {price}{beds}{label}."


def _search_properties(ctx: ToolContext, args: dict) -> ToolResult:
    qs = realestate.search_properties(ctx.actor, q=args["query"], status=args["status"], city=args["city"]).order_by("-updated_at")
    total = qs.count()
    props = [_property_brief(ctx, p) for p in qs[: args["limit"]]]
    facts = [f"{total} propert{'ies' if total != 1 else 'y'} in your records match."] + [_property_line(p) for p in props]
    return ToolResult(data={"total": total, "properties": props, "notes": ["Only the workspace's own property records; no external listings."]},
                      facts=facts, sources=[Source("crm.property", p["id"], p["name"]) for p in props])


def _matching(ctx: ToolContext, args: dict) -> ToolResult:
    c = access.get_for_actor(ctx.actor, m.Contact, args["contact_id"])
    pref = realestate.get_preferences(ctx.actor, c)
    if pref is None:
        return ToolResult(data={"contact": {"id": str(c.pk), "name": c.display_name}, "preferences": None, "properties": []},
                          facts=[f"No search preferences are recorded for {c.display_name}."], sources=[ctx.source(c, c.display_name)])
    props = [_property_brief(ctx, p) for p in realestate.matching_properties(ctx.actor, pref, limit=args["limit"])]
    budget = f"{pref.currency} {fmt.money_str(pref.budget_min) or '…'}–{fmt.money_str(pref.budget_max) or '…'}"
    facts = [f"{c.display_name} is looking to {pref.listing_type} ({budget}" + (f", {pref.bedrooms_min}+ bed" if pref.bedrooms_min else "")
             + (f", in {', '.join(pref.areas[:5])}" if pref.areas else "") + ").",
             f"{len(props)} of your available properties match."] + [_property_line(p) for p in props]
    return ToolResult(data={"contact": {"id": str(c.pk), "name": c.display_name},
                            "preferences": {"listing_type": pref.listing_type, "budget_min": fmt.money_str(pref.budget_min),
                                            "budget_max": fmt.money_str(pref.budget_max), "areas": list(pref.areas or []),
                                            "bedrooms_min": pref.bedrooms_min, "property_types": list(pref.property_types or [])},
                            "properties": props}, facts=facts,
                      sources=[ctx.source(c, c.display_name)] + [Source("crm.property", p["id"], p["name"]) for p in props])


def _viewing_brief(ctx: ToolContext, e: m.CalendarEvent) -> dict:
    ctx.touch(e)
    prop = None
    if e.related_type == "crm.property" and e.related_id and access.ref_visible(ctx.actor, "crm.property", e.related_id):
        p = m.Property.objects.get(pk=e.related_id)
        prop = {"id": str(p.pk), "name": p.display_name}
    contacts = [{"id": str(c.pk), "name": c.display_name, "email": c.email}
                for c in e.attendee_contacts.all() if access.ref_visible(ctx.actor, "crm.contact", c.pk)]
    return {"id": str(e.pk), "type": "crm.calendarevent", "title": e.title, "start_at": fmt.iso(e.start_at), "end_at": fmt.iso(e.end_at),
            "location": e.location, "status": e.status, "property": prop, "contacts": contacts, "organizer": fmt.person(e.organizer)}


def _viewings(ctx: ToolContext, args: dict) -> ToolResult:
    contact = access.get_for_actor(ctx.actor, m.Contact, args["contact_id"]) if args["contact_id"] else None
    qs = realestate.viewings(ctx.actor, contact=contact)
    if args["upcoming_only"]:
        qs = qs.filter(end_at__gte=ctx.now, status=m.CalendarEvent.Status.SCHEDULED).order_by("start_at")
    rows = [_viewing_brief(ctx, e) for e in qs.prefetch_related("attendee_contacts")[: args["limit"]]]
    facts = [f"{len(rows)} viewing(s)."] + [
        f"{fmt.when(dt.datetime.fromisoformat(v['start_at']))}: {v['property']['name'] if v['property'] else v['location'] or v['title']}"
        + (f" with {', '.join(c['name'] for c in v['contacts'])}" if v["contacts"] else "") for v in rows]
    sources = [Source("crm.property", v["property"]["id"], v["property"]["name"]) for v in rows if v["property"]]
    return ToolResult(data={"viewings": rows}, facts=facts, sources=sources)


def _draft_viewing(ctx: ToolContext, args: dict) -> ToolResult:
    e = access.get_for_actor(ctx.actor, m.CalendarEvent, args["event_id"])
    if e.kind != m.CalendarEvent.Kind.VIEWING:
        raise ToolError("That appointment isn't a viewing.", code="invalid_arguments", fields={"event_id": ["Not a viewing."]})
    v = _viewing_brief(ctx, e)
    who = fmt.name_of(ctx.actor.user)
    place = v["property"]["name"] if v["property"] else (v["location"] or "the property")
    names = " and ".join(c["name"].split(" ")[0] for c in v["contacts"]) or "there"
    start = e.start_at.astimezone(dt.UTC)
    body = (f"Hi {names},\n\nThis confirms your viewing of {place} on {start:%A} {start.day} {start:%B %Y} at {start:%H:%M} UTC"
            + (f" ({v['location']})" if v["location"] and v["location"] != place else "") + ".\n\n"
            "If the time no longer works for you, just reply and we'll find another one.\n\n"
            f"Best regards,\n{who}")
    draft = {"subject": f"Viewing confirmation: {place}", "to": [c["email"] for c in v["contacts"] if c["email"]], "body": body}
    facts = [f"Draft confirmation for the viewing of {place} on {fmt.when(e.start_at)} (built from the appointment record)."]
    sources = [Source("crm.property", v["property"]["id"], place)] if v["property"] else []
    return ToolResult(data={"draft": draft, "status": "draft_only", "viewing": v,
                            "notes": ["This is only a draft. It has not been sent or saved; nothing can be sent from the AI. "
                                      "Check it, then send it yourself."]}, facts=facts, sources=sources)


# --- meetings ----------------------------------------------------------------------------------------


def _note_brief(ctx: ToolContext, n: m.MeetingNote) -> dict:
    ctx.touch(n)
    return {"id": str(n.pk), "type": "crm.meetingnote", "title": n.title, "body": fmt.clip(n.body, 2000), "created_at": fmt.iso(n.created_at),
            "author": fmt.person(n.created_by), "event": {"id": str(n.event_id), "name": n.event.title} if n.event_id else None}


def _item_brief(ctx: ToolContext, a: m.ActionItem) -> dict:
    ctx.touch(a)
    return {"id": str(a.pk), "type": "crm.actionitem", "title": a.title, "status": a.status, "source": a.source,
            "suggested_assignee": fmt.person(a.suggested_assignee), "suggested_due_at": fmt.iso(a.suggested_due_at),
            "task_id": str(a.task_id) if a.task_id else None}


def _meeting_items(ctx: ToolContext, args: dict) -> ToolResult:
    actor = ctx.actor
    contact = access.get_for_actor(actor, m.Contact, args["contact_id"]) if args["contact_id"] else None
    events = access.for_actor(actor, m.CalendarEvent).filter(start_at__lt=ctx.now).exclude(status=m.CalendarEvent.Status.CANCELED)
    if contact is not None:
        events = events.filter(Q(contact=contact) | Q(attendee_contacts=contact)).distinct()
    else:
        attending = m.CalendarEvent.attendee_users.through.objects.filter(user_id=actor.user.pk).values("calendarevent_id")
        events = events.filter(Q(organizer=actor.user) | Q(pk__in=attending))
    event = events.order_by("-start_at").first()
    notes_qs = access.for_actor(actor, m.MeetingNote)
    items_qs = access.for_actor(actor, m.ActionItem)
    if event is not None:
        notes_qs, items_qs = notes_qs.filter(event=event), items_qs.filter(Q(event=event) | Q(note__event=event))
    elif contact is not None:
        notes_qs, items_qs = notes_qs.filter(contact=contact), items_qs.filter(contact=contact)
    else:
        notes_qs, items_qs = notes_qs.none(), items_qs.none()
    notes = [_note_brief(ctx, n) for n in notes_qs.select_related("event", "created_by").order_by("-created_at")[:5]]
    items = [_item_brief(ctx, a) for a in items_qs.select_related("suggested_assignee").order_by("status", "-created_at")[:20]]
    ev = None
    if event is not None:
        ctx.touch(event)
        ev = {"id": str(event.pk), "title": event.title, "start_at": fmt.iso(event.start_at)}
    facts = ([f"Last meeting: “{event.title}” on {fmt.when(event.start_at)}."] if event else ["No past meeting found."])
    facts += [f"Note “{n['title']}” by {n['author']['name'] if n['author'] else 'someone'}." for n in notes]
    facts += [f"Next step: {a['title']} ({a['status']}{', AI suggestion' if a['source'] == 'ai_suggestion' else ''})." for a in items]
    if event and not notes and not items:
        facts.append("Nobody wrote notes or next steps for it (calls and chats are end-to-end encrypted and not recorded).")
    return ToolResult(data={"event": ev, "notes": notes, "action_items": items}, facts=facts,
                      sources=[ctx.source(contact, contact.display_name)] if contact else [])


def _suggest_next_step(ctx: ToolContext, args: dict) -> ToolResult:
    from apps.api.errors import RateLimited
    from apps.assistant.actions import _limit

    try:
        _limit(ctx.actor, "prepare")
    except RateLimited:
        raise ToolError("Too many suggestions in a short time. Try again in a minute.", code="rate_limited") from None
    body = {"title": args["title"], "description": args["description"]}
    for key in ("note_id", "event_id", "contact_id", "opportunity_id", "suggested_assignee_id"):
        if args[key]:
            body[key] = str(args[key])
    if args["suggested_due_at"]:
        body["suggested_due_at"] = fmt.iso(args["suggested_due_at"])
    item = meetings.propose_action_item(ctx.request, ctx.actor, body, source=m.ActionItem.Source.AI_SUGGESTION)
    data = _item_brief(ctx, item)
    return ToolResult(data={"action_item": data}, facts=[
        f"Suggested next step “{item.title}” added for review. It becomes a task only when someone confirms it in Nexus."])


# --- reports ------------------------------------------------------------------------------------------


def _team_week(ctx: ToolContext, args: dict) -> ToolResult:
    access.require(ctx.actor, Cap.REPORTS_VIEW, "Team reports are for owners, admins and managers.")
    r = reports.team_week(ctx.actor, now=ctx.now)
    people = [{"owner": (p["owner"] or {}).get("name", "Unassigned"), "new": p["new"], "won": p["won"], "lost": p["lost"],
               "won_value": p["won_value"]} for p in r["people"]]
    data = {"week_start": fmt.iso(r["week_start"]), "new_count": r["new_count"], "new_value": r["new_value"], "moved_count": r["moved_count"],
            "won_count": r["won_count"], "won_value": r["won_value"], "lost_count": r["lost_count"], "people": people}
    facts = [f"This week: {r['new_count']} new deal(s) worth {r['new_value']}, {r['moved_count']} stage move(s), "
             f"{r['won_count']} won ({r['won_value']}), {r['lost_count']} lost."] + [
        f"{p['owner']}: {p['new']} new, {p['won']} won, {p['lost']} lost." for p in people]
    return ToolResult(data=data, facts=facts)


def _lending_report(ctx: ToolContext, args: dict) -> ToolResult:
    _need_lending(ctx)
    r = reports.lending_report(ctx.actor)
    data = {"applications": r["applications"], "by_stage": [{"stage": s["stage"], "count": s["count"]} for s in r["by_stage"]],
            "outstanding_required": r["outstanding_required"], "overdue_items": r["overdue_items"],
            "applications_missing_documents": r["applications_missing_documents"], "awaiting_review": r["awaiting_review"]}
    if ctx.allow_sensitive:
        data["amount_requested"] = r["amount_requested"]
    facts = [f"{r['applications']} open application(s); {r['applications_missing_documents']} waiting on documents "
             f"({r['outstanding_required']} required item(s) outstanding, {r['overdue_items']} overdue, {r['awaiting_review']} to review)."] + [
        f"{s['stage']}: {s['count']}" for s in data["by_stage"]]
    return ToolResult(data=data, facts=facts)


APP = obj(["id", "reference", "title", "stage", "missing_documents"], id=STR, reference=STR, title=STR, stage=STR, status=STR,
          checklist={"type": "object"}, missing_documents=arr({"type": "object"}), deal=REF, url=STR, amount_requested=NSTR)

TOOLS = [
    Tool(
        name="lending_applications_missing_documents", title="Applications missing documents", feature="lending", sensitive=False,
        description="Open lending applications you can see that still wait on required documents: which ones are missing or "
                    "overdue (names and due dates only; document contents are never available).",
        args=Args(limit=P.integer("Maximum applications.", minimum=1, maximum=50, default=20)),
        run=_apps_missing_documents, output=obj(["total", "applications"], total=INT, applications=arr(APP), notes=arr(STR)),
    ),
    Tool(
        name="deals_waiting_on_documents", title="Deals waiting on documents", feature="lending",
        description="Deals whose lending applications still wait on required documents, with the missing document names.",
        args=Args(limit=P.integer("Maximum deals.", minimum=1, maximum=50, default=20)),
        run=_deals_waiting, output=obj(["deals"], deals=arr({"type": "object"}), unlinked_applications=arr(APP), notes=arr(STR)),
    ),
    Tool(
        name="get_lending_application", title="Lending application", feature="lending",
        description="One lending application: stage, checklist progress and everything still to do (documents, milestones, "
                    "tasks). Amounts and borrower details only where the workspace allows sensitive data in AI. Never documents "
                    "and never a lending decision.",
        args=Args(application_id=P.uuid("The application's ID.", required=True)),
        run=_application, output=obj(["application", "outstanding_work"], application=APP, outstanding_work=arr({"type": "object"}),
                                      notes=arr(STR)),
    ),
    Tool(
        name="lending_pipeline_report", title="Lending pipeline report", feature="lending",
        description="Counts of open lending applications by stage and of their document checklist status.",
        args=Args(), run=_lending_report,
        output=obj(["applications", "by_stage"], applications=INT, by_stage=arr({"type": "object"}), outstanding_required=INT,
                   overdue_items=INT, applications_missing_documents=INT, awaiting_review=INT, amount_requested=STR),
    ),
    Tool(
        name="approaching_deadlines", title="Approaching deadlines",
        description="Open transaction deadlines and milestones (inspection, appraisal, financing, closing, documents...) of deals "
                    "and lending applications due within `days`, overdue ones first.",
        args=Args(days=P.integer("Days ahead.", minimum=1, maximum=90, default=14), limit=P.integer("Maximum items.", minimum=1, maximum=50, default=20)),
        run=_deadlines, output=obj(["days", "deadlines"], days=INT, deadlines=arr({"type": "object"})),
    ),
    Tool(
        name="search_properties", title="Search properties", feature="real_estate",
        description="Property records of the workspace (address, status, price, bedrooms). Only the team's own records; there "
                    "are no external listings.",
        args=Args(query=P.string("Words in the address, city, postcode or headline.", max_length=100),
                  status=P.choice("Only this status.", ["", *m.Property.Status.values], default=""),
                  city=P.string("Only this city.", max_length=100),
                  limit=P.integer("Maximum properties.", minimum=1, maximum=25, default=10)),
        run=_search_properties, output=obj(["total", "properties"], total=INT, properties=arr({"type": "object"}), notes=arr(STR)),
    ),
    Tool(
        name="matching_properties", title="Properties matching a client", feature="real_estate",
        description="The contact's recorded search preferences and the available properties in your records that fit them.",
        args=Args(contact_id=P.uuid("The client (contact).", required=True), limit=P.integer("Maximum properties.", minimum=1, maximum=25, default=10)),
        run=_matching, output=obj(["contact", "properties"], contact={"type": "object"}, preferences=nullable({"type": "object"}),
                                  properties=arr({"type": "object"})),
    ),
    Tool(
        name="viewings", title="Viewings", feature="real_estate",
        description="Property viewings (appointments of kind viewing): upcoming by default, optionally for one contact.",
        args=Args(contact_id=P.uuid("Only viewings with this contact.", null=True), upcoming_only=P.boolean("Only upcoming ones.", default=True),
                  limit=P.integer("Maximum viewings.", minimum=1, maximum=50, default=10)),
        run=_viewings, output=obj(["viewings"], viewings=arr({"type": "object"})),
    ),
    Tool(
        name="draft_viewing_confirmation", title="Draft a viewing confirmation", feature="real_estate",
        description="Writes a DRAFT confirmation message for one viewing from the appointment record (date, time, place, people). "
                    "It is not sent and not stored; nothing can be sent from the AI.",
        args=Args(event_id=P.uuid("The viewing appointment's ID (from viewings).", required=True)),
        run=_draft_viewing, output=obj(["draft", "status"], draft=obj(["subject", "body"], subject=STR, body=STR, to=arr(STR)), status=STR,
                                       viewing={"type": "object"}, notes=arr(STR)),
    ),
    Tool(
        name="meeting_action_items", title="Last meeting: notes and next steps",
        description="The most recent past meeting (yours, or with one contact): the notes people wrote and its next steps "
                    "(proposed or confirmed). Calls and chats are end-to-end encrypted and never recorded, so only written notes exist.",
        args=Args(contact_id=P.uuid("Meetings with this contact.", null=True)),
        run=_meeting_items, output=obj(["notes", "action_items"], event=nullable({"type": "object"}), notes=arr({"type": "object"}),
                                       action_items=arr({"type": "object"})),
    ),
    Tool(
        name="suggest_next_step", title="Suggest a next step", kind=WRITE, idempotent=False,
        description="Adds a SUGGESTED next step (an action item marked as an AI suggestion) to a meeting, contact or deal. It is "
                    "only a proposal: it becomes a task when a person confirms it in Nexus.",
        args=Args(title=P.string("The next step.", max_length=200, required=True, blank=False),
                  description=P.string("Details.", max_length=2000, multiline=True),
                  event_id=P.uuid("The meeting it follows from.", null=True), note_id=P.uuid("The meeting note.", null=True),
                  contact_id=P.uuid("Related contact.", null=True), opportunity_id=P.uuid("Related deal.", null=True),
                  suggested_assignee_id=P.uuid("Who should do it (member ID).", null=True),
                  suggested_due_at=P.datetime("Suggested due date.")),
        run=_suggest_next_step, output=obj(["action_item"], action_item=obj(["id", "title", "status"], id=STR, title=STR, status=STR)),
    ),
    Tool(
        name="team_week_report", title="Team week report",
        description="This week's team pipeline: new deals, stage moves, wins and losses per person (owners, admins, managers).",
        args=Args(), run=_team_week,
        output=obj(["new_count", "won_count", "people"], week_start=STR, new_count=INT, new_value=STR, moved_count=INT, won_count=INT,
                   won_value=STR, lost_count=INT, people=arr({"type": "object"})),
    ),
]

__all__ = ["TOOLS", "BOOL", "READ"]
