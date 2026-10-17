"""Real estate and lending: properties, buyer/seller roles, preferences, viewings, deal
milestones and deadlines, lending applications by role and assignment, checklists, "Request
document", staff-only decisions, internal note visibility and the audit trail."""

import datetime as dt

import pytest
from django.utils import timezone

from apps.core.models import AuditEvent
from apps.crm import models as m
from apps.crm import realestate
from apps.workspaces.models import Role

from .nexus_helpers import api_for, base, body, business_workspace, make_user, member

pytestmark = pytest.mark.django_db
ROLES = [Role.OWNER, Role.ADMIN, Role.MANAGER, Role.AGENT, Role.MEMBER, Role.READONLY]
MANAGERS = {Role.OWNER, Role.ADMIN, Role.MANAGER}


@pytest.fixture
def org():
    owner = make_user("v-owner")
    ws = business_workspace(owner, "Verticals Org", profiles=["general", "real_estate", "lending"])
    people = {Role.OWNER: owner}
    for role in ROLES[1:]:
        people[role] = member(ws, role, f"v-{role}")
    other_agent = member(ws, Role.AGENT, "v-other-agent")
    buyer = m.Contact.objects.create(workspace=ws, first_name="Bea", last_name="Buyer", owner=people[Role.AGENT], roles=["buyer"])
    seller = m.Contact.objects.create(workspace=ws, first_name="Sol", last_name="Seller", owner=people[Role.AGENT], roles=["seller"])
    re_pipeline = m.Pipeline.objects.get(workspace=ws, kind="real_estate")
    deal = m.Opportunity.objects.create(workspace=ws, name="Bea purchase", pipeline=re_pipeline, stage=re_pipeline.stages.first(),
                                        owner=people[Role.AGENT])
    m.OpportunityContact.objects.create(opportunity=deal, contact=buyer)
    return {"ws": ws, "people": people, "other_agent": other_agent, "buyer": buyer, "seller": seller, "deal": deal, "pipeline": re_pipeline}


def api(org, role):
    return api_for(org["people"][role])


def url(org, path):
    return f"{base(org['ws'])}/{path}"


# --- real estate ------------------------------------------------------------------------------------


def test_property_crud_defaults_to_manual_source_and_labels_imports(org):
    a = api(org, Role.AGENT)
    r = a.post(url(org, "properties"), {"address_line1": "12 Test Road", "city": "Exampleton", "list_price": "350000", "bedrooms": 3,
                                        "bathrooms": "2.5", "status": "active"})
    assert r.status_code == 201, r.content
    p = body(r)["data"]
    assert p["source"] == "manual" and p["source_label"] == "Entered by hand" and p["owner"]["username"] == "v-agent"
    assert p["bathrooms"] == "2.5" and p["list_price"] == "350000.00"
    # An import must say where it came from; "integration" can't be claimed by a client.
    r = a.post(url(org, "properties"), {"address_line1": "x", "source": "import"})
    assert r.status_code == 400 and "source_detail" in body(r)["error"]["fields"]
    assert a.post(url(org, "properties"), {"address_line1": "x", "source": "integration"}).status_code == 400
    r = a.post(url(org, "properties"), {"address_line1": "8 Import Way", "source": "import", "source_detail": "Spreadsheet from the office, 2026-10"})
    assert body(r)["data"]["source_label"] == "Imported (labelled)"
    r = a.patch(url(org, f"properties/{p['id']}"), {"status": "under_contract"})
    assert body(r)["data"]["status"] == "under_contract"
    lst = body(a.get(url(org, "properties"), {"q": "Test Road"}))["data"]
    assert [x["id"] for x in lst] == [p["id"]]
    # read-only people see it but can't change it
    ro = api(org, Role.READONLY)
    assert body(ro.get(url(org, f"properties/{p['id']}")))["data"]["permissions"] == {"change": False, "delete": False}
    assert ro.patch(url(org, f"properties/{p['id']}"), {"city": "x"}).status_code == 403
    assert ro.post(url(org, "properties"), {"address_line1": "x"}).status_code == 403
    assert a.delete(url(org, f"properties/{p['id']}")).status_code == 204
    actions = list(AuditEvent.objects.filter(target_id=p["id"]).order_by("id").values_list("action", flat=True))
    assert actions == ["crm.property.create", "crm.property.update", "crm.property.delete"]


def test_private_property_hidden_from_team(org):
    p = m.Property.objects.create(workspace=org["ws"], address_line1="Secret Lane", owner=org["other_agent"], visibility="private")
    for role in ROLES:
        r = api(org, role).get(url(org, f"properties/{p.pk}"))
        assert r.status_code == (200 if role in MANAGERS else 404), role


def test_buyer_seller_roles_properties_and_deal_page(org):
    a = api(org, Role.AGENT)
    p = body(a.post(url(org, "properties"), {"address_line1": "4 Deal Street"}))["data"]
    assert a.post(url(org, f"properties/{p['id']}/contacts"), {"contact_id": str(org["seller"].pk), "role": "seller"}).status_code == 201
    r = a.post(url(org, f"opportunities/{org['deal'].pk}/properties"), {"property_id": p["id"], "role": "purchase"})
    assert r.status_code == 201
    r = a.post(url(org, f"opportunities/{org['deal'].pk}/contact-roles"), {"contact_id": str(org["buyer"].pk), "role": "buyer"})
    assert body(r)["data"]["role"] == "buyer"
    a.post(url(org, f"opportunities/{org['deal'].pk}/contact-roles"), {"contact_id": str(org["seller"].pk), "role": "seller"})
    v = body(a.get(url(org, f"opportunities/{org['deal'].pk}/vertical")))["data"]
    assert {(c["display_name"], c["role"]) for c in v["contacts"]} == {("Bea Buyer", "buyer"), ("Sol Seller", "seller")}
    assert [x["property"]["id"] for x in v["properties"]] == [p["id"]] and v["properties"][0]["role"] == "purchase"
    detail = body(a.get(url(org, f"properties/{p['id']}")))["data"]
    assert detail["contacts"][0]["role"] == "seller" and detail["deals"][0]["opportunity"]["id"] == str(org["deal"].pk)
    # The other agent can't change someone else's deal.
    other = api_for(org["other_agent"])
    assert other.post(url(org, f"opportunities/{org['deal'].pk}/contact-roles"), {"contact_id": str(org["buyer"].pk), "role": "seller"}).status_code == 403


def test_preferences_matching_and_viewings_on_the_buyer_page(org):
    a = api(org, Role.AGENT)
    buyer = org["buyer"]
    r = a.put(url(org, f"contacts/{buyer.pk}/preferences"), {"budget_min": "300000", "budget_max": "400000", "bedrooms_min": 3,
                                                               "areas": ["Old Harbor"], "must_haves": ["Garden"], "timeline": "within_3_months"})
    assert r.status_code == 200, r.content
    assert body(r)["data"]["preferences"]["must_haves"] == ["Garden"]
    assert a.put(url(org, f"contacts/{buyer.pk}/preferences"), {"budget_min": "500000"}).status_code == 400  # min above max
    match = m.Property.objects.create(workspace=org["ws"], address_line1="1 Fit", city="Old Harbor", status="active", list_price=350000,
                                      bedrooms=3, owner=org["people"][Role.AGENT])
    m.Property.objects.create(workspace=org["ws"], address_line1="2 Too dear", city="Old Harbor", status="active", list_price=900000, bedrooms=3)
    m.Property.objects.create(workspace=org["ws"], address_line1="3 Sold", city="Old Harbor", status="sold", list_price=350000, bedrooms=3)
    data = body(a.get(url(org, f"contacts/{buyer.pk}/preferences")))["data"]
    assert [x["id"] for x in data["matches"]] == [str(match.pk)]
    r = a.post(url(org, f"properties/{match.pk}/viewings"), {"start_at": "2030-01-05T10:00:00Z", "contact_ids": [str(buyer.pk)]})
    assert r.status_code == 201, r.content
    ev = body(r)["data"]
    assert ev["kind"] == "viewing" and ev["related"] == {"type": "crm.property", "id": str(match.pk)}
    assert ev["end_at"] == "2030-01-05T10:45:00Z" and ev["title"].startswith("Viewing: 1 Fit")
    page = body(a.get(url(org, f"contacts/{buyer.pk}/vertical")))["data"]
    assert page["real_estate"]["preferences"]["timeline"] == "within_3_months"
    assert [v["id"] for v in page["real_estate"]["viewings"]] == [ev["id"]]
    assert page["lending"]["applications"] == []
    # read-only people see preferences but can't change them
    assert api(org, Role.READONLY).put(url(org, f"contacts/{buyer.pk}/preferences"), {"notes": "x"}).status_code == 403


def test_real_estate_endpoints_need_the_profile():
    owner = make_user("plain-owner")
    ws = business_workspace(owner, "Plain", profiles=["general"])
    r = api_for(owner).get(f"{base(ws)}/properties")
    assert r.status_code == 403 and body(r)["error"]["code"] == "feature_disabled"
    r = api_for(owner).get(f"{base(ws)}/lending/applications")
    assert r.status_code == 403 and body(r)["error"]["code"] == "feature_disabled"


def test_milestones_deadline_template_and_urgency(org):
    a = api(org, Role.AGENT)
    deal = org["deal"]
    base_date = (timezone.localdate() - dt.timedelta(days=19)).isoformat()
    r = a.post(url(org, f"opportunities/{deal.pk}/deadline-template"), {"template": "purchase", "base_date": base_date})
    assert r.status_code == 201 and len(body(r)["data"]) == 7
    assert a.post(url(org, f"opportunities/{deal.pk}/deadline-template"), {"template": "purchase"}).status_code == 201
    assert m.Milestone.objects.filter(opportunity=deal).count() == 7  # applying twice adds nothing
    v = body(a.get(url(org, f"opportunities/{deal.pk}/vertical")))["data"]
    urgency = {ms["milestone_type"]: ms["urgency"] for ms in v["milestones"]}
    assert urgency["inspection"] == "overdue" and urgency["appraisal"] == "due_soon" and urgency["closing"] == "upcoming"
    insp = next(ms for ms in v["milestones"] if ms["milestone_type"] == "inspection")
    r = a.patch(url(org, f"milestones/{insp['id']}"), {"status": "done"})
    assert body(r)["data"]["urgency"] == "done" and body(r)["data"]["completed_by"]["username"] == "v-agent"
    offer = body(a.post(url(org, "milestones"), {"opportunity_id": str(deal.pk), "category": "milestone", "milestone_type": "offer_submitted",
                                                 "title": "Offer submitted", "amount": "345000", "due_date": base_date}))["data"]
    assert offer["amount"] == "345000.00"
    assert a.post(url(org, "milestones"), {"title": "No parent"}).status_code == 400
    soon = body(a.get(url(org, "milestones"), {"due": "soon"}))["data"]
    assert {x["milestone_type"] for x in soon} >= {"appraisal"} and all(x["status"] == "pending" for x in soon)
    # Team members see the deal's milestones but can't change them.
    mem = api(org, Role.MEMBER)
    assert len(body(mem.get(url(org, "milestones"), {"opportunity": str(deal.pk), "status": "all"}))["data"]) == 8
    assert mem.patch(url(org, f"milestones/{offer['id']}"), {"title": "x"}).status_code == 403


def test_milestone_urgency_helper():
    today = dt.date(2030, 1, 10)
    ms = m.Milestone(status="pending", due_date=dt.date(2030, 1, 9))
    assert realestate.milestone_urgency(ms, today) == "overdue"
    ms.due_date = dt.date(2030, 1, 13)
    assert realestate.milestone_urgency(ms, today) == "due_soon"
    ms.due_date = dt.date(2030, 1, 20)
    assert realestate.milestone_urgency(ms, today) == "upcoming"
    ms.due_date = None
    assert realestate.milestone_urgency(ms, today) == "no_date"
    ms.status = "waived"
    assert realestate.milestone_urgency(ms, today) == "done"


# --- lending: sensitive access by role and assignment ---------------------------------------------------


def _app(org, officer_role=Role.AGENT, **extra):
    r = api(org, Role.MANAGER).post(url(org, "lending/applications"), {
        "title": "Bea mortgage", "borrowers": [{"contact_id": str(org["buyer"].pk)}], "amount_requested": "300000",
        "loan_officer_id": str(org["people"][officer_role].public_id), **extra})
    assert r.status_code == 201, r.content
    return body(r)["data"]


def test_lending_pipeline_default_stages_and_template_checklist(org):
    p = m.Pipeline.objects.get(workspace=org["ws"], kind="lending")
    assert [s.name for s in p.stages.order_by("position")] == ["Lead", "Initial Contact", "Information Requested", "Documents Pending",
                                                              "In Review", "Decision Pending", "Completed"]
    assert not p.stages.filter(name__iregex="approv|declin").exists()  # a stage is never a decision
    app = _app(org)
    assert app["reference"] == "APP-0001" and app["stage"]["name"] == "Lead"
    names = [i["name"] for i in app["checklist_items"]]
    assert "Pay stubs (last 30 days)" in names and app["checklist"]["outstanding"] == app["checklist"]["required"] > 0
    assert app["can_request_from_borrower"] is False and app["decision"] == ""
    assert _app(org)["reference"] == "APP-0002"


@pytest.mark.parametrize("role", ROLES)
def test_lending_sensitive_access_by_role(org, role):
    assigned = _app(org, Role.AGENT)
    other = _app(org, Role.MANAGER)
    a = api(org, role)
    r = a.get(url(org, "lending/applications"))
    if role in (Role.MEMBER, Role.READONLY):
        assert r.status_code == 403
        assert a.get(url(org, f"lending/applications/{assigned['id']}")).status_code == 404
        assert a.get(url(org, "lending/board")).status_code == 403
        return
    ids = {x["id"] for x in body(r)["data"]}
    if role in MANAGERS:
        assert ids == {assigned["id"], other["id"]}
    else:  # the agent: only the application assigned to them
        assert ids == {assigned["id"]}
        assert a.get(url(org, f"lending/applications/{other['id']}")).status_code == 404
    detail = a.get(url(org, f"lending/applications/{assigned['id']}"))
    assert detail.status_code == 200
    ev = AuditEvent.objects.filter(action="crm.lendingapplication.read", target_id=assigned["id"], actor=org["people"][role])
    assert ev.exists() and ev.first().metadata["reason"] == "lending_application_detail"
    # The board shows the same set.
    board = body(a.get(url(org, "lending/board")))["data"]
    on_board = {x["id"] for col in board["columns"] for x in col["applications"]}
    assert on_board == ids


def test_unassigned_broker_loses_access_and_creator_alone_is_not_enough(org):
    agent = org["people"][Role.AGENT]
    a = api_for(agent)
    r = a.post(url(org, "lending/applications"), {"title": "Own app", "borrowers": [{"contact_id": str(org["buyer"].pk)}]})
    app = body(r)["data"]
    assert app["loan_officer"]["username"] == agent.username
    # An agent can't hand the application to someone else...
    r = a.patch(url(org, f"lending/applications/{app['id']}"), {"loan_officer_id": str(org["other_agent"].public_id)})
    assert r.status_code == 403
    # ...but a manager can, and then the creator no longer sees it.
    api(org, Role.MANAGER).patch(url(org, f"lending/applications/{app['id']}"), {"loan_officer_id": str(org["other_agent"].public_id)})
    assert a.get(url(org, f"lending/applications/{app['id']}")).status_code == 404
    assert api_for(org["other_agent"]).get(url(org, f"lending/applications/{app['id']}")).status_code == 200
    # Team members can't be loan officers.
    r = api(org, Role.MANAGER).patch(url(org, f"lending/applications/{app['id']}"), {"loan_officer_id": str(org["people"][Role.MEMBER].public_id)})
    assert r.status_code == 400 and "loan_officer_id" in body(r)["error"]["fields"]


def test_decisions_are_staff_only_explicit_and_never_from_stages(org):
    app = _app(org)
    agent = api(org, Role.AGENT)
    r = agent.post(url(org, f"lending/applications/{app['id']}/decision"), {"decision": "approved", "confirm": True})
    assert r.status_code == 403
    mgr = api(org, Role.MANAGER)
    r = mgr.post(url(org, f"lending/applications/{app['id']}/decision"), {"decision": "approved", "confirm": False})
    assert r.status_code == 400 and "confirm" in body(r)["error"]["fields"]
    # Moving to the last stage records no decision.
    last = m.Stage.objects.filter(pipeline_id=app["pipeline_id"]).order_by("-position").first()
    r = agent.post(url(org, f"lending/applications/{app['id']}/move"), {"stage_id": str(last.pk)})
    assert body(r)["data"]["stage"]["name"] == "Completed" and body(r)["data"]["decision"] == ""
    r = mgr.post(url(org, f"lending/applications/{app['id']}/decision"), {"decision": "conditional", "note": "Needs appraisal", "confirm": True})
    data = body(r)["data"]
    assert data["decision"] == "conditional" and data["decision_by"]["username"] == "v-manager"
    ev = AuditEvent.objects.filter(action="crm.lendingapplication.decision", target_id=app["id"]).first()
    assert ev.metadata["fields"] == ["decision", "decision_note"] and "Needs appraisal" not in str(ev.metadata)
    hist = body(agent.get(url(org, f"lending/applications/{app['id']}/history")))["data"]
    assert [h["to_name"] for h in hist] == ["Completed", "Lead"]


def test_internal_note_visibility(org):
    app = _app(org)
    mgr, agent = api(org, Role.MANAGER), api(org, Role.AGENT)
    staff = body(agent.post(url(org, f"lending/applications/{app['id']}/notes"), {"body": "Staff note"}))["data"]
    mine = body(agent.post(url(org, f"lending/applications/{app['id']}/notes"), {"body": "My note", "visibility": "private"}))["data"]
    managers = body(mgr.post(url(org, f"lending/applications/{app['id']}/notes"), {"body": "Managers note", "visibility": "managers"}))["data"]
    # an agent asking for "managers" gets "private" (they could not read it back otherwise)
    downgraded = body(agent.post(url(org, f"lending/applications/{app['id']}/notes"), {"body": "x", "visibility": "managers"}))["data"]
    assert downgraded["visibility"] == "private"
    seen_by_agent = {n["id"] for n in body(agent.get(url(org, f"lending/applications/{app['id']}/notes")))["data"]}
    assert seen_by_agent == {staff["id"], mine["id"], downgraded["id"]}
    seen_by_mgr = {n["id"] for n in body(mgr.get(url(org, f"lending/applications/{app['id']}/notes")))["data"]}
    assert managers["id"] in seen_by_mgr and mine["id"] in seen_by_mgr
    assert agent.patch(url(org, f"lending/notes/{managers['id']}"), {"body": "x"}).status_code == 404
    assert mgr.patch(url(org, f"lending/notes/{staff['id']}"), {"body": "Edited by manager"}).status_code == 200


def test_request_document_creates_private_task_and_says_nothing_is_sent(org):
    app = _app(org)
    agent = api(org, Role.AGENT)
    item = next(i for i in app["checklist_items"] if i["name"].startswith("Pay stubs"))
    r = agent.post(url(org, f"lending/checklist/{item['id']}/request"), {"note": "Last two"})
    assert r.status_code == 200, r.content
    data = body(r)["data"]
    assert data["sent_to_borrower"] is False and "can't send" in data["notice"]
    assert data["item"]["status"] == "requested" and data["item"]["requested_by"]["username"] == "v-agent"
    task = m.Task.objects.get(pk=data["task"]["id"])
    assert task.visibility == "private" and task.assignee == org["people"][Role.AGENT]
    assert (task.related_type, task.related_id) == ("crm.lendingapplication", m.LendingApplication.objects.get(pk=app["id"]).pk)
    assert "isn't possible from Nexus yet" in task.description
    # Team members never see the lending task.
    assert api(org, Role.MEMBER).get(url(org, f"tasks/{task.pk}")).status_code == 404
    detail = body(agent.get(url(org, f"lending/applications/{app['id']}")))["data"]
    kinds = {w["kind"] for w in detail["outstanding_work"]}
    assert {"missing_document", "task"} <= kinds
    # Review: a person accepts (stamped), and the item is no longer outstanding.
    r = agent.patch(url(org, f"lending/checklist/{item['id']}"), {"status": "accepted"})
    assert body(r)["data"]["reviewed_by"]["username"] == "v-agent" and body(r)["data"]["outstanding"] is False
    assert agent.post(url(org, f"lending/checklist/{item['id']}/request"), {}).status_code == 409


def test_checklist_items_and_missing_document_indicators(org):
    app = _app(org)
    agent = api(org, Role.AGENT)
    r = agent.post(url(org, f"lending/applications/{app['id']}/checklist"), {"name": "Divorce decree", "required": False,
                                                                            "due_date": "2020-01-01"})
    assert r.status_code == 201 and body(r)["data"]["outstanding"] is False
    lst = body(agent.get(url(org, "lending/applications"), {"missing_documents": "true"}))["data"]
    assert [x["id"] for x in lst] == [app["id"]]
    for it in app["checklist_items"]:
        agent.patch(url(org, f"lending/checklist/{it['id']}"), {"status": "waived"})
    assert body(agent.get(url(org, "lending/applications"), {"missing_documents": "true"}))["data"] == []
    detail = body(agent.get(url(org, f"lending/applications/{app['id']}")))["data"]
    assert detail["checklist"]["outstanding"] == 0 and detail["checklist"]["percent"] == 100
    dash = body(agent.get(url(org, "dashboard")))["data"]
    assert dash["applications_missing_documents"] == []


def test_checklist_templates_customisable_by_managers(org):
    agent, mgr = api(org, Role.AGENT), api(org, Role.MANAGER)
    rows = body(agent.get(url(org, "lending/templates")))["data"]
    assert {t["product_type"] for t in rows} >= {"purchase", "refinance", ""}
    assert agent.post(url(org, "lending/templates"), {"name": "Mine", "items": []}).status_code == 403
    t = body(mgr.post(url(org, "lending/templates"), {"name": "Bridge loan docs", "product_type": "bridge",
                                                     "items": [{"name": "Exit plan", "required": True, "due_in_days": 5}]}))["data"]
    app = _app(org, product_type="bridge")
    assert [i["name"] for i in app["checklist_items"]] == ["Exit plan"]
    r = agent.post(url(org, f"lending/applications/{app['id']}/checklist/apply-template"), {"template_id": t["id"]})
    assert len(body(r)["data"]["checklist_items"]) == 1  # nothing duplicated


def test_lending_counts_in_reports_and_contact_page(org):
    app = _app(org)
    mgr = api(org, Role.MANAGER)
    rep = body(mgr.get(url(org, "reports/lending")))["data"]
    assert rep["available"] and rep["applications"] == 1 and rep["outstanding_required"] > 0
    assert rep["applications_missing_documents"] == 1
    page = body(api(org, Role.AGENT).get(url(org, f"contacts/{org['buyer'].pk}/vertical")))["data"]
    assert [a["id"] for a in page["lending"]["applications"]] == [app["id"]]
    assert body(api(org, Role.MEMBER).get(url(org, f"contacts/{org['buyer'].pk}/vertical")))["data"]["lending"] is None
    assert api(org, Role.AGENT).get(url(org, "reports/lending")).status_code == 403
