"""Synthetic demo data for test and development environments.

Everything here is obviously fictional: people have placeholder surnames (Example, Sample,
Placeholder, ...), email addresses are on example.com / example.org / example.net (RFC 2606),
phone numbers are in the 555-0100..0199 range reserved for fiction, and every business row
is created with ``is_demo=True`` in a workspace whose ``OrgSettings.is_demo`` is set.

``seed()`` is idempotent; ``reset()`` deletes only ``is_demo`` rows of demo-flagged
workspaces and keeps any demo row that real (non-demo) rows still depend on. Both refuse to
run unless ``NEXUS_ENVIRONMENT`` is ``development`` or ``test``.
"""

from __future__ import annotations

import datetime as dt
import secrets
from decimal import Decimal

from allauth.account.models import EmailAddress
from django.apps import apps as django_apps
from django.conf import settings
from django.db import models, transaction
from django.utils import timezone

from apps.accounts.models import User
from apps.workspaces.models import Membership, Role, Workspace

from . import models as m
from .services import create_default_pipeline

DEMO_SLUG = "nexus-demo"
DEMO_NAME = "Harborview Realty & Lending (demo)"


class DemoRefused(Exception):
    pass


def check_environment() -> None:
    if settings.NEXUS_ENVIRONMENT not in {"development", "test"}:
        raise DemoRefused(
            f"NEXUS_ENVIRONMENT is {settings.NEXUS_ENVIRONMENT!r}: demo data is only allowed in development or test."
        )


# (username, first, last, email, role)
TEAM = [
    ("demo-avery", "Avery", "Example", "avery.example@example.com", Role.OWNER),
    ("demo-morgan", "Morgan", "Sample", "morgan.sample@example.com", Role.MANAGER),
    ("demo-riley", "Riley", "Placeholder", "riley.placeholder@example.com", Role.AGENT),
    ("demo-jordan", "Jordan", "Fictional", "jordan.fictional@example.org", Role.AGENT),
    ("demo-casey", "Casey", "Testcase", "casey.testcase@example.org", Role.MEMBER),
    ("demo-sam", "Sam", "Mockwell", "sam.mockwell@example.net", Role.READONLY),
]

TAGS = [("Hot lead", "red"), ("First-time buyer", "blue"), ("Investor", "violet"), ("Refinance", "teal"),
        ("VIP", "amber"), ("Referral", "green")]

FIELDS = [
    # entity, key, label, type, options, sensitive, profile
    ("contact", "budget", "Budget", "currency", [], False, "real_estate"),
    ("contact", "preferred_area", "Preferred area", "text", [], False, "real_estate"),
    ("contact", "pre_approved", "Pre-approved", "boolean", [], False, "lending"),
    ("contact", "credit_band", "Credit band", "select",
     [{"value": "excellent", "label": "Excellent"}, {"value": "good", "label": "Good"}, {"value": "fair", "label": "Fair"}], True, "lending"),
    ("opportunity", "property_address", "Property address", "text", [], False, "real_estate"),
    ("opportunity", "loan_type", "Loan type", "select",
     [{"value": "conventional", "label": "Conventional"}, {"value": "fha", "label": "FHA"}, {"value": "va", "label": "VA"},
      {"value": "jumbo", "label": "Jumbo"}], False, "lending"),
]

# key, first, last, company, email, phone, kind, roles, owner, assignees, priority, follow-up (days), tags, visibility, custom, source
CONTACTS = [
    ("harper", "Harper", "Sample", "", "harper.sample@example.com", "+1 (202) 555-0101", "lead", ["buyer"], "demo-riley", [],
     "high", -2, ["Hot lead", "First-time buyer"], "team", {"budget": "450000.00", "preferred_area": "Old Harbor district"}, "Website form"),
    ("quinn", "Quinn", "Placeholder", "", "quinn.placeholder@example.org", "+1 (202) 555-0102", "prospect", ["seller"], "demo-riley", ["demo-jordan"],
     "normal", 1, ["Referral"], "team", {}, "Referral"),
    ("rowan", "Rowan", "Example", "Example Holdings LLC", "rowan@example.net", "+1 (202) 555-0103", "client", ["investor", "buyer"], "demo-jordan", [],
     "urgent", 0, ["Investor", "VIP"], "team", {"budget": "1200000.00"}, "Event"),
    ("sky", "Skyler", "Fictional", "", "skyler.fictional@example.com", "+1 (202) 555-0104", "lead", ["borrower"], "demo-jordan", [],
     "normal", -5, ["Refinance"], "team", {"pre_approved": False, "credit_band": "good"}, "Paid search"),
    ("drew", "Drew", "Testcase", "", "drew.testcase@example.org", "+1 (202) 555-0105", "client", ["borrower", "buyer"], "demo-morgan", ["demo-riley"],
     "high", 3, ["First-time buyer"], "team", {"pre_approved": True, "credit_band": "excellent"}, "Referral"),
    ("emery", "Emery", "Mockwell", "Mockwell & Daughters Bakery", "emery@example.net", "+1 (202) 555-0106", "past_client", ["seller"], "demo-avery", [],
     "low", 30, [], "team", {}, "Past client"),
    ("finley", "Finley", "Sample", "", "finley.sample@example.com", "+1 (202) 555-0107", "lead", ["tenant"], "demo-riley", [],
     "normal", None, [], "team", {}, "Open house"),
    ("gray", "Gray", "Placeholder", "Placeholder Property Group", "gray@example.org", "+1 (202) 555-0108", "partner", ["referral_partner"], "demo-morgan", [],
     "normal", 7, ["Referral"], "team", {}, "Partner"),
    ("hollis", "Hollis", "Example", "", "hollis.example@example.com", "+1 (202) 555-0109", "prospect", ["buyer", "borrower"], "demo-jordan", ["demo-riley"],
     "high", -1, ["Hot lead"], "team", {"budget": "380000.00", "pre_approved": True}, "Website form"),
    ("indy", "Indigo", "Fictional", "", "indigo.fictional@example.net", "+1 (202) 555-0110", "lead", ["seller"], "demo-avery", [],
     "normal", 2, [], "private", {}, "Door knocking"),
    ("jules", "Jules", "Testcase", "", "jules.testcase@example.com", "+1 (202) 555-0111", "client", ["landlord"], "demo-riley", [],
     "normal", 14, ["Investor"], "team", {}, "Referral"),
    ("kai", "Kai", "Mockwell", "", "kai.mockwell@example.org", "+1 (202) 555-0112", "lead", ["borrower"], "demo-morgan", [],
     "urgent", 0, ["Refinance", "Hot lead"], "team", {"credit_band": "fair"}, "Paid search"),
    ("lane", "Lane", "Sample", "Sample Title & Escrow", "lane@example.net", "+1 (202) 555-0113", "partner", ["vendor"], "demo-avery", [],
     "low", None, [], "team", {}, "Partner"),
    ("marlo", "Marlo", "Placeholder", "", "marlo.placeholder@example.com", "+1 (202) 555-0114", "prospect", ["buyer"], "demo-jordan", [],
     "normal", 5, ["First-time buyer"], "team", {"budget": "295000.00"}, "Social"),
]

# name, pipeline kind, stage index, value, owner, contacts, expected close (days), custom
OPPORTUNITIES = [
    ("Sample - 14 Gull Lane purchase", "real_estate", 1, "445000.00", "demo-riley", ["harper"], 45, {"property_address": "14 Gull Lane (fictional)"}),
    ("Placeholder - listing 9 Pier Row", "real_estate", 2, "610000.00", "demo-riley", ["quinn"], 30, {"property_address": "9 Pier Row (fictional)"}),
    ("Example Holdings - duplex portfolio", "real_estate", 3, "1180000.00", "demo-jordan", ["rowan"], 20, {}),
    ("Hollis - starter home", "real_estate", 0, "375000.00", "demo-jordan", ["hollis"], 60, {}),
    ("Marlo - condo search", "real_estate", 0, "290000.00", "demo-jordan", ["marlo"], 75, {}),
    ("Mockwell - bakery building sale", "real_estate", 4, "520000.00", "demo-avery", ["emery"], -10, {}),
    ("Fictional - refinance", "lending", 1, "320000.00", "demo-jordan", ["sky"], 25, {"loan_type": "conventional"}),
    ("Testcase - first mortgage", "lending", 3, "410000.00", "demo-morgan", ["drew"], 12, {"loan_type": "fha"}),
    ("Mockwell - cash-out refinance", "lending", 0, "250000.00", "demo-morgan", ["kai"], 40, {"loan_type": "conventional"}),
    ("Hollis - pre-approval", "lending", 2, "360000.00", "demo-jordan", ["hollis"], 18, {"loan_type": "va"}),
    ("Placeholder Group - referral program", "general", 2, "24000.00", "demo-morgan", ["gray"], 35, {}),
    ("Sample Title - preferred vendor renewal", "general", 1, "6000.00", "demo-avery", ["lane"], 50, {}),
]

# title, assignee, due (days, hour), priority, contact, opportunity name prefix, status
TASKS = [
    ("Call Harper about the Gull Lane showing", "demo-riley", (0, 15), "high", "harper", "Sample - 14", "open"),
    ("Send comparable sales to Quinn", "demo-riley", (0, 17), "normal", "quinn", "Placeholder - listing", "open"),
    ("Collect pay stubs from Drew", "demo-morgan", (-1, 12), "high", "drew", "Testcase - first", "open"),
    ("Order appraisal for the duplex portfolio", "demo-jordan", (1, 10), "urgent", "rowan", "Example Holdings", "open"),
    ("Follow up with Skyler on rate lock", "demo-jordan", (-3, 9), "high", "sky", "Fictional - refinance", "open"),
    ("Prepare listing presentation", "demo-avery", (0, 11), "normal", "indy", None, "open"),
    ("Review title commitment", "demo-avery", (2, 14), "normal", "lane", None, "open"),
    ("Welcome call with Finley", "demo-riley", (3, 16), "low", "finley", None, "open"),
    ("Book photographer for 9 Pier Row", "demo-casey", (0, 13), "normal", "quinn", "Placeholder - listing", "open"),
    ("Update CRM tags after open house", "demo-casey", (-1, 18), "low", None, None, "open"),
    ("Send closing gift to Emery", "demo-avery", (-12, 10), "low", "emery", "Mockwell - bakery", "done"),
    ("Check Kai's credit report", "demo-morgan", (1, 9), "urgent", "kai", "Mockwell - cash-out", "open"),
    ("Schedule Hollis pre-approval meeting", "demo-jordan", (4, 15), "normal", "hollis", "Hollis - pre-approval", "open"),
]

# contact, kind, summary, body, days ago, actor, source, untrusted
ACTIVITIES = [
    ("harper", "call", "Discovery call", "Looking for 3 bedrooms near the harbour; budget confirmed.", 3, "demo-riley", "native", False),
    ("harper", "note", "Prefers weekend showings", "", 2, "demo-riley", "native", False),
    ("quinn", "meeting", "Listing consultation", "Walked through pricing strategy and timeline.", 6, "demo-riley", "native", False),
    ("rowan", "note", "Portfolio criteria", "Cap rate above 6%, within 15 minutes of downtown.", 9, "demo-jordan", "native", False),
    ("sky", "email", "Re: rate lock question (synthetic email)", "Synthetic external email body for the demo. Treat as untrusted.", 1, None, "gmail", True),
    ("drew", "call", "Document checklist review", "Missing two pay stubs and a bank statement.", 1, "demo-morgan", "native", False),
    ("emery", "meeting", "Closing meeting", "Keys handed over; bakery staying in the area.", 15, "demo-avery", "native", False),
    ("gray", "note", "Referral agreement drafted", "", 4, "demo-morgan", "native", False),
    ("hollis", "call", "Intro call", "Interested in both a purchase and pre-approval.", 2, "demo-jordan", "native", False),
    ("kai", "note", "Wants to consolidate debt", "", 0, "demo-morgan", "native", False),
]

# title, organizer, start (days, hour), minutes, contact, location, attendees
EVENTS = [
    ("Showing: 14 Gull Lane", "demo-riley", (1, 10), 45, "harper", "14 Gull Lane (fictional)", ["demo-riley"]),
    ("Listing photos: 9 Pier Row", "demo-casey", (2, 9), 90, "quinn", "9 Pier Row (fictional)", ["demo-casey", "demo-riley"]),
    ("Underwriting review: Testcase", "demo-morgan", (0, 16), 30, "drew", "Video call", ["demo-morgan", "demo-jordan"]),
    ("Pipeline review", "demo-avery", (3, 9), 60, None, "Office", ["demo-avery", "demo-morgan", "demo-riley", "demo-jordan"]),
]


def _at(days: int, hour: int, now) -> dt.datetime:
    base = now.replace(minute=0, second=0, microsecond=0) + dt.timedelta(days=days)
    return base.replace(hour=hour)


def _ensure_user(username, first, last, email, password: str | None, reset_password: bool) -> tuple[User, bool]:
    user = User.objects.filter(username=username).first()
    if user is not None and user.email.lower() != email:
        raise DemoRefused(f"The username {username} belongs to a non-demo account; nothing was changed.")
    created = user is None
    if created:
        user = User(username=username, email=email, display_name=f"{first} {last}")
        if password:
            user.set_password(password)
        else:
            user.set_unusable_password()
        user.save()
        EmailAddress.objects.get_or_create(user=user, email=email, defaults={"verified": True, "primary": True})
    elif reset_password and password:
        user.set_password(password)
        user.save(update_fields=["password"])
    return user, created


@transaction.atomic
def seed(*, password: str | None = None, reset_passwords: bool = False, now=None) -> dict:
    """Creates (or completes) the demo workspace. Returns a summary."""
    check_environment()
    from apps.billing.models import Plan
    from apps.billing.services import assign_manual_plan, ensure_subscription, seed_plans

    now = now or timezone.now()
    seed_plans()
    generated = None
    if password is None and not User.objects.filter(username=TEAM[0][0]).exists():
        generated = password = secrets.token_urlsafe(12)
    users: dict[str, User] = {}
    created_users = []
    for username, first, last, email, _role in TEAM:
        users[username], was_created = _ensure_user(username, first, last, email, password, reset_passwords)
        if was_created:
            created_users.append(username)

    ws = Workspace.objects.filter(slug=DEMO_SLUG).first()
    if ws is not None and not m.OrgSettings.objects.filter(workspace=ws, is_demo=True).exists():
        raise DemoRefused(f"A workspace with the slug {DEMO_SLUG} exists and is not a demo workspace; nothing was changed.")
    if ws is None:
        ws = Workspace.objects.create(name=DEMO_NAME, slug=DEMO_SLUG, created_by=users["demo-avery"])
    org, _ = m.OrgSettings.objects.get_or_create(workspace=ws)
    org.is_demo = True
    org.business_profiles = ["general", "real_estate", "lending"]
    org.save()
    sub = ensure_subscription(ws)
    business = Plan.objects.filter(code="business").first()
    if business is not None and sub.plan_id != business.pk:
        assign_manual_plan(ws, business, note="Synthetic demo workspace")
    for username, _f, _l, _e, role in TEAM:
        ms, _ = Membership.objects.get_or_create(workspace=ws, user=users[username], defaults={"role": role})
        if ms.role != role:
            ms.role = role
            ms.save(update_fields=["role"])

    if m.Contact.objects.filter(workspace=ws, is_demo=True).exists():
        return {"workspace": ws, "created": False, "users": created_users, "password": generated}

    owner = users["demo-avery"]
    pipelines = {}
    for kind in ("real_estate", "lending", "general"):
        p = m.Pipeline.objects.filter(workspace=ws, kind=kind, is_demo=True).first()
        pipelines[kind] = p or create_default_pipeline(ws, kind, user=owner, is_demo=True)
    m.Pipeline.objects.filter(workspace=ws).update(is_default=False)
    m.Pipeline.objects.filter(pk=pipelines["real_estate"].pk).update(is_default=True)

    tags = {name: m.Tag.objects.get_or_create(workspace=ws, name=name, defaults={"color": color, "is_demo": True, "created_by": owner})[0]
            for name, color in TAGS}
    for i, (entity, key, label, ftype, options, sensitive, profile) in enumerate(FIELDS):
        m.FieldDefinition.objects.get_or_create(
            workspace=ws, entity=entity, key=key,
            defaults={"label": label, "field_type": ftype, "options": options, "sensitive": sensitive, "profile": profile,
                      "position": i * 10, "is_demo": True, "created_by": owner},
        )

    contacts = {}
    for (key, first, last, company, email, phone, kind, roles, own, assignees, priority, follow, tag_names, visibility, custom,
         source) in CONTACTS:
        c = m.Contact.objects.create(
            workspace=ws, first_name=first, last_name=last, company=company, email=email, phone=phone, kind=kind, roles=roles,
            owner=users[own], priority=priority, follow_up_at=_at(follow, 10, now) if follow is not None else None,
            visibility=visibility, custom_fields=custom, source=source, campaign="Demo spring campaign" if source == "Paid search" else "",
            created_by=users[own], is_demo=True,
        )
        c.assignees.set([users[a] for a in assignees])
        c.tags.set([tags[t] for t in tag_names])
        contacts[key] = c

    opps = {}
    for name, kind, stage_index, value, own, contact_keys, close_days, custom in OPPORTUNITIES:
        pipeline = pipelines[kind]
        stages = list(pipeline.stages.order_by("position"))
        stage = stages[min(stage_index, len(stages) - 1)]
        status = "won" if stage.is_won else "lost" if stage.is_lost else "open"
        o = m.Opportunity.objects.create(
            workspace=ws, name=name, pipeline=pipeline, stage=stage, value=Decimal(value), currency="USD", owner=users[own],
            status=status, expected_close_date=(now + dt.timedelta(days=close_days)).date(), closed_at=now if status != "open" else None,
            stage_entered_at=now - dt.timedelta(days=3), position=float(len(opps) * 1024), custom_fields=custom,
            created_by=users[own], is_demo=True,
        )
        for i, ck in enumerate(contact_keys):
            m.OpportunityContact.objects.create(opportunity=o, contact=contacts[ck], role="primary" if i == 0 else "other")
        m.StageHistory.objects.create(workspace=ws, opportunity=o, to_stage=stage, to_name=stage.name, created_by=users[own], is_demo=True)
        opps[name] = o

    def opp_by_prefix(prefix):
        return next((o for n, o in opps.items() if n.startswith(prefix)), None) if prefix else None

    for title, assignee, (days, hour), priority, ck, opp_prefix, status in TASKS:
        m.Task.objects.create(
            workspace=ws, title=title, assignee=users[assignee], due_at=_at(days, hour, now), priority=priority,
            contact=contacts.get(ck) if ck else None, opportunity=opp_by_prefix(opp_prefix), status=status,
            completed_at=now if status == "done" else None, completed_by=users[assignee] if status == "done" else None,
            created_by=owner, is_demo=True,
        )

    for ck, kind, summary, body, days_ago, actor, source, untrusted in ACTIVITIES:
        when = now - dt.timedelta(days=days_ago, hours=2)
        m.Activity.objects.create(
            workspace=ws, contact=contacts[ck], kind=kind, summary=summary, body=body, occurred_at=when,
            actor=users.get(actor) if actor else None, source=source, untrusted=untrusted,
            external_ref="demo-synthetic-message-1" if source != "native" else "", created_by=users.get(actor) if actor else None,
            is_demo=True,
        )
        m.Contact.objects.filter(pk=contacts[ck].pk).update(last_activity_at=when)

    for title, organizer, (days, hour), minutes, ck, location, attendees in EVENTS:
        start = _at(days, hour, now)
        e = m.CalendarEvent.objects.create(
            workspace=ws, title=title, start_at=start, end_at=start + dt.timedelta(minutes=minutes), location=location,
            organizer=users[organizer], contact=contacts.get(ck) if ck else None, created_by=users[organizer], is_demo=True,
        )
        e.attendee_users.set([users[a] for a in attendees])
        if ck:
            e.attendee_contacts.set([contacts[ck]])

    return {"workspace": ws, "created": True, "users": created_users, "password": generated}


def tenant_models() -> list[type[models.Model]]:
    """Every concrete model with ``workspace`` and ``is_demo`` (CRM and other teams')."""
    return [
        model for model in django_apps.get_models()
        if issubclass(model, m.TenantModel) and not model._meta.abstract
    ]


def _blocked(model, qs) -> set:
    """PKs of rows in ``qs`` that cannot go: something protects them, or a non-demo row
    would be deleted with them (CASCADE)."""
    blocked = set()
    pks = list(qs.values_list("pk", flat=True))
    if not pks:
        return blocked
    for rel in model._meta.related_objects:
        if rel.many_to_many or not hasattr(rel, "on_delete"):
            continue
        related = rel.related_model
        name = rel.field.name
        if rel.on_delete is models.PROTECT:
            blocked |= set(related.objects.filter(**{f"{name}__in": pks}).values_list(name, flat=True))
        elif rel.on_delete is models.CASCADE and any(f.name == "is_demo" for f in related._meta.fields):
            blocked |= set(related.objects.filter(**{f"{name}__in": pks, "is_demo": False}).values_list(name, flat=True))
    return blocked


@transaction.atomic
def reset() -> dict:
    """Deletes ``is_demo`` rows in demo-flagged workspaces, never anything else."""
    check_environment()
    demo_ws = list(m.OrgSettings.objects.filter(is_demo=True).values_list("workspace_id", flat=True))
    deleted: dict[str, int] = {}
    kept: dict[str, int] = {}
    models_ = tenant_models()
    progress = True
    while progress:
        progress = False
        for model in models_:
            qs = model.objects.filter(workspace_id__in=demo_ws, is_demo=True)
            blocked = _blocked(model, qs)
            doomed = qs.exclude(pk__in=blocked)
            n = doomed.count()
            if n:
                doomed.delete()
                deleted[model._meta.label] = deleted.get(model._meta.label, 0) + n
                progress = True
    for model in models_:
        left = model.objects.filter(workspace_id__in=demo_ws, is_demo=True).count()
        if left:
            kept[model._meta.label] = left
    return {"workspaces": len(demo_ws), "deleted": deleted, "kept": kept}
