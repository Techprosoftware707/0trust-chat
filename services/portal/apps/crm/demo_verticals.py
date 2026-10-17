"""Synthetic demo data of the verticals (called from ``demo.seed``): properties, buyer and
seller relationships, client preferences, viewings, deal milestones and deadlines, lending
applications with document checklists, internal notes, a meeting with notes and suggested
next steps, the example automation rules, and one synthetic encrypted document when secure
storage is configured.

Everything is fictional and flagged ``is_demo``: addresses say "(fictional)", the town is
"Harborview (fictional)", every listing is ``source="manual"`` (Nexus has no MLS access), and
no AI output is simulated (all suggested next steps are a teammate's). Idempotent: rows are
looked up by natural keys first.
"""

from __future__ import annotations

import datetime as dt
import uuid
from decimal import Decimal

from django.utils import timezone

from . import models as m

TOWN = "Harborview (fictional)"

# key, address, type, status, price, beds, baths, area, owner, headline
PROPERTIES = [
    ("gull", "14 Gull Lane", "house", "active", "449000.00", 3, "2.0", 1650, "demo-riley", "Bright family home near the harbour"),
    ("pier", "9 Pier Row", "condo", "coming_soon", "615000.00", 2, "2.0", 1180, "demo-riley", "Top-floor condo with water views"),
    ("duplex", "221 Example Avenue", "multi_family", "under_contract", "1180000.00", 6, "4.0", 3400, "demo-jordan", "Two-unit duplex, both let"),
    ("court", "5 Placeholder Court", "condo", "active", "289000.00", 1, "1.0", 720, "demo-jordan", "Compact condo with parking"),
    ("sample", "77 Sample Street", "house", "active", "372000.00", 3, "2.0", 1420, "demo-jordan", "Starter home with a garage"),
    ("bakery", "3 Mockwell Way", "commercial", "sold", "520000.00", None, "1.0", 2100, "demo-avery", "Corner bakery building"),
]

# opportunity name, property key, deal role, (contact key, contact role on the deal)
DEAL_LINKS = [
    ("Sample - 14 Gull Lane purchase", "gull", "purchase", ("harper", "buyer")),
    ("Placeholder - listing 9 Pier Row", "pier", "listing", ("quinn", "seller")),
    ("Example Holdings - duplex portfolio", "duplex", "purchase", ("rowan", "buyer")),
    ("Hollis - starter home", "sample", "considering", ("hollis", "buyer")),
    ("Marlo - condo search", "court", "considering", ("marlo", "buyer")),
    ("Mockwell - bakery building sale", "bakery", "listing", ("emery", "seller")),
]

# property key, contact key, role
PROPERTY_CONTACTS = [
    ("gull", "harper", "interested"), ("pier", "quinn", "seller"), ("duplex", "rowan", "buyer"), ("court", "marlo", "interested"),
    ("sample", "hollis", "interested"), ("bakery", "emery", "seller"),
]

# contact key -> preferences
PREFERENCES = {
    "harper": dict(budget_min="400000.00", budget_max="460000.00", areas=["Old Harbor district"], property_types=["house"], bedrooms_min=3,
                   bathrooms_min="2.0", must_haves=["Garden", "Walk to the harbour"], nice_to_haves=["Home office"],
                   timeline="within_3_months", notes="Prefers weekend viewings."),
    "hollis": dict(budget_min="330000.00", budget_max="390000.00", areas=["Sample Street", "Harborview"], property_types=["house", "townhouse"],
                   bedrooms_min=3, bathrooms_min="1.5", must_haves=["Garage"], nice_to_haves=["Fenced yard"], timeline="within_6_months"),
    "marlo": dict(budget_min="250000.00", budget_max="300000.00", areas=["Placeholder Court", "Harborview"], property_types=["condo"],
                  bedrooms_min=1, must_haves=["Elevator", "Parking"], timeline="within_3_months"),
    "rowan": dict(budget_min="900000.00", budget_max="1300000.00", areas=["Harborview"], property_types=["multi_family"], bedrooms_min=4,
                  must_haves=["Cap rate above 6%"], timeline="flexible", notes="Investor: portfolio of rentals."),
}

# title, property key, contact key, organizer, (days, hour), minutes
VIEWINGS = [
    ("Viewing: 77 Sample Street", "sample", "hollis", "demo-jordan", (2, 11), 45),
    ("Viewing: 5 Placeholder Court", "court", "marlo", "demo-jordan", (-3, 15), 30),
]

# reference, title, borrower key, officer, product, amount, stage index, target close (days), property, opportunity
APPLICATIONS = [
    ("APP-0001", "Testcase - first mortgage", "drew", "demo-jordan", "purchase", "410000.00", 3, 12, "sample", None),
    ("APP-0002", "Fictional - refinance", "sky", "demo-jordan", "refinance", "320000.00", 2, 25, None, None),
    ("APP-0003", "Mockwell - cash-out refinance", "kai", "demo-morgan", "cash_out_refinance", "250000.00", 1, 40, None, None),
    ("APP-0004", "Hollis - pre-approval", "hollis", "demo-riley", "purchase", "360000.00", 4, 18, None, None),
    ("APP-0005", "Example Holdings - duplex financing", "rowan", "demo-jordan", "purchase", "940000.00", 5, 30, "duplex",
     "Example Holdings - duplex portfolio"),
]

# reference -> {item name prefix: (status, due days)}
CHECKLIST_STATES = {
    "APP-0001": {"Government-issued": ("accepted", -5), "Pay stubs": ("requested", -1), "W-2s": ("received", 2),
                 "Bank statements": ("requested", 3), "Gift letter": ("waived", None)},
    "APP-0002": {"Government-issued": ("accepted", -2), "Pay stubs": ("requested", 4), "Current mortgage": ("requested", 4)},
    "APP-0004": {"Government-issued": ("accepted", -9), "Pay stubs": ("accepted", -6), "W-2s": ("accepted", -6),
                 "Bank statements": ("accepted", -6), "Signed purchase": ("received", 1), "Gift letter": ("waived", None)},
    "APP-0005": {"": ("accepted", -10)},
}

NOTES = [
    ("APP-0001", "demo-jordan", "staff", "Borrower prefers phone calls after 5pm. Second pay stub expected Friday."),
    ("APP-0003", "demo-morgan", "managers", "Debt consolidation case: review the payment history with the team lead before moving on."),
]


def _at(now, days: int, hour: int) -> dt.datetime:
    local = timezone.localtime(now).replace(minute=0, second=0, microsecond=0) + dt.timedelta(days=days)
    return local.replace(hour=hour)


def seed_verticals(ws, users: dict, contacts: dict, opps: dict, now) -> int:
    from apps.automation.services import seed_example_rules

    from . import documents
    from .lending import _add_items_from_template, ensure_default_templates, template_for
    from .realestate import DEADLINE_TEMPLATES

    created = 0
    today = timezone.localtime(now).date()
    owner = users["demo-avery"]

    # --- properties and relations ---------------------------------------------------------------
    props = {}
    for key, address, ptype, status, price, beds, baths, area, own, headline in PROPERTIES:
        p = m.Property.objects.filter(workspace=ws, address_line1=address, is_demo=True).first()
        if p is None:
            p = m.Property.objects.create(
                workspace=ws, address_line1=address, address_line2="(fictional address)", city=TOWN, region="Demo County",
                postal_code="00000", country="US", property_type=ptype, status=status, list_price=Decimal(price), bedrooms=beds,
                bathrooms=Decimal(baths) if baths else None, area=area, headline=headline,
                description="Synthetic demo listing. Entered by hand; not from any listing service.", source="manual",
                owner=users[own], created_by=users[own], is_demo=True,
                listed_at=today - dt.timedelta(days=20) if status in ("active", "under_contract", "sold") else None,
            )
            created += 1
        props[key] = p
    for opp_name, pkey, role, (ckey, crole) in DEAL_LINKS:
        o = opps.get(opp_name)
        if o is None:
            continue
        _, was = m.OpportunityProperty.objects.get_or_create(workspace=ws, opportunity=o, property=props[pkey],
                                                             defaults={"role": role, "is_demo": True, "created_by": owner})
        created += was
        m.OpportunityContact.objects.filter(opportunity=o, contact=contacts[ckey], role="primary").update(role=crole)
    for pkey, ckey, role in PROPERTY_CONTACTS:
        _, was = m.PropertyContact.objects.get_or_create(workspace=ws, property=props[pkey], contact=contacts[ckey], role=role,
                                                         defaults={"is_demo": True, "created_by": owner})
        created += was
    for ckey, pref in PREFERENCES.items():
        if m.ClientPreference.objects.filter(contact=contacts[ckey]).exists():
            continue
        data = dict(pref)
        for k in ("budget_min", "budget_max", "bathrooms_min"):
            if data.get(k):
                data[k] = Decimal(data[k])
        m.ClientPreference.objects.create(workspace=ws, contact=contacts[ckey], is_demo=True, created_by=contacts[ckey].owner, **data)
        created += 1

    # --- viewings (calendar events of kind "viewing", linked to the property) -----------------------
    m.CalendarEvent.objects.filter(workspace=ws, is_demo=True, title="Showing: 14 Gull Lane").update(
        kind="viewing", related_type="crm.property", related_id=props["gull"].pk)
    for title, pkey, ckey, organizer, (days, hour), minutes in VIEWINGS:
        if m.CalendarEvent.objects.filter(workspace=ws, title=title, is_demo=True).exists():
            continue
        start = _at(now, days, hour)
        e = m.CalendarEvent.objects.create(
            workspace=ws, kind="viewing", title=title, start_at=start, end_at=start + dt.timedelta(minutes=minutes),
            location=f"{props[pkey].address_line1}, {TOWN}", organizer=users[organizer], contact=contacts[ckey],
            related_type="crm.property", related_id=props[pkey].pk, created_by=users[organizer], is_demo=True,
            status="completed" if days < 0 else "scheduled",
        )
        e.attendee_users.set([users[organizer]])
        e.attendee_contacts.set([contacts[ckey]])
        created += 1

    # --- deal milestones and deadlines --------------------------------------------------------------
    duplex = opps.get("Example Holdings - duplex portfolio")
    if duplex is not None and not m.Milestone.objects.filter(opportunity=duplex).exists():
        base = today - dt.timedelta(days=19)  # the appraisal falls due in two days: "due soon"
        for i, (category, mtype, title, days) in enumerate(DEADLINE_TEMPLATES["purchase"]):
            due = base + dt.timedelta(days=days)
            done = due < today
            m.Milestone.objects.create(workspace=ws, opportunity=duplex, category=category, milestone_type=mtype, title=title,
                                       due_date=due, status="done" if done else "pending", completed_at=now if done else None,
                                       completed_by=users["demo-jordan"] if done else None, position=(i + 1) * 10,
                                       amount=Decimal("1150000.00") if mtype == "offer_accepted" else None,
                                       responsible=users["demo-jordan"], created_by=users["demo-jordan"], is_demo=True)
            created += 1
    pier = opps.get("Placeholder - listing 9 Pier Row")
    if pier is not None and not m.Milestone.objects.filter(opportunity=pier).exists():
        m.Milestone.objects.create(workspace=ws, opportunity=pier, category="milestone", milestone_type="offer_submitted",
                                   title="Offer received (synthetic)", due_date=today - dt.timedelta(days=2), status="done",
                                   completed_at=now, completed_by=users["demo-riley"], amount=Decimal("600000.00"), position=10,
                                   responsible=users["demo-riley"], created_by=users["demo-riley"], is_demo=True)
        m.Milestone.objects.create(workspace=ws, opportunity=pier, category="milestone", milestone_type="counter_offer",
                                   title="Counter-offer response due", due_date=today + dt.timedelta(days=1), amount=Decimal("612000.00"),
                                   position=20, responsible=users["demo-riley"], created_by=users["demo-riley"], is_demo=True)
        created += 2
    gull = opps.get("Sample - 14 Gull Lane purchase")
    if gull is not None and not m.Milestone.objects.filter(opportunity=gull).exists():
        m.Milestone.objects.create(workspace=ws, opportunity=gull, category="deadline", milestone_type="custom",
                                   title="Decide whether to make an offer", due_date=today + dt.timedelta(days=5), position=10,
                                   responsible=users["demo-riley"], created_by=users["demo-riley"], is_demo=True)
        created += 1

    # --- lending -------------------------------------------------------------------------------------
    created += ensure_default_templates(ws, users["demo-morgan"], is_demo=True)
    pipeline = m.Pipeline.objects.filter(workspace=ws, kind="lending", is_demo=True).first()
    stages = list(pipeline.stages.order_by("position")) if pipeline else []
    apps_by_ref = {}
    for ref, title, bkey, officer, product, amount, stage_i, close_days, pkey, opp_name in APPLICATIONS:
        app = m.LendingApplication.objects.filter(workspace=ws, reference=ref).first()
        if app is not None:
            apps_by_ref[ref] = app
            continue
        if not stages:
            break
        stage = stages[min(stage_i, len(stages) - 1)]
        app = m.LendingApplication.objects.create(
            workspace=ws, reference=ref, title=title, pipeline=pipeline, stage=stage, stage_entered_at=now - dt.timedelta(days=2),
            position=float(len(apps_by_ref) + 1) * 1024, loan_officer=users[officer], product_type=product, amount_requested=Decimal(amount),
            target_close_date=today + dt.timedelta(days=close_days), property=props.get(pkey) if pkey else None,
            opportunity=opps.get(opp_name) if opp_name else None, source="Demo", created_by=users[officer], is_demo=True,
        )
        m.ApplicationBorrower.objects.create(workspace=ws, application=app, contact=contacts[bkey], role="borrower", is_demo=True,
                                             created_by=users[officer])
        m.LendingStageHistory.objects.create(workspace=ws, application=app, to_stage=stage, to_name=stage.name, created_by=users[officer],
                                             is_demo=True)
        from .access import actor_for

        tpl = template_for(ws.pk, product)
        if tpl is not None:
            _add_items_from_template(actor_for(users[officer], ws.pk), app, tpl)
        states = CHECKLIST_STATES.get(ref, {})
        for item in app.checklist.all():
            for prefix, (status, due_days) in states.items():
                if item.name.startswith(prefix):
                    item.status = status
                    item.due_date = today + dt.timedelta(days=due_days) if due_days is not None else None
                    if status in ("requested", "received", "accepted"):
                        item.requested_at, item.requested_by = now - dt.timedelta(days=4), users[officer]
                    if status in ("received", "accepted"):
                        item.received_at = now - dt.timedelta(days=2)
                    if status in ("accepted", "waived"):
                        item.reviewed_at, item.reviewed_by = now - dt.timedelta(days=1), users[officer]
                    item.save()
                    break
        apps_by_ref[ref] = app
        created += 1
    for ref, author, visibility, body in NOTES:
        app = apps_by_ref.get(ref)
        if app is not None and not m.ApplicationNote.objects.filter(application=app, body=body).exists():
            m.ApplicationNote.objects.create(workspace=ws, application=app, body=body, visibility=visibility, created_by=users[author],
                                             is_demo=True)
            created += 1
    drew_app = apps_by_ref.get("APP-0001")
    if drew_app is not None and not m.Milestone.objects.filter(application=drew_app).exists():
        base = today - dt.timedelta(days=8)
        for i, (category, mtype, title, days) in enumerate(DEADLINE_TEMPLATES["lending"]):
            due = base + dt.timedelta(days=days)
            done = due < today - dt.timedelta(days=1)
            m.Milestone.objects.create(workspace=ws, application=drew_app, category=category, milestone_type=mtype, title=title,
                                       due_date=due, status="done" if done else "pending", completed_at=now if done else None,
                                       position=(i + 1) * 10, responsible=users["demo-jordan"], created_by=users["demo-jordan"], is_demo=True)
            created += 1
    # One synthetic, encrypted document (only where secure storage is configured).
    if drew_app is not None and documents.is_configured() and not m.SecureDocument.objects.filter(application=drew_app).exists():
        item = drew_app.checklist.filter(name__startswith="W-2s").first()
        data = _synthetic_pdf("Synthetic demo document. Not a real W-2. Nexus Office AI test environment.")
        doc_id = uuid.uuid4()
        sealed = documents.seal(ws.pk, doc_id, data)
        doc = m.SecureDocument.objects.create(id=doc_id, workspace=ws, application=drew_app, checklist_item=item,
                                              original_name="w2-synthetic-demo.pdf", content_type="application/pdf", size=len(data),
                                              storage_name=sealed.storage_name, key_id=sealed.key_id, wrapped_key=sealed.wrapped_key,
                                              created_by=users["demo-jordan"], is_demo=True)
        m.DocumentAccessLog.objects.create(workspace=ws, application=drew_app, document=doc, document_name=doc.original_name,
                                           user=users["demo-jordan"], action="upload", created_by=users["demo-jordan"], is_demo=True)
        created += 1

    # --- a meeting with notes and suggested next steps (all by teammates; no AI output) -------------
    title = "Intro call: Hollis"
    event = m.CalendarEvent.objects.filter(workspace=ws, title=title, is_demo=True).first()
    if event is None:
        start = _at(now, -1, 14)
        event = m.CalendarEvent.objects.create(
            workspace=ws, kind="call", title=title, start_at=start, end_at=start + dt.timedelta(minutes=30), location="Video call",
            organizer=users["demo-jordan"], contact=contacts["hollis"], opportunity=opps.get("Hollis - starter home"),
            status="completed", created_by=users["demo-jordan"], is_demo=True,
        )
        event.attendee_users.set([users["demo-jordan"], users["demo-riley"]])
        event.attendee_contacts.set([contacts["hollis"]])
        note = m.MeetingNote.objects.create(
            workspace=ws, event=event, contact=contacts["hollis"], opportunity=event.opportunity, title="Notes: intro call with Hollis",
            body="Wants a 3-bedroom with a garage under 390k. Pre-approval in progress with Riley. Open to viewings this week.",
            created_by=users["demo-jordan"], is_demo=True,
        )
        for t, who, days in [("Send Hollis three listings that match", "demo-jordan", 1), ("Book a viewing at 77 Sample Street", "demo-riley", 2)]:
            m.ActionItem.objects.create(workspace=ws, note=note, event=event, contact=contacts["hollis"], opportunity=event.opportunity,
                                        title=t, suggested_assignee=users[who], suggested_due_at=_at(now, days, 12), source="manual",
                                        created_by=users["demo-jordan"], is_demo=True)
        created += 4

    # --- automation: the example rules, on, owned by the manager -----------------------------------------
    created += len(seed_example_rules(ws, users["demo-morgan"], enabled=True, is_demo=True))
    return created


def _synthetic_pdf(text: str) -> bytes:
    """A tiny valid one-page PDF with a line of text (synthetic demo content)."""
    stream = f"BT /F1 12 Tf 50 750 Td ({text}) Tj ET".encode()
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
        b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for i, obj in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n".encode() + obj + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode()
    for off in offsets:
        out += f"{off:010d} 00000 n \n".encode()
    out += f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    return bytes(out)
