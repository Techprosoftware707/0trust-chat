"""Cross-team integration fixes found by the final journey (docs/nexus/FINAL-REPORT.md):

* a meeting linked to a contact or deal, and its notes, appear on that record's timeline, kept in
  step with the event or note and never more visible than they are;
* a lead imported from HighLevel says so on its timeline, runs the lead automations, and is
  flagged demo data when it came from the mock provider;
* Home's assigned leads carry their next action (the earliest open task the viewer may see).

Mock-based where HighLevel is involved (fake provider through the transport seam)."""

from datetime import timedelta

import pytest
from django.utils import timezone

from apps.automation import models as am
from apps.crm import models as m
from apps.workspaces.models import Role

from .integrations_helpers import configured_fixture, connect, fake_fixture, ibase  # noqa: F401
from .nexus_helpers import api_for, base, body, business_workspace, make_user, member

pytestmark = pytest.mark.django_db


@pytest.fixture
def org():
    owner = make_user("fi-owner", email="fi.owner@example.com")
    ws = business_workspace(owner, "Final Org", profiles=["general", "real_estate"])
    people = {"owner": owner, "manager": member(ws, Role.MANAGER, "fi-manager"), "agent": member(ws, Role.AGENT, "fi-agent"),
              "agent2": member(ws, Role.AGENT, "fi-agent2"), "readonly": member(ws, Role.READONLY, "fi-readonly")}
    contact = m.Contact.objects.create(workspace=ws, first_name="Cleo", last_name="Client", owner=people["agent"])
    return {"ws": ws, **people, "contact": contact}


def timeline(org, who, contact):
    return body(api_for(org[who]).get(f"{base(org['ws'])}/activities", {"contact": str(contact.pk), "limit": 200}))["data"]


def system_rows(related_type, pk):
    return m.Activity.objects.filter(source="system", related_type=related_type, related_id=pk)


def new_event(org, who="agent", **kw):
    start = timezone.now() + timedelta(days=1)
    data = {"title": "Intro call with Cleo", "start_at": start.isoformat(), "end_at": (start + timedelta(hours=1)).isoformat(),
            "contact_id": str(org["contact"].pk), **kw}
    r = api_for(org[who]).post(f"{base(org['ws'])}/events", data)
    assert r.status_code == 201, r.content
    return body(r)["data"]


# --- meetings and notes on the timeline -------------------------------------------------------------


def test_a_meeting_with_a_contact_is_on_their_timeline_and_follows_the_event(org):
    api = api_for(org["agent"])
    e = new_event(org)
    rows = system_rows("crm.calendarevent", e["id"])
    assert rows.count() == 1
    a = rows.get()
    assert (a.kind, a.summary, a.contact_id, a.actor, a.untrusted) == ("meeting", "Meeting scheduled: Intro call with Cleo", org["contact"].pk,
                                                                         org["agent"], False)
    # Everyone who may see the contact sees the entry (read-only people too), linked to the meeting.
    for who in ("agent", "readonly", "manager"):
        mine = [x for x in timeline(org, who, org["contact"]) if x["id"] == str(a.pk)]
        assert mine and mine[0]["related"] == {"type": "crm.calendarevent", "id": e["id"]}, who
    url = f"{base(org['ws'])}/events/{e['id']}"
    assert api.patch(url, {"title": "Intro call (moved)", "status": "canceled"}).status_code == 200
    a.refresh_from_db()
    assert a.summary == "Meeting canceled: Intro call (moved)" and system_rows("crm.calendarevent", e["id"]).count() == 1
    # Private: the entry goes (its title must not show to people who can't see the event), and comes back.
    assert api.patch(url, {"visibility": "private"}).status_code == 200
    assert not system_rows("crm.calendarevent", e["id"]).exists()
    assert api.patch(url, {"visibility": "team", "status": "scheduled"}).status_code == 200
    assert system_rows("crm.calendarevent", e["id"]).get().summary == "Meeting scheduled: Intro call (moved)"
    # Moved to a deal only: the entry moves with it.
    deal = m.Opportunity.objects.create(workspace=org["ws"], name="Cleo deal", pipeline=m.Pipeline.objects.filter(workspace=org["ws"]).first(),
                                        stage=m.Stage.objects.filter(pipeline__workspace=org["ws"]).first(), owner=org["agent"])
    assert api.patch(url, {"contact_id": None, "opportunity_id": str(deal.pk)}).status_code == 200
    a = system_rows("crm.calendarevent", e["id"]).get()
    assert a.contact_id is None and a.opportunity_id == deal.pk
    assert api.delete(url).status_code == 204
    assert not system_rows("crm.calendarevent", e["id"]).exists()


def test_private_and_unlinked_meetings_never_reach_a_timeline(org):
    private = new_event(org, visibility="private", title="Private chat with Cleo")
    unlinked = new_event(org, contact_id=None, title="Team stand-up")
    assert not system_rows("crm.calendarevent", private["id"]).exists()
    assert not system_rows("crm.calendarevent", unlinked["id"]).exists()
    assert not [x for x in timeline(org, "readonly", org["contact"]) if "Private chat" in x["summary"]]


def test_a_viewing_reaches_the_buyer_timeline(org):
    prop = m.Property.objects.create(workspace=org["ws"], address_line1="1 Example Street", owner=org["agent"])
    start = timezone.now() + timedelta(days=2)
    r = api_for(org["agent"]).post(f"{base(org['ws'])}/properties/{prop.pk}/viewings",
                                   {"start_at": start.isoformat(), "contact_ids": [str(org["contact"].pk)]})
    assert r.status_code == 201, r.content
    assert system_rows("crm.calendarevent", body(r)["data"]["id"]).get().summary.startswith("Viewing scheduled: ")


def test_meeting_notes_are_on_the_timeline_only_when_shared_with_the_team(org):
    agent = api_for(org["agent"])
    e = new_event(org)
    notes = {}
    for vis in ("team", "attendees", "private"):
        r = agent.post(f"{base(org['ws'])}/meetings/notes", {"event_id": e["id"], "title": f"{vis} notes", "body": f"Agreed: {vis}", "visibility": vis})
        assert r.status_code == 201, r.content
        notes[vis] = body(r)["data"]
    shared = system_rows("crm.meetingnote", notes["team"]["id"]).get()
    assert (shared.kind, shared.summary, shared.body, shared.contact_id) == ("note", "Meeting notes: team notes", "Agreed: team", org["contact"].pk)
    assert shared.metadata["event_id"] == e["id"]
    assert not system_rows("crm.meetingnote", notes["attendees"]["id"]).exists()
    assert not system_rows("crm.meetingnote", notes["private"]["id"]).exists()
    ro = [x["summary"] for x in timeline(org, "readonly", org["contact"])]
    assert "Meeting notes: team notes" in ro and not any(s.startswith("Meeting notes: attendees") or "private notes" in s for s in ro)
    # Edits follow; going private removes it; a private meeting hides its notes too.
    nurl = f"{base(org['ws'])}/meetings/notes/{notes['team']['id']}"
    assert agent.patch(nurl, {"body": "Agreed: send the checklist"}).status_code == 200
    assert system_rows("crm.meetingnote", notes["team"]["id"]).get().body == "Agreed: send the checklist"
    assert agent.patch(nurl, {"visibility": "private"}).status_code == 200
    assert not system_rows("crm.meetingnote", notes["team"]["id"]).exists()
    assert agent.patch(nurl, {"visibility": "team"}).status_code == 200
    manager = api_for(org["manager"])  # whoever changes the meeting, the entries stay the author's
    assert manager.patch(f"{base(org['ws'])}/events/{e['id']}", {"visibility": "private"}).status_code == 200
    assert not system_rows("crm.meetingnote", notes["team"]["id"]).exists()
    assert manager.patch(f"{base(org['ws'])}/events/{e['id']}", {"visibility": "team"}).status_code == 200
    back = system_rows("crm.meetingnote", notes["team"]["id"]).get()
    assert back.actor == org["agent"] and system_rows("crm.calendarevent", e["id"]).get().actor == org["agent"]
    # Deleting the note, or the meeting (its notes go with it), clears the timeline.
    assert agent.delete(nurl).status_code == 204
    assert not system_rows("crm.meetingnote", notes["team"]["id"]).exists()
    r = agent.post(f"{base(org['ws'])}/meetings/notes", {"event_id": e["id"], "title": "Second", "visibility": "team"})
    second = body(r)["data"]["id"]
    assert system_rows("crm.meetingnote", second).get().summary == "Meeting notes: Second"
    r = agent.post(f"{base(org['ws'])}/meetings/notes", {"event_id": e["id"], "title": "Notes: Intro call with Cleo", "visibility": "team"})
    assert system_rows("crm.meetingnote", body(r)["data"]["id"]).get().summary == "Notes: Intro call with Cleo"  # the app's default title
    assert agent.delete(f"{base(org['ws'])}/events/{e['id']}").status_code == 204
    assert not system_rows("crm.meetingnote", second).exists() and not system_rows("crm.calendarevent", e["id"]).exists()


def test_timeline_entries_of_meetings_stay_in_their_workspace(org):
    e = new_event(org)
    outsider = make_user("fi-outsider")
    other = business_workspace(outsider, "Other Final Org")
    rows = body(api_for(outsider).get(f"{base(other)}/activities", {"limit": 200}))["data"]
    assert not [a for a in rows if (a["related"] or {}).get("id") == e["id"]]
    # And a person of the other workspace can't read this workspace's timeline at all.
    assert api_for(outsider).get(f"{base(org['ws'])}/activities").status_code == 404


# --- HighLevel import -> lead automation -> timeline -------------------------------------------------


@pytest.fixture
def ghl(org, fake, configured):
    return connect(fake, org["owner"], org["ws"], "gohighlevel", account="mockLocation001")


def routing_rule(org):
    r = api_for(org["manager"]).post(f"/api/v1/workspaces/{org['ws'].pk}/automation/rules", {
        "name": "New leads go to the agent", "trigger": "lead.created", "enabled": True,
        "actions": [{"type": "assign_owner", "params": {"user_id": str(org["agent"].public_id), "only_if_unassigned": False}},
                    {"type": "create_task", "params": {"title": "Follow up with new lead {contact.name}", "assignee": "subject_owner",
                                                       "due_in_hours": 24, "priority": "high"}}]})
    assert r.status_code == 201, r.content


@pytest.mark.parametrize("mock", [False, True])
def test_highlevel_import_runs_the_lead_automation_and_lands_on_the_timeline(org, ghl, mock, django_capture_on_commit_callbacks):
    ghl.is_mock = mock
    ghl.save(update_fields=["is_mock"])
    routing_rule(org)
    with django_capture_on_commit_callbacks(execute=True):
        r = api_for(org["owner"]).post(f"{ibase(org['ws'])}/ghl/contacts/mockContact02/import")
    assert r.status_code == 201, r.content
    pat = m.Contact.objects.get(pk=body(r)["data"]["contact"]["id"])
    assert (pat.display_name, pat.kind, pat.source, pat.owner) == ("Pat Mockperson", "lead", "GoHighLevel", org["agent"])
    assert pat.is_demo is mock  # mock-provider data is labelled demo data and goes with the demo reset
    task = m.Task.objects.get(contact=pat)
    assert (task.assignee, task.source, task.title) == (org["agent"], "automation", "Follow up with new lead Pat Mockperson")
    assert timezone.now() + timedelta(hours=23) < task.due_at < timezone.now() + timedelta(hours=25)
    # The agent is told in the app (the lead and its task, grouped into one notification per rule).
    assert am.Notification.objects.filter(recipient=org["agent"], event_type="assignment").exists()
    rows = {a["summary"]: a for a in timeline(org, "agent", pat)}
    imported = rows["Imported from HighLevel as a new contact"]
    assert (imported["kind"], imported["source"], imported["untrusted"], imported["actor"], imported["is_demo"]) == (
        "integration_event", "gohighlevel", True, None, mock)
    assert "Task created by an automation: Follow up with new lead Pat Mockperson" in rows
    order = [a["summary"] for a in timeline(org, "agent", pat)]  # newest first: the import comes before what the automation did
    assert order.index("Imported from HighLevel as a new contact") > order.index("Task created by an automation: Follow up with new lead Pat Mockperson")
    pat.refresh_from_db()
    assert pat.last_activity_at is None or pat.last_activity_at <= task.created_at + timedelta(seconds=5)  # an import is not contact
    # A second import of the same HighLevel contact is refused and adds nothing.
    assert api_for(org["owner"]).post(f"{ibase(org['ws'])}/ghl/contacts/mockContact02/import").status_code == 409
    assert m.Activity.objects.filter(contact=pat, kind="integration_event").count() == 1


# --- Home: the next action of each assigned lead -------------------------------------------------------


def test_home_assigned_leads_show_their_next_open_task(org):
    now = timezone.now()
    lead = m.Contact.objects.create(workspace=org["ws"], first_name="Lana", last_name="Lead", kind="lead", owner=org["agent"])
    m.Contact.objects.create(workspace=org["ws"], first_name="Quinn", last_name="Quiet", kind="lead", owner=org["agent"])

    def task(title, due, **kw):
        return m.Task.objects.create(workspace=org["ws"], title=title, due_at=due, contact=lead, assignee=kw.pop("assignee", org["agent"]), **kw)

    task("Later", now + timedelta(days=3))
    soon = task("Call Lana back", now + timedelta(hours=5))
    task("No date", None)
    task("Already done", now - timedelta(days=1), status="done")
    task("Someone else's private reminder", now + timedelta(hours=1), assignee=org["agent2"], visibility="private")
    d = body(api_for(org["agent"]).get(f"{base(org['ws'])}/dashboard"))["data"]
    leads = {c["display_name"]: c for c in d["assigned_leads"]}
    nxt = leads["Lana Lead"]["next_task"]
    assert (nxt["id"], nxt["title"], nxt["is_overdue"], nxt["assignee"]["username"]) == (str(soon.pk), "Call Lana back", False, "fi-agent")
    assert leads["Quinn Quiet"]["next_task"] is None
    # A manager sees every task, so their next action for the lead is the earliest of all.
    d = body(api_for(org["manager"]).get(f"{base(org['ws'])}/dashboard", {"scope": "team"}))["data"]
    assert {c["display_name"]: c for c in d["assigned_leads"]}["Lana Lead"]["next_task"]["title"] == "Someone else's private reminder"
    # Overdue is flagged.
    soon.due_at = now - timedelta(hours=2)
    soon.save()
    d = body(api_for(org["agent"]).get(f"{base(org['ws'])}/dashboard"))["data"]
    nxt = {c["display_name"]: c for c in d["assigned_leads"]}["Lana Lead"]["next_task"]
    assert nxt["title"] == "Call Lana back" and nxt["is_overdue"] is True
