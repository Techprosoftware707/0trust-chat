"""Unified inbox state (mock-based data from the fake providers): per-person unread, priority,
assignment, labels, done, mutes and grouping keys, counts, role rules."""

import pytest

from apps.integrations.models import InboxItem, InboxMute
from apps.integrations.sync import sync_connection
from apps.workspaces.models import Role

from .integrations_helpers import configured_fixture, connect, fake_fixture, ibase  # noqa: F401
from .nexus_helpers import api_for, body, business_workspace, make_user, member

pytestmark = pytest.mark.django_db


@pytest.fixture
def org(fake, configured):
    owner = make_user("ib-owner", email="ib.owner@example.com")
    ws = business_workspace(owner, "Inbox Org")
    agent = member(ws, Role.AGENT, "ib-agent")
    ro = member(ws, Role.READONLY, "ib-ro")
    slack = connect(fake, owner, ws, "slack", account="T0MOCK0001")
    slack.settings = {**slack.settings, "channels": [{"id": "C0MOCKSALES", "name": "sales-mock", "is_private": False},
                                                     {"id": "C0MOCKLEADS", "name": "new-leads-mock", "is_private": False}]}
    slack.save()
    sync_connection(slack)
    gmail = connect(fake, owner, ws, "gmail", account="ib.owner@example.com")
    sync_connection(gmail)
    return {"ws": ws, "owner": owner, "agent": agent, "ro": ro, "slack": slack, "gmail": gmail, "base": ibase(ws)}


def rows(api, base, **params):
    r = api.get(f"{base}/inbox", params)
    assert r.status_code == 200, r.content
    return body(r)["data"]


def test_sources_and_badges(org):
    owner = rows(api_for(org["owner"]), org["base"])
    assert {r["source"] for r in owner} == {"gmail", "slack"}
    assert all(r["external"] and r["untrusted"] and r["origin"] != "native" for r in owner)
    assert {r["origin"] for r in owner} == {"synced_email", "external_message"}
    agent = rows(api_for(org["agent"]), org["base"])
    assert {r["source"] for r in agent} == {"slack"}  # the owner's mailbox stays private
    assert rows(api_for(org["owner"]), org["base"], source="slack") == [r for r in owner if r["source"] == "slack"]
    assert api_for(org["owner"]).get(f"{org['base']}/inbox", {"source": "bogus"}).status_code == 400


def test_unread_is_per_person(org):
    owner, agent = api_for(org["owner"]), api_for(org["agent"])
    slack_items = rows(agent, org["base"], source="slack")
    assert all(r["unread"] for r in slack_items)
    ids = [r["id"] for r in slack_items]
    assert agent.post(f"{org['base']}/inbox/mark", {"item_ids": ids}).status_code == 200
    assert rows(agent, org["base"], source="slack", unread="true") == []
    assert len(rows(owner, org["base"], source="slack", unread="true")) == len(ids)
    agent.post(f"{org['base']}/inbox/mark", {"item_ids": ids[:1], "read": False})
    assert len(rows(agent, org["base"], unread="true")) == 1
    counts = body(owner.get(f"{org['base']}/inbox/counts"))["data"]
    assert counts["unread_by_source"]["gmail"] == 6 and counts["unread"] == 6 + len(ids)
    gm = InboxItem.objects.filter(connection=org["gmail"]).first()
    assert agent.post(f"{org['base']}/inbox/mark", {"item_ids": [str(gm.pk)]}).status_code == 400


def test_assignment_priority_labels_done(org):
    owner = api_for(org["owner"])
    item = rows(owner, org["base"], source="slack")[0]
    url = f"{org['base']}/inbox/{item['id']}"
    r = owner.patch(url, {"assignee_id": str(org["agent"].public_id), "priority": "high", "labels": ["follow up", "VIP"]})
    assert r.status_code == 200, r.content
    data = body(r)["data"]
    assert data["assignee"]["id"] == str(org["agent"].public_id) and data["priority"] == "high" and data["labels"] == ["follow up", "VIP"]
    assert [r["id"] for r in rows(api_for(org["agent"]), org["base"], assignee="me")] == [item["id"]]
    assert [r["id"] for r in rows(owner, org["base"], label="VIP")] == [item["id"]]
    assert owner.patch(url, {"labels": ["<script>"]}).status_code == 400
    assert owner.patch(url, {"assignee_id": str(make_user("stranger").public_id)}).status_code == 400
    owner.patch(url, {"status": "done"})
    assert item["id"] not in [r["id"] for r in rows(owner, org["base"])]
    assert item["id"] in [r["id"] for r in rows(owner, org["base"], status="done")]


def test_personal_mail_cannot_be_assigned_to_others(org):
    owner = api_for(org["owner"])
    gm = rows(owner, org["base"], source="gmail")[0]
    r = owner.patch(f"{org['base']}/inbox/{gm['id']}", {"assignee_id": str(org["agent"].public_id)})
    assert r.status_code == 400
    assert owner.patch(f"{org['base']}/inbox/{gm['id']}", {"assignee_id": str(org["owner"].public_id)}).status_code == 200


def test_readonly_reads_but_cannot_change(org):
    ro = api_for(org["ro"])
    items = rows(ro, org["base"])
    assert items and all(r["capabilities"]["change"] is False for r in items)
    assert ro.patch(f"{org['base']}/inbox/{items[0]['id']}", {"priority": "high"}).status_code == 403
    assert ro.post(f"{org['base']}/inbox/mark", {"item_ids": [items[0]["id"]]}).status_code == 200


def test_mutes_hide_groups(org):
    owner = api_for(org["owner"])
    sales = [r for r in rows(owner, org["base"], source="slack") if r["meta"]["channel_id"] == "C0MOCKSALES"]
    key = sales[0]["group"]["key"]
    r = owner.post(f"{org['base']}/inbox/mutes", {"group_key": key, "label": "#sales-mock"})
    assert r.status_code == 201
    visible = rows(owner, org["base"], source="slack")
    assert all(x["group"]["key"] != key for x in visible)
    muted = rows(owner, org["base"], muted="only")
    assert {x["group"]["key"] for x in muted} == {key} and all(x["muted"] for x in muted)
    # Muting is personal.
    assert any(x["group"]["key"] == key for x in rows(api_for(org["agent"]), org["base"]))
    assert owner.post(f"{org['base']}/inbox/mutes", {"group_key": "matrix:!room123:chatdev.test"}).status_code == 201
    assert owner.post(f"{org['base']}/inbox/mutes", {"group_key": "matrix:not a room"}).status_code == 400
    assert owner.post(f"{org['base']}/inbox/mutes", {"group_key": "slack:someone-elses-group"}).status_code == 400
    mutes = body(owner.get(f"{org['base']}/inbox/mutes"))["data"]
    assert len(mutes) == 2
    mute_id = next(m["id"] for m in mutes if m["group_key"] == key)
    assert api_for(org["agent"]).delete(f"{org['base']}/inbox/mutes/{mute_id}").status_code == 404
    assert owner.delete(f"{org['base']}/inbox/mutes/{mute_id}").status_code == 204
    assert not InboxMute.objects.filter(group_key=key).exists()


def test_search_and_linked_filter_validation(org):
    owner = api_for(org["owner"])
    hits = rows(owner, org["base"], q="escrow")
    assert [h["title"] for h in hits] == ["Sample thread: escrow paperwork (mock data)"]
    assert owner.get(f"{org['base']}/inbox", {"linked": "garbage"}).status_code == 400


def test_service_health_for_the_dashboard(org):
    from apps.crm import access
    from apps.integrations.health import service_health
    from apps.integrations.models import IntegrationConnection

    owner = access.actor_for(org["owner"], org["ws"].pk)
    rows = {r["service"]: r for r in service_health(owner)}
    assert rows["gmail"]["status"] == "connected" and rows["slack"]["status"] == "connected"
    assert rows["gohighlevel"]["status"] == "not_connected" and rows["gmail"]["link"] == "#/integrations"
    IntegrationConnection.objects.filter(pk=org["slack"].pk).update(status="needs_reauth", last_error_message="Reconnect Slack.")
    agent = access.actor_for(org["agent"], org["ws"].pk)
    rows = {r["service"]: r for r in service_health(agent)}
    assert rows["slack"]["status"] == "needs_reauth" and rows["slack"]["detail"] == "Reconnect Slack."
    assert rows["gmail"]["status"] == "not_connected"  # the owner's mailbox is not the agent's
    from django.test import override_settings

    with override_settings(NEXUS_GOOGLE_CLIENT_ID="", NEXUS_GOOGLE_CLIENT_SECRET=""):
        assert {r["service"]: r for r in service_health(agent)}["gmail"]["status"] == "not_configured"
