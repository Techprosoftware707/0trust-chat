"""Gmail (mock-based: the fake Gmail API answers): sync and incremental history, dedup through
ExternalRecordMapping, search, untrusted bodies (sanitized, no remote images), proxied
attachments, reply drafts and the two-step send confirmation."""

from datetime import timedelta

import pytest
from django.utils import timezone

from apps.crm.models import Activity, Contact, ExternalRecordMapping
from apps.integrations import sanitize
from apps.integrations.models import EmailDraft, EmailMessage, InboxItem, PendingAction
from apps.integrations.sync import apply_retention, sync_connection
from apps.workspaces.models import Role

from .integrations_helpers import configured_fixture, connect, fake_fixture, ibase  # noqa: F401
from .nexus_helpers import api_for, body, business_workspace, make_user, member

pytestmark = pytest.mark.django_db


@pytest.fixture
def org(fake, configured):
    owner = make_user("gm-owner", email="gm.owner@example.com")
    ws = business_workspace(owner, "Gmail Org")
    agent = member(ws, Role.AGENT, "gm-agent")
    conn = connect(fake, owner, ws, "gmail", account="gm.owner@example.com")
    assert sync_connection(conn)["ok"]
    return {"ws": ws, "owner": owner, "agent": agent, "conn": conn, "api": api_for(owner), "fake": fake}


def _items(org, **params):
    r = org["api"].get(f"{ibase(org['ws'])}/inbox", params)
    assert r.status_code == 200, r.content
    return body(r)["data"]


def test_initial_sync_stores_metadata_only(org):
    items = InboxItem.objects.filter(connection=org["conn"])
    assert items.count() == 6
    t1 = items.get(external_id="mockthread01")
    assert t1.kind == "email_thread" and t1.visibility == "personal" and t1.owner == org["owner"]
    assert t1.title.endswith("(mock data)") and t1.message_count == 2 and t1.provider_unread
    assert t1.external_url.startswith("https://mail.google.com/mail/?authuser=")
    msgs = EmailMessage.objects.filter(item=t1).order_by("sent_at")
    assert [m.from_address for m in msgs] == ["harper.sample@example.com", "gm.owner@example.com"]
    assert msgs[0].rfc_message_id.startswith("<mockthread01m1@")
    # No bodies stored anywhere.
    assert "not a real message" not in str(list(EmailMessage.objects.values())) + str(list(InboxItem.objects.values()))
    assert org["conn"].sync_state["history_id"]
    assert ExternalRecordMapping.objects.filter(workspace=org["ws"], provider="gmail", external_id="gm.owner@example.com:thread:mockthread01",
                                                object_type="integrations.inboxitem", object_id=t1.pk).exists()


def test_resync_is_idempotent(org):
    org["conn"].refresh_from_db()
    org["conn"].sync_state = {}
    org["conn"].save()
    assert sync_connection(org["conn"])["ok"]
    assert InboxItem.objects.filter(connection=org["conn"]).count() == 6
    assert ExternalRecordMapping.objects.filter(workspace=org["ws"], provider="gmail").count() == 6


def test_incremental_sync_uses_history_and_404_resets(org):
    box = org["fake"].google.mailbox("gm.owner@example.com")
    from apps.integrations.mock.providers import _now

    msg = org["fake"].google._message("newm1", "mockthread03", "Rowan Example", "rowan@example.net", "gm.owner@example.com",
                                      "Sample thread: portfolio update request (mock data)", _now(), unread=True, body="New mock reply")
    box["threads"]["mockthread03"]["messages"].append(msg)
    box["history_id"] += 5
    box.setdefault("history", []).append({"id": box["history_id"], "mid": "newm1", "tid": "mockthread03"})
    org["conn"].refresh_from_db()
    org["conn"].sync_state = {**org["conn"].sync_state, "history_id": str(box["history_id"] - 1)}
    org["conn"].save()
    calls_before = len(org["fake"].google.calls)
    assert sync_connection(org["conn"])["ok"]
    paths = [p for _, p in org["fake"].google.calls[calls_before:]]
    assert any(p.endswith("/history") for p in paths) and not any(p.endswith("/threads") for p in paths)
    assert InboxItem.objects.get(external_id="mockthread03").message_count == 2
    # A history ID that's too old (HTTP 404) falls back to a full sync.
    org["conn"].refresh_from_db()
    org["conn"].sync_state = {**org["conn"].sync_state, "history_id": "-5"}
    org["conn"].save()
    assert sync_connection(org["conn"])["ok"]
    assert any(p.endswith("/threads") for _, p in org["fake"].google.calls)


def test_trash_and_spam_threads_are_removed(org):
    box = org["fake"].google.mailbox("gm.owner@example.com")
    for m in box["threads"]["mockthread02"]["messages"]:
        m["labelIds"] = ["TRASH"]
    from apps.integrations.providers.gmail import GmailAdapter

    GmailAdapter().refresh_thread(org["conn"], "mockthread02")
    assert not InboxItem.objects.filter(external_id="mockthread02").exists()


def test_personal_mail_is_only_visible_to_its_owner(org):
    assert len(_items(org, source="gmail")) == 6
    agent_items = body(api_for(org["agent"]).get(f"{ibase(org['ws'])}/inbox"))["data"]
    assert agent_items == []
    item = InboxItem.objects.get(external_id="mockthread01")
    assert api_for(org["agent"]).get(f"{ibase(org['ws'])}/inbox/{item.pk}").status_code == 404


def test_search_uses_gmail_q_live(org):
    r = org["api"].get(f"{ibase(org['ws'])}/gmail/search", {"q": "escrow"})
    data = body(r)["data"]
    assert [d["title"] for d in data] == ["Sample thread: escrow paperwork (mock data)"]
    assert data[0]["source"] == "gmail" and data[0]["untrusted"] and data[0]["external"]
    assert org["api"].get(f"{ibase(org['ws'])}/gmail/search", {"q": ""}).status_code == 400
    r = api_for(org["agent"]).get(f"{ibase(org['ws'])}/gmail/search", {"q": "escrow"})
    assert r.status_code == 409 and body(r)["error"]["code"] == "not_connected"


def test_body_is_fetched_on_demand_and_sanitized(org):
    item = InboxItem.objects.get(external_id="mockthread03")
    msg = EmailMessage.objects.get(item=item)
    r = org["api"].get(f"{ibase(org['ws'])}/inbox/{item.pk}/messages/{msg.pk}/body")
    data = body(r)["data"]
    assert data["untrusted"] and data["remote_images"] == "blocked"
    assert "synthetic mock email number 3" in data["text"] and "not a real message" in data["text"]
    assert "<script" not in data["html"] and "javascript:" not in data["html"] and "tracker.example.com" not in data["html"]
    assert data["images_blocked"] == 1 and 'rel="noopener noreferrer nofollow"' in data["html"]
    # Still nothing stored.
    assert "not a real message" not in str(list(EmailMessage.objects.values())) + str(list(InboxItem.objects.values()))


def test_attachment_is_proxied_and_authorized(org):
    item = InboxItem.objects.get(external_id="mockthread02")
    msg = EmailMessage.objects.get(item=item)
    url = f"{ibase(org['ws'])}/inbox/{item.pk}/messages/{msg.pk}"
    meta = body(org["api"].get(f"{url}/body"))["data"]["attachments"]
    assert meta[0]["filename"] == "sample-checklist-mock.pdf"
    r = org["api"].get(f"{url}/attachments/{meta[0]['id']}")
    assert r.status_code == 200 and r.content.startswith(b"%PDF") and r["Content-Type"] == "application/octet-stream"
    assert 'attachment; filename="sample-checklist-mock.pdf"' == r["Content-Disposition"] and r["X-Content-Type-Options"] == "nosniff"
    assert api_for(org["agent"]).get(f"{url}/attachments/{meta[0]['id']}").status_code == 404
    assert org["api"].get(f"{url}/attachments/not-listed").status_code == 404


def test_sanitizer_unit():
    html, blocked = sanitize.sanitize_html(
        '<div onclick="x()">Hi <b>there</b><img src="http://e.example/p.gif"><a href=" JaVa\tscript:alert(1)">x</a>'
        '<a href="https://example.com/a?b=1&c=2">ok</a><style>body{}</style><iframe src="https://e"></iframe><svg><script>1</script></svg>'
        "<table><tr><td colspan=2 style='x'>c</td></tr></table></div>")
    assert blocked == 1
    assert "onclick" not in html and "<style" not in html and "<iframe" not in html and "<svg" not in html and "script" not in html
    assert '<a href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer nofollow">ok</a>' in html
    assert "<a>x</a>" in html and '<td colspan="2">c</td>' in html
    assert sanitize.html_to_text("<p>Line 1</p><p>Line&nbsp;2 <a href='https://x.example'>link</a></p><script>bad()</script>") == \
        "Line 1\n\nLine 2 link (https://x.example)"


def _draft(org, text="Thanks, synthetic reply."):
    item = InboxItem.objects.get(external_id="mockthread01")
    r = org["api"].post(f"{ibase(org['ws'])}/inbox/{item.pk}/drafts", {"body": text})
    assert r.status_code == 201, r.content
    return item, body(r)["data"]


def test_reply_draft_threads_correctly(org):
    item, d = _draft(org)
    assert d["to"] == ["harper.sample@example.com"] and d["subject"].startswith("Re: Sample thread: showing times")
    draft = EmailDraft.objects.get(pk=d["id"])
    raw = org["fake"].google.mailbox("gm.owner@example.com")["drafts"][draft.external_draft_id]
    assert raw["threadId"] == "mockthread01"
    import base64

    mime = base64.urlsafe_b64decode(raw["raw"] + "==").decode()
    assert "In-Reply-To: <mockthread01m2@mock.example.com>" in mime and "References:" in mime
    assert "Subject: Re: Sample thread: showing times (mock data)" in mime
    # Nothing was sent by creating a draft.
    assert org["fake"].google.mailbox("gm.owner@example.com")["sent"] == []


def test_send_needs_valid_single_use_confirmation_from_same_user(org):
    item, d = _draft(org)
    base = ibase(org["ws"])
    # No token, wrong token, other person: no send.
    r = org["api"].post(f"{base}/drafts/{d['id']}/send-request")
    assert r.status_code == 201
    action = body(r)["data"]
    assert action["preview"]["body"] == "Thanks, synthetic reply." and action["preview"]["to"] == ["harper.sample@example.com"]
    token = action["confirmation_token"]
    assert org["api"].post(f"{base}/actions/{action['id']}/confirm", {"confirmation_token": "wrong"}).status_code == 403
    assert api_for(org["agent"]).post(f"{base}/actions/{action['id']}/confirm", {"confirmation_token": token}).status_code == 404
    assert org["fake"].google.mailbox("gm.owner@example.com")["sent"] == []
    r = org["api"].post(f"{base}/actions/{action['id']}/confirm", {"confirmation_token": token})
    assert r.status_code == 200, r.content
    data = body(r)["data"]
    assert data["status"] == "executed" and data["result"]["sent"] is True
    sent = org["fake"].google.mailbox("gm.owner@example.com")["sent"]
    assert len(sent) == 1
    draft = EmailDraft.objects.get(pk=d["id"])
    assert draft.status == "sent" and draft.sent_message_id == sent[0]["id"] and draft.body == ""
    # Replaying the token sends nothing more.
    assert org["api"].post(f"{base}/actions/{action['id']}/confirm", {"confirmation_token": token}).status_code == 403
    assert len(org["fake"].google.mailbox("gm.owner@example.com")["sent"]) == 1
    assert PendingAction.objects.get(pk=action["id"]).payload == {}


def test_expired_confirmation_and_changed_draft(org):
    item, d = _draft(org)
    base = ibase(org["ws"])
    action = body(org["api"].post(f"{base}/drafts/{d['id']}/send-request"))["data"]
    PendingAction.objects.filter(pk=action["id"]).update(expires_at=timezone.now() - timedelta(seconds=1))
    assert org["api"].post(f"{base}/actions/{action['id']}/confirm", {"confirmation_token": action["confirmation_token"]}).status_code == 403
    action = body(org["api"].post(f"{base}/drafts/{d['id']}/send-request"))["data"]
    assert org["api"].patch(f"{base}/drafts/{d['id']}", {"body": "Changed after review"}).status_code == 200
    r = org["api"].post(f"{base}/actions/{action['id']}/confirm", {"confirmation_token": action["confirmation_token"]})
    assert r.status_code == 409 and body(r)["error"]["code"] == "draft_changed"
    assert org["fake"].google.mailbox("gm.owner@example.com")["sent"] == []


def test_failed_send_is_not_recorded_as_sent(org):
    item, d = _draft(org)
    base = ibase(org["ws"])
    action = body(org["api"].post(f"{base}/drafts/{d['id']}/send-request"))["data"]
    from apps.integrations.mock.providers import _json

    org["fake"].google.interceptors.append(lambda req: _json(500, {"error": {"code": 500}}) if req.url.endswith("/drafts/send") else None)
    r = org["api"].post(f"{base}/actions/{action['id']}/confirm", {"confirmation_token": action["confirmation_token"]})
    assert r.status_code == 502 and "Sent folder" in body(r)["error"]["message"]
    draft = EmailDraft.objects.get(pk=d["id"])
    assert draft.status == "draft" and not draft.sent_at
    assert PendingAction.objects.get(pk=action["id"]).status == "failed"
    assert len([c for c in org["fake"].google.calls if c[1].endswith("/drafts/send")]) == 1  # never retried


def test_readonly_grant_cannot_draft(fake, configured):
    owner = make_user("gm2-owner", email="gm2.owner@example.com")
    ws = business_workspace(owner, "Gmail RO Org")
    conn = connect(fake, owner, ws, "gmail", account="gm2.owner@example.com", scope="https://www.googleapis.com/auth/gmail.readonly")
    sync_connection(conn)
    item = InboxItem.objects.filter(connection=conn).first()
    r = api_for(owner).post(f"{ibase(ws)}/inbox/{item.pk}/drafts", {"body": "x"})
    assert r.status_code == 403
    detail = body(api_for(owner).get(f"{ibase(ws)}/inbox/{item.pk}"))["data"]
    assert detail["capabilities"]["reply"] is False and "Reconnect" in detail["capabilities"]["reply_unsupported_reason"]


def test_discard_draft(org):
    item, d = _draft(org)
    assert org["api"].delete(f"{ibase(org['ws'])}/drafts/{d['id']}").status_code == 204
    draft = EmailDraft.objects.get(pk=d["id"])
    assert draft.status == "discarded" and draft.body == ""
    assert org["fake"].google.mailbox("gm.owner@example.com")["drafts"] == {}


def test_contact_suggestions_and_linking(org):
    harper = Contact.objects.create(workspace=org["ws"], first_name="Harper", last_name="Sample", email="Harper.Sample@example.com", owner=org["owner"])
    item = InboxItem.objects.get(external_id="mockthread01")
    base = ibase(org["ws"])
    sugg = body(org["api"].get(f"{base}/inbox/{item.pk}/suggestions"))["data"]
    assert [s["id"] for s in sugg] == [str(harper.pk)] and "Same email" in sugg[0]["reason"]
    # Suggestions never link by themselves.
    assert not Activity.objects.filter(contact=harper).exists()
    r = org["api"].post(f"{base}/inbox/{item.pk}/links", {"target": {"type": "crm.contact", "id": str(harper.pk)}})
    assert r.status_code == 201
    act = Activity.objects.get(contact=harper)
    assert act.untrusted and act.source == "gmail" and act.kind == "email" and act.actor is None
    assert body(org["api"].get(f"{base}/inbox/{item.pk}/suggestions"))["data"] == []
    assert org["api"].post(f"{base}/inbox/{item.pk}/links", {"target": {"type": "crm.contact", "id": str(harper.pk)}}).status_code == 409
    linked = _items(org, linked=f"crm.contact:{harper.pk}")
    assert [i["id"] for i in linked] == [str(item.pk)]
    link_id = body(org["api"].get(f"{base}/inbox/{item.pk}"))["data"]["links"][0]["id"]
    assert org["api"].delete(f"{base}/inbox/{item.pk}/links/{link_id}").status_code == 204
    assert not Activity.objects.filter(contact=harper).exists()


def test_retention_prunes_old_items(org):
    InboxItem.objects.filter(external_id="mockthread06").update(occurred_at=timezone.now() - timedelta(days=200))
    apply_retention()
    assert not InboxItem.objects.filter(external_id="mockthread06").exists()
    assert not ExternalRecordMapping.objects.filter(external_id__endswith=":thread:mockthread06").exists()
