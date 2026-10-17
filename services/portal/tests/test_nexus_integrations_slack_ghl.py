"""Slack and GoHighLevel (mock-based: fake Slack Web API and fake HighLevel API v2)."""

import pytest
from django.test import override_settings

from apps.crm.models import Contact, ExternalRecordMapping, Task
from apps.integrations.models import ExternalRecord, InboxItem, IntegrationConnection, IntegrationCredential
from apps.integrations.sync import sync_connection
from apps.workspaces.models import Role

from .integrations_helpers import configured_fixture, connect, fake_fixture, ibase  # noqa: F401
from .nexus_helpers import api_for, body, business_workspace, make_user, member

pytestmark = pytest.mark.django_db


@pytest.fixture
def org(fake, configured):
    owner = make_user("sg-owner", email="sg.owner@example.com")
    ws = business_workspace(owner, "Slack GHL Org")
    return {"ws": ws, "owner": owner, "agent": member(ws, Role.AGENT, "sg-agent"), "readonly": member(ws, Role.READONLY, "sg-ro"),
            "api": api_for(owner), "fake": fake}


@pytest.fixture
def slack(org):
    conn = connect(org["fake"], org["owner"], org["ws"], "slack", account="T0MOCK0001")
    r = org["api"].patch(f"{ibase(org['ws'])}/connections/{conn.pk}", {"channels": ["C0MOCKSALES"]})
    assert r.status_code == 200, r.content
    conn.refresh_from_db()
    return conn


def test_slack_connect_stores_team_and_bot_scopes(org, slack):
    assert slack.account_id == "T0MOCK0001" and slack.scope == "workspace"
    assert set(slack.granted_scopes) == {"channels:read", "channels:history", "chat:write", "users:read"}
    assert slack.settings["channels"] == [{"id": "C0MOCKSALES", "name": "sales-mock", "is_private": False}]


def test_channel_selection_rules(org, slack):
    base = f"{ibase(org['ws'])}/connections/{slack.pk}"
    channels = body(org["api"].get(f"{base}/slack-channels"))["data"]
    assert {c["id"]: c["selected"] for c in channels}["C0MOCKSALES"] is True
    r = org["api"].patch(base, {"channels": ["C0MOCKRANDOM"]})
    assert r.status_code == 400 and "Invite the app" in str(body(r))
    assert org["api"].patch(base, {"channels": ["C0NOPE"]}).status_code == 400
    assert api_for(org["agent"]).patch(base, {"channels": ["C0MOCKSALES"]}).status_code == 403
    assert org["api"].patch(base, {"private_channels": True}).status_code == 400  # needs the optional scopes first


def test_sync_backfills_selected_channels_and_names(org, slack):
    assert sync_connection(slack)["ok"]
    items = InboxItem.objects.filter(connection=slack).order_by("occurred_at")
    assert items.count() == 2 and {i.data["channel"] for i in items} == {"C0MOCKSALES"}
    assert sync_connection(slack)["ok"]  # names resolved on the next pass, no duplicates
    assert InboxItem.objects.filter(connection=slack).count() == 2
    first = InboxItem.objects.filter(connection=slack).order_by("occurred_at").first()
    assert first.data["user_name"] == "Riley (mock)" and first.data["mentions"] == ["U0MOCKB02"]
    # Removing a channel deletes what was stored from it.
    org["api"].patch(f"{ibase(org['ws'])}/connections/{slack.pk}", {"channels": ["C0MOCKLEADS"]})
    assert not InboxItem.objects.filter(connection=slack, data__channel="C0MOCKSALES").exists()


def test_mentions_me_filter(org, slack):
    sync_connection(slack)
    base = ibase(org["ws"])
    assert body(org["api"].get(f"{base}/inbox", {"mentions": "me"}))["data"] == []
    org["api"].patch(f"{base}/connections/{slack.pk}", {"my_slack_user_id": "U0MOCKB02"})
    rows = body(org["api"].get(f"{base}/inbox", {"mentions": "me"}))["data"]
    assert len(rows) == 1 and rows[0]["meta"]["mentions"] == ["U0MOCKB02"]
    # Anyone may set their own ID (not an admin setting).
    assert api_for(org["agent"]).patch(f"{base}/connections/{slack.pk}", {"my_slack_user_id": "U0MOCKA01"}).status_code == 200
    assert org["api"].patch(f"{base}/connections/{slack.pk}", {"my_slack_user_id": "not-an-id!"}).status_code == 400


def test_post_requires_confirmation_and_selected_channel(org, slack):
    base = ibase(org["ws"])
    agent = api_for(org["agent"])
    r = agent.post(f"{base}/slack/post-request", {"connection_id": str(slack.pk), "channel_id": "C0MOCKLEADS", "text": "hi"})
    assert r.status_code == 400
    assert api_for(org["readonly"]).post(f"{base}/slack/post-request", {"connection_id": str(slack.pk), "channel_id": "C0MOCKSALES",
                                                                        "text": "hi"}).status_code == 403
    r = agent.post(f"{base}/slack/post-request", {"connection_id": str(slack.pk), "channel_id": "C0MOCKSALES", "text": "Synthetic post"})
    action = body(r)["data"]
    assert action["preview"]["channel"] == "#sales-mock" and org["fake"].slack.posted == []
    r = agent.post(f"{base}/actions/{action['id']}/confirm", {"confirmation_token": action["confirmation_token"]})
    assert r.status_code == 200 and body(r)["data"]["result"]["posted"]
    assert [p["text"] for p in org["fake"].slack.posted] == ["Synthetic post"]
    assert agent.post(f"{base}/actions/{action['id']}/confirm", {"confirmation_token": action["confirmation_token"]}).status_code == 403
    assert len(org["fake"].slack.posted) == 1
    assert InboxItem.objects.filter(connection=slack, snippet="Synthetic post").count() == 1


def test_cancel_action(org, slack):
    base = ibase(org["ws"])
    action = body(org["api"].post(f"{base}/slack/post-request", {"connection_id": str(slack.pk), "channel_id": "C0MOCKSALES", "text": "x"}))["data"]
    assert org["api"].delete(f"{base}/actions/{action['id']}").status_code == 204
    assert org["api"].post(f"{base}/actions/{action['id']}/confirm", {"confirmation_token": action["confirmation_token"]}).status_code == 403
    assert org["fake"].slack.posted == []


def test_permalink_and_link_to_task(org, slack):
    sync_connection(slack)
    item = InboxItem.objects.filter(connection=slack).first()
    base = ibase(org["ws"])
    link = body(org["api"].get(f"{base}/inbox/{item.pk}/permalink"))["data"]["permalink"]
    assert link.startswith("https://mock-slack.example.com/archives/C0MOCKSALES/p")
    task = Task.objects.create(workspace=org["ws"], title="Follow up", assignee=org["owner"])
    r = org["api"].post(f"{base}/inbox/{item.pk}/links", {"target": {"type": "crm.task", "id": str(task.pk)}})
    assert r.status_code == 201 and body(r)["data"]["target"]["label"] == "Follow up" and body(r)["data"]["on_timeline"] is False
    bad = org["api"].post(f"{base}/inbox/{item.pk}/links", {"target": {"type": "crm.nothing", "id": str(task.pk)}})
    assert bad.status_code == 400


def test_disconnect_revokes_deletes_tokens_and_data(org, slack):
    sync_connection(slack)
    r = org["api"].post(f"{ibase(org['ws'])}/connections/{slack.pk}/disconnect", {})
    assert r.status_code == 200 and body(r)["data"]["revoked_at_provider"] is True
    slack.refresh_from_db()
    assert slack.status == "disconnected" and not IntegrationCredential.objects.filter(connection=slack).exists()
    assert not InboxItem.objects.filter(connection=slack).exists()
    assert not ExternalRecordMapping.objects.filter(provider="slack").exists()


def test_disconnect_can_keep_data_hidden_from_inbox(org, slack):
    sync_connection(slack)
    org["api"].post(f"{ibase(org['ws'])}/connections/{slack.pk}/disconnect", {"delete_data": False})
    assert InboxItem.objects.filter(connection=slack).exists()
    assert body(org["api"].get(f"{ibase(org['ws'])}/inbox"))["data"] == []


# --- GoHighLevel --------------------------------------------------------------------------------------------


@pytest.fixture
def ghl(org):
    conn = connect(org["fake"], org["owner"], org["ws"], "gohighlevel", account="mockLocation001")
    assert sync_connection(conn)["ok"]
    return conn


def test_ghl_sync_mirrors_records_as_external(org, ghl):
    kinds = {k: ExternalRecord.objects.filter(connection=ghl, kind=k).count() for k in ["pipeline", "opportunity", "tag", "custom_field"]}
    assert kinds == {"pipeline": 1, "opportunity": 2, "tag": 1, "custom_field": 1}
    rows = body(org["api"].get(f"{ibase(org['ws'])}/ghl/opportunities"))["data"]
    assert {r["title"] for r in rows} == {"Sample opportunity A (mock)", "Sample opportunity B (mock)"}
    assert all(r["external"] and r["untrusted"] for r in rows)
    convs = InboxItem.objects.filter(connection=ghl, kind="ghl_conversation")
    assert convs.count() == 2
    missed = InboxItem.objects.get(connection=ghl, kind="missed_call")
    assert missed.title == "Missed call from Pat Mockperson"
    detail = body(org["api"].get(f"{ibase(org['ws'])}/inbox/{convs.first().pk}"))["data"]
    assert detail["capabilities"]["reply"] is False and "Open it in HighLevel" in detail["capabilities"]["reply_unsupported_reason"]
    assert detail["origin"] == "imported_record"
    conv = body(org["api"].get(f"{ibase(org['ws'])}/inbox/{missed.pk}/conversation"))["data"]
    assert conv["read_only"] and conv["messages"][0]["call_status"] == "no-answer" and conv["messages"][0]["untrusted"]


def test_ghl_search_suggests_but_never_merges(org, ghl):
    harper = Contact.objects.create(workspace=org["ws"], first_name="Harper", last_name="S", email="harper.sample@example.com", owner=org["owner"])
    rows = body(org["api"].get(f"{ibase(org['ws'])}/ghl/contacts", {"q": "harper"}))["data"]
    assert len(rows) == 1 and rows[0]["mapping"]["linked"] is False
    assert rows[0]["suggestions"][0]["id"] == str(harper.pk)
    assert not ExternalRecordMapping.objects.filter(provider="gohighlevel", object_type="crm.contact").exists()


def test_ghl_link_dedups_by_ghl_id(org, ghl):
    base = ibase(org["ws"])
    a = Contact.objects.create(workspace=org["ws"], first_name="A", owner=org["owner"])
    b = Contact.objects.create(workspace=org["ws"], first_name="B", owner=org["owner"])
    assert org["api"].post(f"{base}/ghl/contacts/mockContact01/link", {"contact_id": str(a.pk)}).status_code == 200
    r = org["api"].post(f"{base}/ghl/contacts/mockContact01/link", {"contact_id": str(b.pk)})
    assert r.status_code == 409 and body(r)["error"]["code"] == "already_linked"
    assert org["api"].post(f"{base}/ghl/contacts/mockContact02/link", {"contact_id": str(a.pk)}).status_code == 409
    assert org["api"].post(f"{base}/ghl/contacts/mockContact01/link", {"contact_id": str(a.pk)}).status_code == 200  # idempotent
    m = ExternalRecordMapping.objects.get(provider="gohighlevel", object_type="crm.contact")
    assert m.external_id == "mockLocation001:contact:mockContact01" and m.object_id == a.pk
    detail = body(org["api"].get(f"{base}/ghl/contacts/mockContact01"))["data"]
    assert detail["mapping"]["contact"]["id"] == str(a.pk) and detail["tasks"][0]["title"] == "Sample follow-up task (mock)"
    assert detail["appointments"][0]["status"] == "confirmed"
    assert org["api"].delete(f"{base}/ghl/contacts/mockContact01/link").status_code == 204
    assert not ExternalRecordMapping.objects.filter(provider="gohighlevel", object_type="crm.contact").exists()


def test_ghl_import_creates_contact_once(org, ghl):
    base = ibase(org["ws"])
    r = org["api"].post(f"{base}/ghl/contacts/mockContact03/import")
    assert r.status_code == 201
    c = Contact.objects.get(pk=body(r)["data"]["contact"]["id"])
    assert c.company == "Example Holdings LLC" and c.source == "GoHighLevel" and c.email == "rowan@example.net"
    assert org["api"].post(f"{base}/ghl/contacts/mockContact03/import").status_code == 409


def test_ghl_create_contact_needs_confirmation(org, ghl):
    base = ibase(org["ws"])
    c = Contact.objects.create(workspace=org["ws"], first_name="Nova", last_name="Example", email="harper.sample@example.com", owner=org["owner"])
    r = org["api"].post(f"{base}/ghl/actions", {"kind": "create_contact", "contact_id": str(c.pk)})
    action = body(r)["data"]
    assert action["preview"]["fields"]["firstName"] == "Nova"
    assert action["preview"]["possible_duplicates"][0]["id"] == "mockContact01"  # warned, not merged
    assert org["fake"].ghl.created == []
    r = org["api"].post(f"{base}/actions/{action['id']}/confirm", {"confirmation_token": action["confirmation_token"]})
    assert r.status_code == 200, r.content
    ext = body(r)["data"]["result"]["external_id"]
    assert ExternalRecordMapping.objects.get(provider="gohighlevel", external_id=f"mockLocation001:contact:{ext}").object_id == c.pk
    assert len(org["fake"].ghl.created) == 1


def test_ghl_update_contact_needs_confirmation(org, ghl):
    base = ibase(org["ws"])
    action = body(org["api"].post(f"{base}/ghl/actions", {"kind": "update_contact", "external_id": "mockContact02",
                                                          "fields": {"lastName": "Updated"}}))["data"]
    assert action["preview"]["changes"] == [{"field": "lastName", "from": "Mockperson", "to": "Updated"}]
    assert org["fake"].ghl.contacts["mockContact02"]["lastName"] == "Mockperson"
    org["api"].post(f"{base}/actions/{action['id']}/confirm", {"confirmation_token": action["confirmation_token"]})
    assert org["fake"].ghl.contacts["mockContact02"]["lastName"] == "Updated"
    assert api_for(org["readonly"]).post(f"{base}/ghl/actions", {"kind": "update_contact", "external_id": "mockContact02",
                                                                  "fields": {"lastName": "x"}}).status_code == 403


def test_workflow_triggers_never_run_outside_production(org, ghl):
    base = ibase(org["ws"])
    assert api_for(org["agent"]).patch(f"{base}/connections/{ghl.pk}", {"workflow_triggers_enabled": True}).status_code == 403
    assert org["api"].patch(f"{base}/connections/{ghl.pk}", {"workflow_triggers_enabled": True}).status_code == 200
    data = body(org["api"].get(f"{base}/connections/{ghl.pk}"))["data"]
    assert data["settings"]["workflow_triggers_enabled"] is True and data["settings"]["workflow_triggers_active"] is False
    r = org["api"].post(f"{base}/ghl/actions", {"kind": "add_to_workflow", "external_id": "mockContact01", "workflow_id": "mockWorkflow01"})
    assert r.status_code == 403
    assert org["fake"].ghl.workflow_triggers == []
    wf = body(org["api"].get(f"{base}/ghl/workflows"))["data"]
    assert wf["triggers_active"] is False and wf["workflows"][0]["name"] == "Sample nurture workflow (mock)"


def test_workflow_trigger_in_production_needs_admin_opt_in_and_confirmation(org, ghl):
    base = ibase(org["ws"])
    IntegrationConnection.objects.filter(pk=ghl.pk).update(is_mock=False)
    with override_settings(NEXUS_ENVIRONMENT="production"):
        r = org["api"].post(f"{base}/ghl/actions", {"kind": "add_to_workflow", "external_id": "mockContact01", "workflow_id": "mockWorkflow01"})
        assert r.status_code == 403  # not enabled yet
        org["api"].patch(f"{base}/connections/{ghl.pk}", {"workflow_triggers_enabled": True})
        action = body(org["api"].post(f"{base}/ghl/actions", {"kind": "add_to_workflow", "external_id": "mockContact01",
                                                              "workflow_id": "mockWorkflow01"}))["data"]
        assert org["fake"].ghl.workflow_triggers == []
        org["api"].post(f"{base}/actions/{action['id']}/confirm", {"confirmation_token": action["confirmation_token"]})
        assert org["fake"].ghl.workflow_triggers == [("mockContact01", "mockWorkflow01")]


def test_private_integration_token(org):
    base = ibase(org["ws"])
    assert api_for(org["agent"]).post(f"{base}/connections/private-token", {"provider": "gohighlevel", "token": "pit-mock-1",
                                                                            "location_id": "mockLocation001"}).status_code == 403
    r = org["api"].post(f"{base}/connections/private-token", {"provider": "gohighlevel", "token": "pit-mock-abc", "location_id": "otherLocation"})
    assert r.status_code == 400
    r = org["api"].post(f"{base}/connections/private-token", {"provider": "gohighlevel", "token": "pit-mock-abc", "location_id": "mockLocation001"})
    assert r.status_code == 201, r.content
    data = body(r)["data"]
    assert data["auth_method"] == "private_token" and data["account"]["label"] == "Harborview demo sub-account (mock)"
    assert "pit-mock-abc" not in r.content.decode()
    conn = IntegrationConnection.objects.get(pk=data["id"])
    assert sync_connection(conn)["ok"]
    # Rotating the token: the same location keeps its connection and synced data.
    from apps.integrations.tokens import read_tokens

    items = conn.inbox_items.count()
    r = org["api"].post(f"{base}/connections/private-token", {"provider": "gohighlevel", "token": "pit-mock-rotated", "location_id": "mockLocation001"})
    assert r.status_code in {200, 201} and body(r)["data"]["id"] == str(conn.pk)
    assert read_tokens(conn)[0] == "pit-mock-rotated" and conn.inbox_items.count() == items
    r = org["api"].post(f"{base}/connections/{conn.pk}/disconnect", {})
    assert body(r)["data"]["revoked_at_provider"] is False and "Private Integrations" in body(r)["data"]["manual_step"]


def test_ghl_refresh_rotates_refresh_token(org, ghl):
    from django.utils import timezone

    from apps.integrations.tokens import read_tokens

    _, before = read_tokens(ghl)
    IntegrationCredential.objects.filter(connection=ghl).update(access_expires_at=timezone.now())
    assert sync_connection(ghl)["ok"]
    _, after = read_tokens(ghl)
    assert before != after and org["fake"].ghl.refresh_count == 1
