"""Meeting notes (explicit, with visibility) and action items confirmed into tasks by a
person; calendar event kinds; server-side reports under authz; the Home dashboard's new
sections and its connected-service extension point; the verticals migration."""

from datetime import timedelta
from types import SimpleNamespace

import pytest
from django.db import connection
from django.db.migrations.executor import MigrationExecutor
from django.utils import timezone

from apps.crm import access, home, meetings
from apps.crm import models as m
from apps.workspaces.models import Role

from .nexus_helpers import api_for, base, body, business_workspace, make_user, member

pytestmark = pytest.mark.django_db
ROLES = [Role.OWNER, Role.ADMIN, Role.MANAGER, Role.AGENT, Role.MEMBER, Role.READONLY]


@pytest.fixture
def org():
    owner = make_user("m-owner")
    ws = business_workspace(owner, "Meet Org", profiles=["general", "real_estate", "lending"])
    people = {Role.OWNER: owner}
    for role in ROLES[1:]:
        people[role] = member(ws, role, f"m-{role}")
    outsider_agent = member(ws, Role.AGENT, "m-agent2")
    c = m.Contact.objects.create(workspace=ws, first_name="Cora", last_name="Client", owner=people[Role.AGENT])
    start = timezone.now() + timedelta(hours=2)
    e = m.CalendarEvent.objects.create(workspace=ws, title="Kickoff", start_at=start, end_at=start + timedelta(hours=1),
                                       organizer=people[Role.AGENT], contact=c)
    e.attendee_users.set([people[Role.AGENT], people[Role.MEMBER]])
    return {"ws": ws, "people": people, "agent2": outsider_agent, "contact": c, "event": e}


def api(org, role):
    return api_for(org["people"][role])


def url(org, path):
    return f"{base(org['ws'])}/{path}"


def test_meeting_note_visibility(org):
    agent = api(org, Role.AGENT)
    notes = {}
    for vis in ("team", "attendees", "private"):
        r = agent.post(url(org, "meetings/notes"), {"event_id": str(org["event"].pk), "title": f"{vis} notes", "body": "Agreed next steps",
                                                    "visibility": vis})
        assert r.status_code == 201, r.content
        notes[vis] = body(r)["data"]
    assert notes["team"]["contact"]["id"] == str(org["contact"].pk)  # inherited from the meeting
    expected = {
        Role.OWNER: {"team", "attendees", "private"}, Role.MANAGER: {"team", "attendees", "private"},
        Role.AGENT: {"team", "attendees", "private"}, Role.MEMBER: {"team", "attendees"}, Role.READONLY: {"team"},
    }
    for role, vis in expected.items():
        rows = body(api(org, role).get(url(org, "meetings/notes"), {"event": str(org["event"].pk)}))["data"]
        assert {n["visibility"] for n in rows} == vis, role
    assert {n["visibility"] for n in body(api_for(org["agent2"]).get(url(org, "meetings/notes")))["data"]} == {"team"}
    assert api(org, Role.READONLY).post(url(org, "meetings/notes"), {"event_id": str(org["event"].pk), "title": "x"}).status_code == 403
    assert api(org, Role.MEMBER).patch(url(org, f"meetings/notes/{notes['team']['id']}"), {"title": "x"}).status_code == 403
    assert agent.post(url(org, "meetings/notes"), {"title": "Orphan"}).status_code == 400


def test_action_items_are_confirmed_into_tasks_by_a_person(org):
    agent = api(org, Role.AGENT)
    note = body(agent.post(url(org, "meetings/notes"), {"event_id": str(org["event"].pk), "title": "Notes"}))["data"]
    item = body(agent.post(url(org, "action-items"), {"note_id": note["id"], "title": "Send the proposal",
                                                      "suggested_assignee_id": str(org["people"][Role.MEMBER].public_id),
                                                      "suggested_due_at": "2030-02-01T10:00:00Z"}))["data"]
    assert item["status"] == "proposed" and item["source"] == "manual" and item["event"]["id"] == str(org["event"].pk)
    assert not m.Task.objects.filter(title="Send the proposal").exists()  # nothing until someone confirms
    proposed = body(api(org, Role.MEMBER).get(url(org, "action-items"), {"mine": "true"}))["data"]
    assert [p["id"] for p in proposed] == [item["id"]]
    # read-only people can see it but not turn it into a task
    assert api(org, Role.READONLY).post(url(org, f"action-items/{item['id']}/confirm"), {}).status_code == 403
    r = api(org, Role.MEMBER).post(url(org, f"action-items/{item['id']}/confirm"), {"title": "Send the proposal today"})
    assert r.status_code == 200, r.content
    data = body(r)["data"]
    task = m.Task.objects.get(pk=data["task"]["id"])
    assert task.title == "Send the proposal today" and task.source == "manual" and task.assignee == org["people"][Role.MEMBER]
    assert task.contact == org["contact"] and (task.related_type, task.related_id) == ("crm.calendarevent", org["event"].pk)
    assert data["item"]["status"] == "confirmed" and data["item"]["decided_by"]["username"] == "m-member"
    assert api(org, Role.MEMBER).post(url(org, f"action-items/{item['id']}/confirm"), {}).status_code == 409
    other = body(agent.post(url(org, "action-items"), {"event_id": str(org["event"].pk), "title": "Maybe later"}))["data"]
    assert body(agent.post(url(org, f"action-items/{other['id']}/dismiss"), {}))["data"]["status"] == "dismissed"
    assert not m.Task.objects.filter(title="Maybe later").exists()


def test_ai_suggestions_are_labelled_and_confirmed_as_such(org):
    # What the AI assistant's tool will do (server-side only; clients can't set the source).
    agent = org["people"][Role.AGENT]
    actor = access.actor_for(agent, org["ws"].pk)
    item = meetings.propose_action_item(None, actor, {"event_id": str(org["event"].pk), "title": "Call back Cora"}, source="ai_suggestion")
    r = api(org, Role.AGENT).post(url(org, "action-items"), {"title": "x", "source": "ai_suggestion"})
    assert r.status_code == 400  # not a client field
    row = body(api(org, Role.AGENT).get(url(org, "action-items")))["data"]
    assert row[0]["source"] == "ai_suggestion" and row[0]["source_label"] == "AI suggestion" and row[0]["proposed_by"]["username"] == "m-agent"
    data = body(api(org, Role.AGENT).post(url(org, f"action-items/{item.pk}/confirm"), {}))["data"]
    assert m.Task.objects.get(pk=data["task"]["id"]).source == "ai_suggestion_confirmed"


def test_event_kinds_and_upcoming_meetings(org):
    agent = api(org, Role.AGENT)
    start = timezone.now() + timedelta(days=1)
    r = agent.post(url(org, "events"), {"title": "Closing", "kind": "closing", "start_at": start.isoformat(),
                                        "end_at": (start + timedelta(hours=1)).isoformat()})
    assert body(r)["data"]["kind"] == "closing"
    assert agent.post(url(org, "events"), {"title": "x", "kind": "party", "start_at": start.isoformat(),
                                           "end_at": start.isoformat()}).status_code == 400
    kinds = {e["kind"] for e in body(agent.get(url(org, "events"), {"kind": "closing"}))["data"]}
    assert kinds == {"closing"}
    mine = body(api(org, Role.MEMBER).get(url(org, "events"), {"attending": "me"}))["data"]
    assert [e["title"] for e in mine] == ["Kickoff"]
    up = body(api(org, Role.MEMBER).get(url(org, "meetings/upcoming")))["data"]
    assert [e["title"] for e in up] == ["Kickoff"] and up[0]["note_count"] == 0
    team = body(api(org, Role.MANAGER).get(url(org, "meetings/upcoming"), {"scope": "team"}))["data"]
    assert {e["title"] for e in team} == {"Kickoff", "Closing"}


def test_existing_events_default_to_meeting_kind(org):
    assert m.CalendarEvent.objects.get(pk=org["event"].pk).kind == "meeting"


# --- reports --------------------------------------------------------------------------------------


@pytest.fixture
def pipeline_data(org):
    p = m.Pipeline.objects.get(workspace=org["ws"], kind="general")
    stages = list(p.stages.order_by("position"))
    agent = org["people"][Role.AGENT]
    m.Opportunity.objects.create(workspace=org["ws"], name="A", pipeline=p, stage=stages[0], owner=agent, value=1000)
    m.Opportunity.objects.create(workspace=org["ws"], name="B", pipeline=p, stage=stages[2], owner=agent, value=3000)
    m.Opportunity.objects.create(workspace=org["ws"], name="Hidden", pipeline=p, stage=stages[2], owner=org["agent2"], value=5000,
                                 visibility="private")
    m.Opportunity.objects.create(workspace=org["ws"], name="Won", pipeline=p, stage=stages[4], owner=agent, value=2000, status="won",
                                 closed_at=timezone.now())
    return p


@pytest.mark.parametrize("path", ["reports/pipeline", "reports/team-week", "reports/activity", "reports/tasks", "reports/lending",
                                  "reports/deadlines"])
def test_reports_are_for_managers(org, path):
    for role in ROLES:
        r = api(org, role).get(url(org, path))
        assert r.status_code == (200 if role in {Role.OWNER, Role.ADMIN, Role.MANAGER} else 403), (role, path)


def test_pipeline_report_and_team_week(org, pipeline_data):
    data = body(api(org, Role.MANAGER).get(url(org, "reports/pipeline"), {"pipeline": str(pipeline_data.pk)}))["data"]
    assert data["totals"]["open_count"] == 3 and data["totals"]["open_value"] == "9000.00" and data["totals"]["won_value"] == "2000.00"
    by_stage = {s["name"]: s for s in data["stages"]}
    assert by_stage["Proposal"]["count"] == 2 and by_stage["Proposal"]["weighted_value"] == "4000.00"
    owners = {o["owner"]["username"]: o["value"] for o in data["owners"]}
    assert owners == {"m-agent": "4000.00", "m-agent2": "5000.00"}
    week = body(api(org, Role.MANAGER).get(url(org, "reports/team-week")))["data"]
    assert week["new_count"] == 4 and week["won_count"] == 1 and week["won_value"] == "2000.00"


def test_activity_task_and_deadline_reports(org, pipeline_data):
    agent = org["people"][Role.AGENT]
    now = timezone.now()
    m.Activity.objects.create(workspace=org["ws"], kind="call", summary="c", contact=org["contact"], actor=agent)
    m.Activity.objects.create(workspace=org["ws"], kind="note", summary="n", contact=org["contact"], actor=agent)
    m.Activity.objects.create(workspace=org["ws"], kind="note", summary="old", contact=org["contact"], actor=agent,
                              occurred_at=now - timedelta(days=60))
    m.Task.objects.create(workspace=org["ws"], title="late", assignee=agent, due_at=now - timedelta(days=1))
    m.Task.objects.create(workspace=org["ws"], title="done", assignee=agent, due_at=now - timedelta(days=2), status="done",
                          completed_at=now - timedelta(days=3))
    mgr = api(org, Role.MANAGER)
    act = body(mgr.get(url(org, "reports/activity"), {"days": "30"}))["data"]
    assert act["total"] == 2 and act["by_kind"] == {"call": 1, "note": 1} and len(act["per_day"]) == 31
    assert act["by_person"][0] == {"person": act["by_person"][0]["person"], "count": 2}
    tasks = body(mgr.get(url(org, "reports/tasks")))["data"]
    assert tasks["overdue"] == 1 and tasks["completed"] == 1 and tasks["completed_on_time"] == 1 and tasks["on_time_rate"] == 50
    opp = m.Opportunity.objects.get(name="B")
    m.Milestone.objects.create(workspace=org["ws"], opportunity=opp, title="Inspection", due_date=timezone.localdate() + timedelta(days=1))
    m.Milestone.objects.create(workspace=org["ws"], opportunity=m.Opportunity.objects.get(name="Hidden"), title="Hidden deadline",
                               due_date=timezone.localdate())
    dl = body(mgr.get(url(org, "reports/deadlines")))["data"]
    assert {i["title"] for i in dl["items"]} == {"Inspection", "Hidden deadline"} and dl["due_soon"] == 2
    assert mgr.get(url(org, "reports/activity"), {"days": "13"}).status_code == 400


def test_reports_only_aggregate_what_the_actor_can_see(org, pipeline_data):
    """The functions aggregate for_actor() rows: an agent's view excludes the private deal."""
    from apps.crm import reports

    actor = access.actor_for(org["people"][Role.AGENT], org["ws"].pk)
    data = reports.pipeline_report(actor, pipeline_data)
    assert data["totals"]["open_value"] == "4000.00"


# --- Home -----------------------------------------------------------------------------------------------


def test_home_sections_and_connected_services_slot(org, monkeypatch):
    agent = api(org, Role.AGENT)
    now = timezone.now()
    today_event = m.CalendarEvent.objects.create(workspace=org["ws"], title="Today's viewing", kind="viewing",
                                                 start_at=now + timedelta(minutes=5), end_at=now + timedelta(minutes=50),
                                                 organizer=org["people"][Role.AGENT])
    p = m.Pipeline.objects.get(workspace=org["ws"], kind="real_estate")
    deal = m.Opportunity.objects.create(workspace=org["ws"], name="Deal", pipeline=p, stage=p.stages.first(), owner=org["people"][Role.AGENT])
    m.Milestone.objects.create(workspace=org["ws"], opportunity=deal, title="Appraisal", due_date=timezone.localdate() + timedelta(days=2))
    # The connected-services slot must never reach out to a provider while Home loads.
    import socket

    def no_network(*a, **k):
        raise AssertionError("Home made a network call")

    monkeypatch.setattr(socket, "create_connection", no_network)
    monkeypatch.setattr(socket.socket, "connect", no_network)
    d = body(agent.get(url(org, "dashboard")))["data"]
    assert str(today_event.pk) in {e["id"] for e in d["meetings_today"]}
    assert [x["title"] for x in d["approaching_deadlines"]] == ["Appraisal"] and d["approaching_deadlines"][0]["urgency"] == "due_soon"
    assert d["applications_missing_documents"] == []
    assert d["pipeline_summary"]["pipeline"]["name"] != "Lending"
    # The integrations team's provider (apps/integrations/health.py) fills the slot: one row
    # per service, in the agreed shape, from stored connection states only.
    rows = d["connected_services"]
    assert isinstance(rows, list) and rows
    keys = {"service", "label", "status", "status_label", "detail", "checked_at", "link", "mock", "mock_label"}
    for row in rows:
        assert set(row) == keys, row
        assert row["status"] in {"connected", "needs_reauth", "error", "not_connected", "not_configured"}
        assert row["link"] == "#/integrations" and isinstance(row["mock"], bool)
        assert (row["mock_label"] is None) == (not row["mock"])
    assert {r["service"] for r in rows} >= {"gmail", "gohighlevel", "slack"}
    # Team members have no lending access: no section at all (not an empty one).
    assert body(api(org, Role.MEMBER).get(url(org, "dashboard")))["data"]["applications_missing_documents"] is None
    # Without any provider the slot is None (nothing invented).
    monkeypatch.setattr(home, "nexus_modules", lambda name: [])
    assert body(agent.get(url(org, "dashboard")))["data"]["connected_services"] is None
    # Any app's health.service_health(actor) is picked up; a broken one doesn't break Home.
    provider = SimpleNamespace(__name__="fake.health", service_health=lambda actor: [{"service": "x", "label": "X", "status": "connected"}])
    monkeypatch.setattr(home, "nexus_modules", lambda name: [("apps.fake", provider)] if name == "health" else [])
    assert body(agent.get(url(org, "dashboard")))["data"]["connected_services"] == [{"service": "x", "label": "X", "status": "connected"}]
    broken = SimpleNamespace(__name__="broken.health", service_health=lambda actor: 1 / 0)
    monkeypatch.setattr(home, "nexus_modules", lambda name: [("apps.broken", broken)])
    assert body(agent.get(url(org, "dashboard")))["data"]["connected_services"] == []


# --- migration -------------------------------------------------------------------------------------------


@pytest.mark.django_db(transaction=True)
def test_verticals_migration_keeps_events_and_adds_the_kind():
    executor = MigrationExecutor(connection)
    leaves = executor.loader.graph.leaf_nodes()
    target = [("crm", "0001_initial"), ("automation", None)]
    try:
        executor.migrate(target)
        executor.loader.build_graph()
        old = executor.loader.project_state([("crm", "0001_initial")]).apps
        assert "crm_property" not in connection.introspection.table_names()
        assert "automation_automationrule" not in connection.introspection.table_names()
        User = old.get_model("accounts", "User")
        Workspace = old.get_model("workspaces", "Workspace")
        Event = old.get_model("crm", "CalendarEvent")
        u = User.objects.create(username="mig-user", email="mig@example.org", password="!")
        ws = Workspace.objects.create(name="Mig", slug="mig-ws", created_by=u)
        now = timezone.now()
        ev = Event.objects.create(workspace=ws, title="Old meeting", start_at=now, end_at=now)
        executor = MigrationExecutor(connection)
        executor.migrate(leaves)
        executor.loader.build_graph()
        new = executor.loader.project_state(leaves).apps
        assert new.get_model("crm", "CalendarEvent").objects.get(pk=ev.pk).kind == "meeting"
        for table in ("crm_property", "crm_lendingapplication", "crm_securedocument", "crm_meetingnote", "crm_actionitem",
                      "automation_automationrule", "automation_automationexecution", "automation_notification"):
            assert table in connection.introspection.table_names()
    finally:
        MigrationExecutor(connection).migrate(leaves)
