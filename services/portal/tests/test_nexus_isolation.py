"""Tenant isolation: a user of workspace A can never read or change workspace B's records,
whatever ID, filter, search term or nested ID they send. Covers every CRM model and
endpoint. Cross-tenant IDs answer exactly like IDs that don't exist (404 for URLs, the same
validation error for bodies)."""

import json
import uuid
from datetime import timedelta

import pytest
from django.utils import timezone

from apps.automation import models as am
from apps.crm import access
from apps.crm import models as m
from apps.crm.services import create_default_pipeline
from apps.workspaces.models import Role

from .nexus_helpers import api_for, base, body, business_workspace, make_user, member

pytestmark = pytest.mark.django_db
ROOM_B = "!secretroomB:lumen.test"


@pytest.fixture
def world():
    a_owner = make_user("a-owner")
    ws_a = business_workspace(a_owner, "Org A", profiles=["general", "real_estate", "lending"])
    a_agent = member(ws_a, Role.AGENT, "a-agent")
    b_owner = make_user("b-owner")
    ws_b = business_workspace(b_owner, "Org B", profiles=["general", "real_estate"])
    b_agent = member(ws_b, Role.AGENT, "b-agent")
    p = m.Pipeline.objects.filter(workspace=ws_b).first()
    st = p.stages.order_by("position").first()
    st2 = p.stages.order_by("position")[1]
    tag = m.Tag.objects.create(workspace=ws_b, name="Zebra-tag-B")
    fd = m.FieldDefinition.objects.create(workspace=ws_b, entity="contact", key="secret_b", label="Secret B", field_type="text")
    c = m.Contact.objects.create(workspace=ws_b, first_name="Bartholomew", last_name="Uniquename", email="bart@example.net", owner=b_owner,
                                 custom_fields={"secret_b": "x"}, follow_up_at=timezone.now() - timedelta(days=1))
    c.tags.add(tag)
    c.assignees.add(b_agent)
    o = m.Opportunity.objects.create(workspace=ws_b, name="Uniquename deal", pipeline=p, stage=st, owner=b_owner, value=100)
    m.OpportunityContact.objects.create(opportunity=o, contact=c)
    t = m.Task.objects.create(workspace=ws_b, title="Uniquename task", assignee=b_owner, contact=c, opportunity=o, due_at=timezone.now())
    a = m.Activity.objects.create(workspace=ws_b, kind="note", summary="Uniquename note", contact=c, opportunity=o, task=t)
    e = m.CalendarEvent.objects.create(workspace=ws_b, title="Uniquename meeting", start_at=timezone.now(),
                                       end_at=timezone.now() + timedelta(hours=1), organizer=b_owner, contact=c)
    link = m.ConversationLink.objects.create(workspace=ws_b, room_id=ROOM_B, contact=c)
    mp = m.ExternalRecordMapping.objects.create(workspace=ws_b, provider="gmail", external_id="ext-b-1", object_type="crm.contact", object_id=c.pk)
    rl = m.RecordLink.objects.create(workspace=ws_b, from_type="crm.contact", from_id=c.pk, to_type="crm.opportunity", to_id=o.pk)
    hist = m.StageHistory.objects.create(workspace=ws_b, opportunity=o, to_stage=st, to_name=st.name)
    # AI assistant and MCP connector rows of workspace B (apps.assistant, apps.mcp).
    from allauth.idp.oidc.models import Client as OidcClient

    from apps.assistant.models import AIInteraction, AISettings, PendingAction
    from apps.mcp.models import McpGrant

    AISettings.objects.create(workspace=ws_b, mcp_enabled=True)
    pa = PendingAction.objects.create(workspace=ws_b, created_by=b_owner, channel="assistant", action="create_note",
                                      payload={"kind": "note", "summary": "Uniquename AI note", "contact_id": str(c.pk)},
                                      payload_hash="0" * 64, expires_at=timezone.now() + timedelta(minutes=5))
    ai = AIInteraction.objects.create(workspace=ws_b, created_by=b_owner, channel="assistant", provider="dev", tool_names=["search_contacts"],
                                      record_refs=[{"type": "crm.contact", "id": str(c.pk)}])
    mcp_client = OidcClient.objects.create(id="isolation-mcp-client", name="Claude", type=OidcClient.Type.PUBLIC, data={"mcp": True, "dcr": True})
    grant = McpGrant.objects.create(workspace=ws_b, created_by=b_owner, user=b_owner, client=mcp_client, scopes=["mcp:read"])
    # Verticals, meetings and automation rows of workspace B (all named "Uniquename" so leaks show).
    prop = m.Property.objects.create(workspace=ws_b, address_line1="1 Uniquename Street", city="Uniquename City", owner=b_owner)
    prop_contact = m.PropertyContact.objects.create(workspace=ws_b, property=prop, contact=c, role="seller")
    opp_prop = m.OpportunityProperty.objects.create(workspace=ws_b, opportunity=o, property=prop, role="listing")
    pref = m.ClientPreference.objects.create(workspace=ws_b, contact=c, must_haves=["Uniquename garden"])
    milestone = m.Milestone.objects.create(workspace=ws_b, opportunity=o, title="Uniquename inspection", due_date=timezone.localdate())
    lp = create_default_pipeline(ws_b, "lending", user=b_owner)
    lstages = list(lp.stages.order_by("position"))
    app = m.LendingApplication.objects.create(workspace=ws_b, reference="APP-0001", title="Uniquename loan", pipeline=lp, stage=lstages[0],
                                              loan_officer=b_agent, amount_requested=1000)
    m.ApplicationBorrower.objects.create(workspace=ws_b, application=app, contact=c)
    lhist = m.LendingStageHistory.objects.create(workspace=ws_b, application=app, to_stage=lstages[0], to_name=lstages[0].name)
    app_note = m.ApplicationNote.objects.create(workspace=ws_b, application=app, body="Uniquename note", created_by=b_owner)
    template = m.ChecklistTemplate.objects.create(workspace=ws_b, name="Uniquename template", items=[{"name": "ID", "required": True}])
    item = m.DocumentChecklistItem.objects.create(workspace=ws_b, application=app, name="Uniquename pay stubs")
    doc = m.SecureDocument.objects.create(workspace=ws_b, application=app, checklist_item=item, original_name="uniquename.pdf",
                                          content_type="application/pdf", size=10, storage_name="0" * 48 + ".bin", key_id="x", wrapped_key="x")
    doc_grant = m.DocumentDownloadGrant.objects.create(workspace=ws_b, document=doc, user=b_owner, expires_at=timezone.now() + timedelta(minutes=1))
    doc_log = m.DocumentAccessLog.objects.create(workspace=ws_b, application=app, document=doc, document_name="uniquename.pdf", action="upload")
    mnote = m.MeetingNote.objects.create(workspace=ws_b, event=e, contact=c, title="Uniquename meeting notes", body="x", created_by=b_owner)
    aitem = m.ActionItem.objects.create(workspace=ws_b, note=mnote, event=e, contact=c, title="Uniquename next step", created_by=b_owner)
    rule = am.AutomationRule.objects.create(workspace=ws_b, name="Uniquename rule", trigger="lead.created", created_by=b_owner,
                                            actions=[{"type": "notify_user", "params": {"recipient": "rule_owner", "title": "x"}}])
    aevent = am.AutomationEvent.objects.create(workspace=ws_b, event_type="lead.created", dedup_key="k", subject_type="crm.contact", subject_id=c.pk)
    execution = am.AutomationExecution.objects.create(workspace=ws_b, rule=rule, event=aevent, dedup_key="k", status="failed")
    notification = am.Notification.objects.create(workspace=ws_b, recipient=b_owner, event_type="assignment", title="Uniquename notice")
    pref_row = am.NotificationPreference.objects.create(workspace=ws_b, user=b_owner, muted=True)
    org_pref = am.NotificationPreference.objects.create(workspace=ws_b, user=None, grouping=False)
    return {
        "pending_action": pa, "ai_interaction": ai, "grant": grant,
        "ws_a": ws_a, "ws_b": ws_b, "a_owner": a_owner, "a_agent": a_agent, "b_owner": b_owner, "b_agent": b_agent,
        "pipeline": p, "stage": st, "stage2": st2, "tag": tag, "field": fd, "contact": c, "opp": o, "task": t, "activity": a,
        "event": e, "link": link, "mapping": mp, "record_link": rl, "history": hist,
        "property": prop, "property_contact": prop_contact, "opp_property": opp_prop, "preference": pref, "milestone": milestone,
        "lending_pipeline": lp, "lending_stage": lstages[0], "lending_stage2": lstages[1], "application": app, "lending_history": lhist,
        "app_note": app_note, "template": template, "checklist_item": item, "document": doc, "doc_grant": doc_grant, "doc_log": doc_log,
        "meeting_note": mnote, "action_item": aitem, "rule": rule, "automation_event": aevent, "execution": execution,
        "notification": notification, "notification_pref": pref_row, "org_pref": org_pref,
    }


def _err(r):
    data = body(r)["error"]
    data.pop("request_id", None)
    return r.status_code, data


def test_access_layer_never_returns_other_workspace_rows(world):
    """for_actor() of every registered model, for every action and role, is workspace-scoped."""
    for role in Role.values:
        ms = world["ws_a"].memberships.first()
        ms.role = role
        actor = access.Actor(user=world["a_owner"], membership=ms)
        for model in list(access._POLICIES):
            for action in access.ACTIONS:
                assert not access.for_actor(actor, model, action).filter(workspace=world["ws_b"]).exists(), (role, model, action)


DETAIL_GETS = [
    "contacts/{contact}", "contacts/{contact}/summary", "pipelines/{pipeline}", "pipelines/{pipeline}/board",
    "opportunities/{opp}", "opportunities/{opp}/history", "tasks/{task}", "activities/{activity}", "events/{event}",
    # verticals, meetings
    "properties/{property}", "properties/{property}/viewings", "opportunities/{opp}/vertical", "contacts/{contact}/preferences",
    "contacts/{contact}/vertical", "lending/applications/{application}", "lending/applications/{application}/history",
    "lending/applications/{application}/notes", "lending/applications/{application}/documents",
    "lending/applications/{application}/access-log", "meetings/notes/{meeting_note}",
]
WRITES = [
    ("patch", "contacts/{contact}", {"first_name": "Pwned"}),
    ("delete", "contacts/{contact}", None),
    ("patch", "tags/{tag}", {"name": "Pwned"}),
    ("delete", "tags/{tag}", None),
    ("patch", "fields/{field}", {"label": "Pwned"}),
    ("delete", "fields/{field}", None),
    ("patch", "pipelines/{pipeline}", {"name": "Pwned"}),
    ("delete", "pipelines/{pipeline}", None),
    ("post", "pipelines/{pipeline}/stages", {"name": "Pwned"}),
    ("post", "pipelines/{pipeline}/stage-order", {"stage_ids": []}),
    ("patch", "stages/{stage}", {"name": "Pwned"}),
    ("delete", "stages/{stage}", None),
    ("patch", "opportunities/{opp}", {"name": "Pwned"}),
    ("delete", "opportunities/{opp}", None),
    ("post", "opportunities/{opp}/move", {"stage_id": "{stage2}"}),
    ("patch", "tasks/{task}", {"status": "done"}),
    ("delete", "tasks/{task}", None),
    ("patch", "activities/{activity}", {"summary": "Pwned"}),
    ("delete", "activities/{activity}", None),
    ("patch", "events/{event}", {"title": "Pwned"}),
    ("delete", "events/{event}", None),
    ("delete", "room-links/{link}", None),
    # verticals, meetings
    ("patch", "properties/{property}", {"city": "Pwned"}),
    ("delete", "properties/{property}", None),
    ("post", "properties/{property}/contacts", {"contact_id": "{contact}"}),
    ("post", "properties/{property}/viewings", {"start_at": "2030-01-01T10:00:00Z"}),
    ("delete", "property-contacts/{property_contact}", None),
    ("post", "opportunities/{opp}/properties", {"property_id": "{property}"}),
    ("post", "opportunities/{opp}/contact-roles", {"contact_id": "{contact}", "role": "buyer"}),
    ("post", "opportunities/{opp}/deadline-template", {"template": "purchase"}),
    ("delete", "opportunity-properties/{opp_property}", None),
    ("put", "contacts/{contact}/preferences", {"budget_max": "1"}),
    ("patch", "milestones/{milestone}", {"title": "Pwned"}),
    ("delete", "milestones/{milestone}", None),
    ("patch", "lending/applications/{application}", {"title": "Pwned"}),
    ("delete", "lending/applications/{application}", None),
    ("post", "lending/applications/{application}/move", {"stage_id": "{lending_stage2}"}),
    ("post", "lending/applications/{application}/decision", {"decision": "approved", "confirm": True}),
    ("post", "lending/applications/{application}/notes", {"body": "Pwned"}),
    ("post", "lending/applications/{application}/checklist", {"name": "Pwned"}),
    ("post", "lending/applications/{application}/checklist/apply-template", {"template_id": "{template}"}),
    ("post", "lending/applications/{application}/deadline-template", {}),
    ("patch", "lending/notes/{app_note}", {"body": "Pwned"}),
    ("delete", "lending/notes/{app_note}", None),
    ("patch", "lending/checklist/{checklist_item}", {"status": "accepted"}),
    ("delete", "lending/checklist/{checklist_item}", None),
    ("post", "lending/checklist/{checklist_item}/request", {}),
    ("delete", "lending/documents/{document}", None),
    ("post", "lending/documents/{document}/download-token", {}),
    ("patch", "lending/templates/{template}", {"name": "Pwned"}),
    ("delete", "lending/templates/{template}", None),
    ("patch", "meetings/notes/{meeting_note}", {"title": "Pwned"}),
    ("delete", "meetings/notes/{meeting_note}", None),
    ("patch", "action-items/{action_item}", {"title": "Pwned"}),
    ("delete", "action-items/{action_item}", None),
    ("post", "action-items/{action_item}/confirm", {}),
    ("post", "action-items/{action_item}/dismiss", {}),
]


def _fmt(world, template):
    return template.format(**{k: getattr(v, "pk", v) for k, v in world.items()})


def _fmt_body(world, data):
    if data is None:
        return None
    return {k: _fmt(world, v) if isinstance(v, str) else v for k, v in data.items()}


@pytest.mark.parametrize("who", ["a_owner", "a_agent"])
@pytest.mark.parametrize("path", DETAIL_GETS)
def test_other_workspace_objects_are_404(world, who, path):
    api = api_for(world[who])
    r = api.get(f"{base(world['ws_a'])}/{_fmt(world, path)}")
    missing = api.get(f"{base(world['ws_a'])}/{path.format(**{k: uuid.uuid4() for k in world})}")
    assert r.status_code == 404
    assert _err(r) == _err(missing)  # indistinguishable from an ID that doesn't exist


@pytest.mark.parametrize("method,path,data", WRITES)
def test_other_workspace_objects_cannot_be_changed(world, method, path, data):
    api = api_for(world["a_owner"])
    url = f"{base(world['ws_a'])}/{_fmt(world, path)}"
    r = getattr(api, method)(url, _fmt_body(world, data)) if data is not None else getattr(api, method)(url)
    assert r.status_code == 404, (method, path, r.content)
    # Nothing in B changed.
    world["contact"].refresh_from_db()
    assert world["contact"].first_name == "Bartholomew"
    assert m.Tag.objects.get(pk=world["tag"].pk).name == "Zebra-tag-B"
    assert m.Pipeline.objects.get(pk=world["pipeline"].pk).name != "Pwned"
    assert m.Opportunity.objects.get(pk=world["opp"].pk).stage_id == world["stage"].pk
    assert m.Task.objects.get(pk=world["task"].pk).status == "open"
    assert m.ConversationLink.objects.filter(pk=world["link"].pk).exists()
    assert m.Stage.objects.filter(pipeline=world["pipeline"]).count() == 6
    world["property"].refresh_from_db()
    world["application"].refresh_from_db()
    assert world["property"].city == "Uniquename City" and world["application"].title == "Uniquename loan"
    assert world["application"].stage_id == world["lending_stage"].pk and world["application"].decision == ""
    assert m.ApplicationNote.objects.filter(application=world["application"]).count() == 1
    assert m.DocumentChecklistItem.objects.get(pk=world["checklist_item"].pk).status == "pending"
    assert m.DocumentChecklistItem.objects.filter(application=world["application"]).count() == 1
    assert m.SecureDocument.objects.filter(pk=world["document"].pk).exists()
    assert m.DocumentDownloadGrant.objects.filter(document=world["document"]).count() == 1
    assert m.Milestone.objects.get(pk=world["milestone"].pk).title == "Uniquename inspection"
    assert m.Milestone.objects.filter(opportunity=world["opp"]).count() == 1
    assert m.PropertyContact.objects.filter(property=world["property"]).count() == 1
    assert m.OpportunityProperty.objects.filter(pk=world["opp_property"].pk).exists()
    assert m.ClientPreference.objects.get(pk=world["preference"].pk).budget_max is None
    assert m.ChecklistTemplate.objects.get(pk=world["template"].pk).name == "Uniquename template"
    assert m.MeetingNote.objects.get(pk=world["meeting_note"].pk).title == "Uniquename meeting notes"
    assert m.ActionItem.objects.get(pk=world["action_item"].pk).status == "proposed"
    assert not m.CalendarEvent.objects.filter(workspace=world["ws_b"], kind="viewing").exists()


LISTS = ["dashboard", "search?q=x", "contacts", "tags", "fields", "pipelines", "opportunities", "tasks", "activities", "events",
         "room-links?room_id=!x:lumen.test", "mappings",
         "properties", "milestones", "lending/applications", "lending/board", "lending/templates", "meetings/upcoming", "meetings/notes",
         "action-items", "reports/pipeline", "reports/team-week", "reports/activity", "reports/tasks", "reports/lending", "reports/deadlines"]


@pytest.mark.parametrize("path", LISTS + ["", "settings", "members"])
def test_other_workspace_id_in_url_is_404(world, path):
    api = api_for(world["a_owner"])
    if path in ("", "settings", "members"):
        url = f"/api/v1/workspaces/{world['ws_b'].pk}" + (f"/{path}" if path else "")
    else:
        url = f"{base(world['ws_b'])}/{path}"
    r = api.get(url)
    assert r.status_code == 404
    assert api.patch(f"/api/v1/workspaces/{world['ws_b'].pk}/settings", {"save_to_record_enabled": True}).status_code == 404
    assert api.post(f"{base(world['ws_b'])}/contacts", {"first_name": "Intruder"}).status_code == 404
    assert not m.Contact.objects.filter(first_name="Intruder").exists()


FILTERS = [
    ("contacts", {"owner": "{b_owner}"}), ("contacts", {"assignee": "{b_agent}"}), ("contacts", {"tag": "{tag}"}),
    ("opportunities", {"pipeline": "{pipeline}"}), ("opportunities", {"stage": "{stage}"}), ("opportunities", {"contact": "{contact}"}),
    ("opportunities", {"owner": "{b_owner}"}), ("tasks", {"contact": "{contact}", "scope": "team"}),
    ("tasks", {"opportunity": "{opp}", "scope": "team"}), ("tasks", {"assignee": "{b_owner}", "scope": "team"}),
    ("activities", {"contact": "{contact}"}), ("activities", {"opportunity": "{opp}"}), ("activities", {"task": "{task}"}),
    ("events", {"contact": "{contact}"}), ("events", {"organizer": "{b_owner}"}), ("room-links", {"contact": "{contact}"}),
    ("room-links", {"opportunity": "{opp}"}), ("pipelines/{pipeline}/board", {}),
    ("properties", {"contact": "{contact}"}), ("properties", {"owner": "{b_owner}"}), ("milestones", {"opportunity": "{opp}"}),
    ("milestones", {"application": "{application}"}), ("lending/applications", {"stage": "{lending_stage}"}),
    ("lending/applications", {"pipeline": "{lending_pipeline}"}), ("lending/applications", {"officer": "{b_agent}"}),
    ("lending/board", {"pipeline": "{lending_pipeline}"}), ("meetings/notes", {"event": "{event}"}), ("meetings/notes", {"contact": "{contact}"}),
    ("meetings/notes", {"opportunity": "{opp}"}), ("action-items", {"event": "{event}", "status": "all"}),
    ("action-items", {"note": "{meeting_note}", "status": "all"}), ("reports/pipeline", {"pipeline": "{pipeline}"}),
]


def _ids(r):
    return {row["id"] for row in body(r)["data"]} if r.status_code == 200 else set()


@pytest.mark.parametrize("path,params", FILTERS)
def test_filters_with_other_workspace_ids_leak_nothing(world, path, params):
    api = api_for(world["a_owner"])
    q = {}
    for k, v in params.items():
        q[k] = _fmt(world, v) if k not in {"owner", "assignee", "organizer", "officer"} else str(world[v.strip("{}")].public_id)
    r = api.get(f"{base(world['ws_a'])}/{_fmt(world, path)}", q)
    assert r.status_code in (400, 404), r.content
    b_ids = {str(world[k].pk) for k in ("contact", "opp", "task", "activity", "event", "link", "tag", "property", "milestone", "application",
                                        "meeting_note", "action_item")}
    assert not (_ids(r) & b_ids)
    assert b"Uniquename" not in r.content and b"Bartholomew" not in r.content


def test_room_link_lookup_by_room_id_leaks_nothing(world):
    r = api_for(world["a_owner"]).get(f"{base(world['ws_a'])}/room-links", {"room_id": ROOM_B})
    assert r.status_code == 200 and body(r)["data"] == []


def test_mapping_lookup_by_object_id_leaks_nothing(world):
    r = api_for(world["a_owner"]).get(f"{base(world['ws_a'])}/mappings", {"object_id": str(world["contact"].pk)})
    assert r.status_code == 200 and body(r)["data"] == []


@pytest.mark.parametrize("path", ["search", "contacts", "opportunities", "tasks?scope=team", "activities", "properties", "lending/applications",
                                  "meetings/notes", "action-items?status=all", "milestones?status=all"])
def test_search_leaks_nothing(world, path):
    api = api_for(world["a_owner"])
    sep = "&" if "?" in path else "?"
    for term in ("Uniquename", "Bartholomew", "bart@example.net"):
        r = api.get(f"{base(world['ws_a'])}/{path}{sep}q={term}")
        assert r.status_code == 200
        assert b"Uniquename" not in r.content and b"Bartholomew" not in r.content


def test_dashboard_and_members_show_only_own_workspace(world):
    api = api_for(world["a_owner"])
    r = api.get(f"{base(world['ws_a'])}/dashboard", {"scope": "team"})
    assert r.status_code == 200 and b"Uniquename" not in r.content and b"Bartholomew" not in r.content
    r = api.get(f"/api/v1/workspaces/{world['ws_a'].pk}/members")
    names = {row["username"] for row in body(r)["data"]}
    assert names == {"a-owner", "a-agent"}
    me = body(api.get("/api/v1/me"))["data"]
    assert {w["name"] for w in me["workspaces"]} == {"Org A"}


NESTED = [
    ("contacts", {"first_name": "N", "tag_ids": ["{tag}"]}, "tag_ids"),
    ("contacts", {"first_name": "N", "owner_id": "@b_owner"}, "owner_id"),
    ("contacts", {"first_name": "N", "assignee_ids": ["@b_agent"]}, "assignee_ids"),
    ("contacts", {"first_name": "N", "custom_fields": {"secret_b": "x"}}, "custom_fields.secret_b"),
    ("opportunities", {"name": "N", "pipeline_id": "{pipeline}"}, "pipeline_id"),
    ("opportunities", {"name": "N", "pipeline_id": "@a_pipeline", "stage_id": "{stage}"}, "stage_id"),
    ("opportunities", {"name": "N", "pipeline_id": "@a_pipeline", "contact_ids": ["{contact}"]}, "contact_ids"),
    ("opportunities", {"name": "N", "pipeline_id": "@a_pipeline", "collaborator_ids": ["@b_owner"]}, "collaborator_ids"),
    ("tasks", {"title": "N", "contact_id": "{contact}"}, "contact_id"),
    ("tasks", {"title": "N", "opportunity_id": "{opp}"}, "opportunity_id"),
    ("tasks", {"title": "N", "assignee_id": "@b_owner"}, "assignee_id"),
    ("tasks", {"title": "N", "related": {"type": "crm.contact", "id": "{contact}"}}, "related"),
    ("activities", {"kind": "note", "summary": "N", "contact_id": "{contact}"}, "contact_id"),
    ("activities", {"kind": "note", "summary": "N", "opportunity_id": "{opp}"}, "opportunity_id"),
    ("activities", {"kind": "note", "summary": "N", "task_id": "{task}"}, "task_id"),
    ("events", {"title": "N", "start_at": "2030-01-01T10:00:00Z", "end_at": "2030-01-01T11:00:00Z",
                "attendee_contact_ids": ["{contact}"]}, "attendee_contact_ids"),
    ("events", {"title": "N", "start_at": "2030-01-01T10:00:00Z", "end_at": "2030-01-01T11:00:00Z", "attendee_user_ids": ["@b_owner"]}, "attendee_user_ids"),
    ("events", {"title": "N", "start_at": "2030-01-01T10:00:00Z", "end_at": "2030-01-01T11:00:00Z", "opportunity_id": "{opp}"}, "opportunity_id"),
    ("room-links", {"room_id": "!r:lumen.test", "contact_id": "{contact}"}, "contact_id"),
    ("room-links", {"room_id": "!r:lumen.test", "opportunity_id": "{opp}"}, "opportunity_id"),
    ("events", {"title": "N", "start_at": "2030-01-01T10:00:00Z", "end_at": "2030-01-01T11:00:00Z",
                "related": {"type": "crm.property", "id": "{property}"}}, "related"),
    ("properties", {"address_line1": "N", "owner_id": "@b_owner"}, "owner_id"),
    ("milestones", {"title": "N", "opportunity_id": "{opp}"}, "opportunity_id"),
    ("milestones", {"title": "N", "application_id": "{application}"}, "application_id"),
    ("lending/applications", {"title": "N", "pipeline_id": "{lending_pipeline}"}, "pipeline_id"),
    ("lending/applications", {"title": "N", "opportunity_id": "{opp}"}, "opportunity_id"),
    ("lending/applications", {"title": "N", "property_id": "{property}"}, "property_id"),
    ("lending/applications", {"title": "N", "loan_officer_id": "@b_owner"}, "loan_officer_id"),
    ("meetings/notes", {"title": "N", "event_id": "{event}"}, "event_id"),
    ("meetings/notes", {"title": "N", "contact_id": "{contact}"}, "contact_id"),
    ("action-items", {"title": "N", "note_id": "{meeting_note}"}, "note_id"),
    ("action-items", {"title": "N", "event_id": "{event}"}, "event_id"),
    ("action-items", {"title": "N", "suggested_assignee_id": "@b_owner"}, "suggested_assignee_id"),
]


def _nested(world, value):
    if isinstance(value, list):
        return [_nested(world, v) for v in value]
    if isinstance(value, dict):
        return {k: _nested(world, v) for k, v in value.items()}
    if isinstance(value, str) and value.startswith("@"):
        key = value[1:]
        if key == "a_pipeline":
            return str(m.Pipeline.objects.filter(workspace=world["ws_a"]).first().pk)
        return str(world[key].public_id)
    if isinstance(value, str) and value.startswith("{"):
        return _fmt(world, value)
    return value


@pytest.mark.parametrize("path,data,field", NESTED)
def test_nested_other_workspace_ids_are_rejected(world, path, data, field):
    api = api_for(world["a_owner"])
    before = {model: model.objects.count() for model in (m.Contact, m.Opportunity, m.Task, m.Activity, m.CalendarEvent, m.ConversationLink,
                                                          m.Property, m.Milestone, m.LendingApplication, m.MeetingNote, m.ActionItem)}
    r = api.post(f"{base(world['ws_a'])}/{path}", _nested(world, data))
    assert r.status_code == 400, r.content
    err = body(r)["error"]
    assert err["code"] == "validation_error" and field in err["fields"], err
    # The same answer as for an ID that does not exist anywhere.
    fake = _nested(world, data)
    for k, v in list(fake.items()):
        if k == field.split(".")[0] and k != "custom_fields":
            if isinstance(v, list):
                fake[k] = [str(uuid.uuid4())]
            elif isinstance(v, dict):
                fake[k] = {**v, "id": str(uuid.uuid4())}
            else:
                fake[k] = str(uuid.uuid4())
    if field != "custom_fields.secret_b":
        assert _err(api.post(f"{base(world['ws_a'])}/{path}", fake)) == _err(r)
    after = {model: model.objects.count() for model in before}
    assert before == after


def test_nested_ids_in_updates_and_moves_are_rejected(world):
    owner = world["a_owner"]
    api = api_for(owner)
    p = m.Pipeline.objects.filter(workspace=world["ws_a"]).first()
    c = m.Contact.objects.create(workspace=world["ws_a"], first_name="Mine", owner=owner)
    o = m.Opportunity.objects.create(workspace=world["ws_a"], name="Mine", pipeline=p, stage=p.stages.first(), owner=owner)
    t = m.Task.objects.create(workspace=world["ws_a"], title="Mine", assignee=owner)
    for url, data in [
        (f"contacts/{c.pk}", {"tag_ids": [str(world["tag"].pk)]}),
        (f"contacts/{c.pk}", {"owner_id": str(world["b_owner"].public_id)}),
        (f"opportunities/{o.pk}", {"contact_ids": [str(world["contact"].pk)]}),
        (f"opportunities/{o.pk}", {"stage_id": str(world["stage"].pk)}),
        (f"tasks/{t.pk}", {"contact_id": str(world["contact"].pk)}),
    ]:
        r = api.patch(f"{base(world['ws_a'])}/{url}", data)
        assert r.status_code == 400, (url, r.content)
    r = api.post(f"{base(world['ws_a'])}/opportunities/{o.pk}/move", {"stage_id": str(world["stage"].pk)})
    assert r.status_code == 400
    o.refresh_from_db()
    assert o.stage.pipeline_id == p.pk
    assert not world["contact"].opportunities.filter(pk=o.pk).exists()


def test_malformed_ids_are_404_not_500(world):
    api = api_for(world["a_owner"])
    assert api.get(f"{base(world['ws_a'])}/contacts/not-a-uuid").status_code == 404
    assert api.get("/api/v1/workspaces/not-a-uuid/crm/contacts").status_code == 404
    r = api.get(f"{base(world['ws_a'])}/contacts", {"tag": "nope"})
    assert r.status_code == 400 and body(r)["error"]["fields"]["tag"]


# --- AI assistant and MCP connector ------------------------------------------------------------------

AI_LISTS = ["assistant/status", "assistant/settings", "assistant/interactions", "mcp/status", "mcp/connections"]


@pytest.mark.parametrize("path", AI_LISTS)
def test_ai_endpoints_of_other_workspace_are_404(world, path):
    api = api_for(world["a_owner"])
    assert api.get(f"/api/v1/workspaces/{world['ws_b'].pk}/{path}").status_code == 404
    r = api.get(f"/api/v1/workspaces/{world['ws_a'].pk}/{path}")
    assert r.status_code == 200 and b"Uniquename" not in r.content and str(world["grant"].pk).encode() not in r.content


@pytest.mark.parametrize("method,path", [
    ("get", "assistant/actions/{pending_action}"), ("post", "assistant/actions/{pending_action}/confirm"),
    ("post", "assistant/actions/{pending_action}/cancel"), ("delete", "mcp/connections/{grant}"),
])
def test_ai_objects_of_other_workspace_are_404(world, method, path):
    api = api_for(world["a_owner"])
    url = f"/api/v1/workspaces/{world['ws_a'].pk}/{_fmt(world, path)}"
    r = getattr(api, method)(url, {}) if method == "post" else getattr(api, method)(url)
    missing = f"/api/v1/workspaces/{world['ws_a'].pk}/{path.format(**{k: uuid.uuid4() for k in world})}"
    r2 = getattr(api, method)(missing, {}) if method == "post" else getattr(api, method)(missing)
    assert r.status_code == 404 and _err(r) == _err(r2)
    world["pending_action"].refresh_from_db()
    assert world["pending_action"].status == "pending"
    from apps.mcp.models import McpGrant

    assert McpGrant.objects.filter(pk=world["grant"].pk).exists()


def test_ai_chat_context_and_save_to_record_reject_other_workspace_ids(world):
    api = api_for(world["a_owner"])
    a = f"/api/v1/workspaces/{world['ws_a'].pk}/assistant"
    r = api.post(f"{a}/chat", {"messages": [{"role": "user", "content": "Summarise this contact"}],
                               "context": {"contact_id": str(world["contact"].pk)}})
    fake = api.post(f"{a}/chat", {"messages": [{"role": "user", "content": "Summarise this contact"}],
                                  "context": {"contact_id": str(uuid.uuid4())}})
    assert r.status_code == 400 and _err(r) == _err(fake)
    r = api.post(f"{a}/chat", {"messages": [{"role": "user", "content": "Summarise this contact"}], "context": {"room_id": ROOM_B}})
    assert r.status_code == 200 and b"Uniquename" not in r.content and b"Bartholomew" not in r.content
    m.OrgSettings.objects.filter(workspace=world["ws_a"]).update(save_to_record_enabled=True)
    msg = [{"event_id": "$e:lumen.test", "sender": "x", "sent_at": "2026-10-01T10:00:00Z", "text": "hi"}]
    r = api.post(f"{a}/save-to-record", {"room_id": ROOM_B, "contact_id": str(world["contact"].pk), "messages": msg})
    fake = api.post(f"{a}/save-to-record", {"room_id": ROOM_B, "contact_id": str(uuid.uuid4()), "messages": msg})
    assert r.status_code == 400 and _err(r) == _err(fake)
    assert not m.Activity.objects.filter(summary__startswith="Saved from chat").exists()


def test_ai_tools_never_see_other_workspace_rows(world):
    from django.test import RequestFactory

    from apps.assistant.registry import ToolContext, ToolError, all_tools, run_tool

    req = RequestFactory().post("/x")
    actor = access.actor_for(world["a_owner"], world["ws_a"].pk)
    ctx = ToolContext(actor=actor, request=req, channel="mcp")
    b_ids = {str(world[k].pk) for k in ("contact", "opp", "task", "activity", "event", "pipeline")}
    for tool in all_tools():
        if tool.kind != "read":
            continue
        args = {}
        for name, p in tool.args.params.items():
            if p.schema.get("format") == "uuid":
                args[name] = str(world["contact"].pk if "contact" in name else world["opp"].pk if "opportunity" in name else world["pipeline"].pk)
            elif p.required:
                args[name] = "Uniquename" if p.schema.get("type") == "string" else 30
        try:
            out = run_tool(tool, ctx, args)
        except ToolError as exc:
            # not_connected: tools on connected services when this person connected none.
            assert exc.code in ("not_found", "validation_error", "not_connected"), (tool.name, exc.code)
            continue
        text = json.dumps(out.data)
        assert not any(i in text for i in b_ids) and "Uniquename" not in text.replace('"Uniquename"', ""), tool.name
# --- verticals: nested IDs in other bodies, uploads, download tokens, automation ---------------------


def test_vertical_nested_ids_of_other_workspace_are_rejected(world):
    owner = world["a_owner"]
    api = api_for(owner)
    url = base(world["ws_a"])
    c = m.Contact.objects.create(workspace=world["ws_a"], first_name="Mine", owner=owner)
    o = m.Opportunity.objects.create(workspace=world["ws_a"], name="Mine", pipeline=m.Pipeline.objects.filter(workspace=world["ws_a"]).first(),
                                     stage=m.Stage.objects.filter(workspace=world["ws_a"]).first(), owner=owner)
    p = m.Property.objects.create(workspace=world["ws_a"], address_line1="Mine", owner=owner)
    r = api.post(f"{url}/lending/applications", {"title": "N", "borrowers": [{"contact_id": str(world["contact"].pk)}]})
    assert r.status_code == 400 and body(r)["error"]["fields"]["borrowers"] == ["Unknown or inaccessible ID."]
    app = body(api.post(f"{url}/lending/applications", {"title": "Mine", "borrowers": [{"contact_id": str(c.pk)}]}))["data"]
    for path, data, field in [
        (f"properties/{p.pk}/contacts", {"contact_id": str(world["contact"].pk)}, "contact_id"),
        (f"opportunities/{o.pk}/properties", {"property_id": str(world["property"].pk)}, "property_id"),
        (f"opportunities/{o.pk}/contact-roles", {"contact_id": str(world["contact"].pk), "role": "buyer"}, "contact_id"),
        (f"properties/{p.pk}/viewings", {"start_at": "2030-01-01T10:00:00Z", "contact_ids": [str(world["contact"].pk)]}, "contact_ids"),
        (f"lending/applications/{app['id']}/move", {"stage_id": str(world["lending_stage2"].pk)}, "stage_id"),
        (f"lending/applications/{app['id']}/checklist/apply-template", {"template_id": str(world["template"].pk)}, "template_id"),
    ]:
        r = api.post(f"{url}/{path}", data)
        assert r.status_code == 400 and field in body(r)["error"]["fields"], (path, r.content)
    r = api.patch(f"{url}/lending/applications/{app['id']}", {"opportunity_id": str(world["opp"].pk)})
    assert r.status_code == 400
    r = api.raw("post", f"{url}/lending/applications/{app['id']}/documents?checklist_item={world['checklist_item'].pk}", b"%PDF-1.4 x",
                "application/pdf", HTTP_X_NEXUS_FILENAME="x.pdf")
    assert r.status_code == 400 and body(r)["error"]["fields"]["checklist_item"] == ["Unknown or inaccessible ID."]
    assert not m.PropertyContact.objects.filter(property=p).exists() and not m.OpportunityProperty.objects.filter(opportunity=o).exists()


def test_other_workspace_document_upload_and_download_are_404(world):
    api = api_for(world["a_owner"])
    url = base(world["ws_a"])
    r = api.raw("post", f"{url}/lending/applications/{world['application'].pk}/documents", b"%PDF-1.4 x", "application/pdf",
                HTTP_X_NEXUS_FILENAME="x.pdf")
    assert r.status_code == 404
    assert m.SecureDocument.objects.filter(application=world["application"]).count() == 1


AUTOMATION_GETS = ["rules/{rule}"]
AUTOMATION_WRITES = [
    ("patch", "rules/{rule}", {"name": "Pwned"}), ("delete", "rules/{rule}", None), ("post", "executions/{execution}/retry", {}),
    ("patch", "notifications/{notification}", {"read": True}),
]


@pytest.mark.parametrize("method,path,data", AUTOMATION_WRITES + [("get", p, None) for p in AUTOMATION_GETS])
def test_other_workspace_automation_objects_are_404(world, method, path, data):
    api = api_for(world["a_owner"])
    url = f"/api/v1/workspaces/{world['ws_a'].pk}/automation/{_fmt(world, path)}"
    r = getattr(api, method)(url, data) if data is not None else getattr(api, method)(url)
    assert r.status_code == 404, r.content
    assert am.AutomationRule.objects.get(pk=world["rule"].pk).name == "Uniquename rule"
    assert am.AutomationExecution.objects.get(pk=world["execution"].pk).attempts == 0
    assert am.Notification.objects.get(pk=world["notification"].pk).read_at is None


@pytest.mark.parametrize("path", ["catalog", "rules", "executions", "executions/summary", "notifications", "notifications/unread-count",
                                  "preferences"])
def test_automation_lists_show_only_own_workspace(world, path):
    api = api_for(world["a_owner"])
    assert api.get(f"/api/v1/workspaces/{world['ws_b'].pk}/automation/{path}").status_code == 404
    r = api.get(f"/api/v1/workspaces/{world['ws_a'].pk}/automation/{path}")
    assert r.status_code == 200 and b"Uniquename" not in r.content
    assert str(world["rule"].pk).encode() not in r.content and str(world["execution"].pk).encode() not in r.content
    r = api.get(f"/api/v1/workspaces/{world['ws_a'].pk}/automation/executions", {"rule": str(world["rule"].pk)})
    assert r.status_code == 400
    r = api.patch(f"/api/v1/workspaces/{world['ws_a'].pk}/automation/preferences", {"muted": True})
    assert am.NotificationPreference.objects.get(pk=world["notification_pref"].pk).user == world["b_owner"]
    assert am.NotificationPreference.objects.filter(workspace=world["ws_a"], user=world["a_owner"], muted=True).exists()
