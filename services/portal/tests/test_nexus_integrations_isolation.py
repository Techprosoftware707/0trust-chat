"""Tenant isolation of every integrations model and endpoint (mock-based data): IDs, filters,
search and body IDs of another workspace answer exactly like IDs that don't exist."""

import uuid

import pytest

from apps.crm import access
from apps.crm.models import Contact, Opportunity, Pipeline
from apps.integrations import models as im
from apps.integrations.sync import sync_connection
from apps.workspaces.models import Role

from .integrations_helpers import configured_fixture, connect, fake_fixture, ibase  # noqa: F401
from .nexus_helpers import api_for, body, business_workspace, make_user, member

pytestmark = pytest.mark.django_db


@pytest.fixture
def world(fake, configured):
    a_owner = make_user("ia-owner", email="ia.owner@example.com")
    ws_a = business_workspace(a_owner, "Iso A")
    a_agent = member(ws_a, Role.AGENT, "ia-agent")
    b_owner = make_user("ib-owner2", email="ib.owner2@example.com")
    ws_b = business_workspace(b_owner, "Iso B")
    gmail = connect(fake, b_owner, ws_b, "gmail", account="ib.owner2@example.com")
    slack = connect(fake, b_owner, ws_b, "slack", account="T0MOCK0001")
    slack.settings = {**slack.settings, "channels": [{"id": "C0MOCKSALES", "name": "sales-mock", "is_private": False}]}
    slack.save()
    ghl = connect(fake, b_owner, ws_b, "gohighlevel", account="mockLocation001")
    for c in (gmail, slack, ghl):
        assert sync_connection(c)["ok"]
    contact = Contact.objects.create(workspace=ws_b, first_name="Bea", email="harper.sample@example.com", owner=b_owner)
    opp = Opportunity.objects.create(workspace=ws_b, name="B deal", pipeline=Pipeline.objects.filter(workspace=ws_b).first(),
                                     stage=Pipeline.objects.filter(workspace=ws_b).first().stages.first(), owner=b_owner)
    b_api = api_for(b_owner)
    gm_item = im.InboxItem.objects.filter(connection=gmail).first()
    slack_item = im.InboxItem.objects.filter(connection=slack).first()
    msg = im.EmailMessage.objects.filter(item=gm_item).first()
    r = b_api.post(f"{ibase(ws_b)}/inbox/{gm_item.pk}/drafts", {"body": "B draft"})
    draft = im.EmailDraft.objects.get(pk=body(r)["data"]["id"])
    action = body(b_api.post(f"{ibase(ws_b)}/drafts/{draft.pk}/send-request"))["data"]
    b_api.post(f"{ibase(ws_b)}/inbox/{slack_item.pk}/links", {"target": {"type": "crm.contact", "id": str(contact.pk)}})
    b_api.post(f"{ibase(ws_b)}/inbox/mutes", {"group_key": slack_item.group_key})
    b_api.post(f"{ibase(ws_b)}/ghl/contacts/mockContact01/link", {"contact_id": str(contact.pk)})
    return {
        "ws_a": ws_a, "a_owner": a_owner, "a_agent": a_agent, "ws_b": ws_b, "b_owner": b_owner, "gmail": gmail, "slack": slack, "ghl": ghl,
        "gm_item": gm_item, "slack_item": slack_item, "msg": msg, "draft": draft, "action": action, "contact": contact, "opp": opp,
        "link": im.InboxLink.objects.get(item=slack_item), "mute": im.InboxMute.objects.get(workspace=ws_b),
        "record": im.ExternalRecord.objects.filter(connection=ghl, kind="opportunity").first(),
        "ghl_item": im.InboxItem.objects.filter(connection=ghl, kind="ghl_conversation").first(),
    }


def test_access_layer_never_returns_other_workspace_rows(world):
    models = [im.IntegrationConnection, im.InboxItem, im.EmailMessage, im.EmailDraft, im.InboxLink, im.InboxMute, im.PendingAction,
              im.ExternalRecord]
    for model in models:
        assert model.objects.filter(workspace=world["ws_b"]).exists(), model
    for role in Role.values:
        ms = world["ws_a"].memberships.first()
        ms.role = role
        actor = access.Actor(user=world["a_owner"], membership=ms)
        for model in list(access._POLICIES):
            for action in access.ACTIONS:
                assert not access.for_actor(actor, model, action).filter(workspace=world["ws_b"]).exists(), (role, model, action)


def _fmt(world, template):
    return template.format(**{k: getattr(v, "pk", v) if not isinstance(v, dict) else v.get("id") for k, v in world.items()})


GETS = [
    "connections/{gmail}", "connections/{slack}/slack-channels", "inbox/{gm_item}", "inbox/{slack_item}", "inbox/{slack_item}/suggestions",
    "inbox/{slack_item}/permalink", "inbox/{gm_item}/messages/{msg}/body", "inbox/{gm_item}/messages/{msg}/attachments/x", "drafts/{draft}",
    "actions/{action}", "inbox/{ghl_item}/conversation",
]
WRITES = [
    ("patch", "connections/{slack}", {"channels": []}),
    ("post", "connections/{gmail}/sync", {}),
    ("post", "connections/{gmail}/disconnect", {}),
    ("patch", "inbox/{slack_item}", {"priority": "high"}),
    ("post", "inbox/{slack_item}/links", {"target": {"type": "crm.contact", "id": "{contact}"}}),
    ("delete", "inbox/{slack_item}/links/{link}", None),
    ("post", "inbox/{gm_item}/drafts", {"body": "x"}),
    ("patch", "drafts/{draft}", {"body": "pwned"}),
    ("delete", "drafts/{draft}", None),
    ("post", "drafts/{draft}/send-request", {}),
    ("post", "actions/{action}/confirm", {"confirmation_token": "x"}),
    ("delete", "actions/{action}", None),
    ("delete", "inbox/mutes/{mute}", None),
]


@pytest.mark.parametrize("path", GETS)
def test_other_workspace_objects_are_404(world, path):
    api = api_for(world["a_owner"])
    r = api.get(f"{ibase(world['ws_a'])}/{_fmt(world, path)}")
    missing = api.get(f"{ibase(world['ws_a'])}/{path.format(**{k: uuid.uuid4() for k in world})}")
    assert r.status_code == 404, (path, r.content)
    assert missing.status_code == 404
    a, b = body(r)["error"], body(missing)["error"]
    a.pop("request_id", None)
    b.pop("request_id", None)
    assert a == b


@pytest.mark.parametrize("method,path,data", WRITES)
def test_other_workspace_objects_cannot_be_changed(world, method, path, data):
    api = api_for(world["a_owner"])
    url = f"{ibase(world['ws_a'])}/{_fmt(world, path)}"
    payload = {k: (_fmt(world, v) if isinstance(v, str) else v) for k, v in data.items()} if data is not None else None
    if isinstance((payload or {}).get("target"), dict):
        payload["target"] = {k: _fmt(world, v) for k, v in payload["target"].items()}
    r = getattr(api, method)(url, payload) if payload is not None else getattr(api, method)(url)
    assert r.status_code == 404, (method, path, r.content)
    for name in ("gmail", "slack", "ghl"):
        world[name].refresh_from_db()
        assert world[name].status == "connected"
    world["draft"].refresh_from_db()
    assert world["draft"].status == "draft" and world["draft"].body == "B draft"
    assert im.InboxLink.objects.filter(pk=world["link"].pk).exists() and im.InboxMute.objects.filter(pk=world["mute"].pk).exists()
    assert im.PendingAction.objects.get(pk=world["action"]["id"]).status == "pending"


LISTS = ["providers", "connections", "inbox", "inbox?status=all&muted=include", "inbox/counts", "inbox/mutes", "ghl/opportunities",
         "ghl/pipelines", "ghl/tags", "ghl/custom-fields"]


@pytest.mark.parametrize("path", LISTS)
def test_lists_show_nothing_of_other_workspace(world, path):
    r = api_for(world["a_owner"]).get(f"{ibase(world['ws_a'])}/{path}")
    text = r.content.decode()
    for marker in ["ib.owner2@example.com", "sales-mock", "Sample opportunity", str(world["gm_item"].pk), str(world["slack"].pk), "mock-buyer"]:
        assert marker not in text, (path, marker)


def test_other_workspace_url_is_404(world):
    api = api_for(world["a_owner"])
    for path in ["providers", "connections", "inbox", f"inbox/{world['slack_item'].pk}", "gmail/search?q=x", "ghl/contacts?q=x"]:
        assert api.get(f"{ibase(world['ws_b'])}/{path}").status_code == 404, path


def test_filters_and_body_ids_of_other_workspace(world):
    api = api_for(world["a_owner"])
    base = ibase(world["ws_a"])
    assert body(api.get(f"{base}/inbox", {"connection": str(world["slack"].pk), "status": "all", "muted": "include"}))["data"] == []
    r = api.get(f"{base}/inbox", {"linked": f"crm.contact:{world['contact'].pk}"})
    missing = api.get(f"{base}/inbox", {"linked": f"crm.contact:{uuid.uuid4()}"})
    assert r.status_code == missing.status_code == 400
    assert api.post(f"{base}/connections/oauth-start", {"provider": "gmail", "reconnect_id": str(world["gmail"].pk)}).status_code in (400, 409)
    r = api.post(f"{base}/slack/post-request", {"connection_id": str(world["slack"].pk), "channel_id": "C0MOCKSALES", "text": "x"})
    assert r.status_code == 400 and "connection_id" in body(r)["error"]["fields"]
    assert api.post(f"{base}/inbox/mark", {"item_ids": [str(world["slack_item"].pk)]}).status_code == 400
    assert api.post(f"{base}/inbox/mutes", {"group_key": world["slack_item"].group_key}).status_code == 400
    # GoHighLevel endpoints need this workspace's own connection.
    assert api.get(f"{base}/ghl/contacts", {"q": "harper", "connection": str(world["ghl"].pk)}).status_code == 409
    assert api.post(f"{base}/ghl/actions", {"kind": "create_contact", "contact_id": str(world["contact"].pk)}).status_code == 409


def test_items_linked_to_records_of_own_workspace_only(world):
    """Links whose target the actor can't see are not shown."""
    b_agent = member(world["ws_b"], Role.AGENT, "ib-agent2")
    world["contact"].visibility = "private"
    world["contact"].save()
    data = body(api_for(b_agent).get(f"{ibase(world['ws_b'])}/inbox/{world['slack_item'].pk}"))["data"]
    assert data["links"] == []
