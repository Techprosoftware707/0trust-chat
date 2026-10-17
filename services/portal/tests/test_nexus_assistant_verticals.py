"""AI tools on the verticals team's records: lending (no amounts without the sensitive
opt-in, never documents, no decisions), deadlines, properties, viewings and draft
confirmations (never sent), meeting notes and AI-suggested next steps (confirmed by a
person). Dev-provider chains for the brief's real-estate, lending and meeting questions."""

from __future__ import annotations

import datetime as dt
import json

import pytest
from django.test import RequestFactory
from django.utils import timezone

from apps.assistant.models import AISettings
from apps.assistant.registry import ToolContext, ToolError, available_tools, get_tool, run_tool
from apps.assistant.safety import allow_sensitive
from apps.crm import access, lending, meetings, realestate
from apps.crm import models as m
from apps.workspaces.models import Role

from .nexus_helpers import api_for, body, business_workspace, make_user, member

pytestmark = pytest.mark.django_db


def _req(user):
    r = RequestFactory().post("/x")
    r.user = user
    return r


@pytest.fixture
def org():
    owner = make_user("av-owner", display_name="Ava Owner")
    ws = business_workspace(owner, "Vert AI Org", profiles=["general", "real_estate", "lending"])
    manager = member(ws, Role.MANAGER, "av-manager")
    agent = member(ws, Role.AGENT, "av-agent")
    readonly = member(ws, Role.READONLY, "av-readonly")
    buyer = m.Contact.objects.create(workspace=ws, first_name="Bea", last_name="Buyer", email="bea@example.com", owner=agent, roles=["buyer"])
    re_p = m.Pipeline.objects.get(workspace=ws, kind="real_estate")
    deal = m.Opportunity.objects.create(workspace=ws, name="Bea purchase", pipeline=re_p, stage=re_p.stages.first(), owner=agent)
    m.OpportunityContact.objects.create(opportunity=deal, contact=buyer)
    mgr = access.actor_for(manager, ws.pk)
    app = lending.create_application(_req(manager), mgr, {
        "title": "Bea mortgage", "borrowers": [{"contact_id": str(buyer.pk)}], "amount_requested": "300000",
        "loan_officer_id": str(agent.public_id), "opportunity_id": str(deal.pk),
        "target_close_date": (timezone.localdate() + dt.timedelta(days=20)).isoformat()})
    realestate.create_milestone(_req(manager), mgr, {"opportunity_id": str(deal.pk), "title": "Inspection deadline", "milestone_type": "inspection",
                                                     "due_date": (timezone.localdate() + dt.timedelta(days=2)).isoformat()})
    prop = m.Property.objects.create(workspace=ws, address_line1="1 Harbor View", city="Old Harbor", status="active", list_price=350000,
                                     bedrooms=3, owner=agent)
    m.Property.objects.create(workspace=ws, address_line1="9 Imported Lane", city="Old Harbor", status="active", list_price=360000,
                              bedrooms=3, source="import", source_detail="CSV import 2026-10")
    realestate.save_preferences(_req(agent), access.actor_for(agent, ws.pk), buyer,
                                {"budget_min": "300000", "budget_max": "400000", "bedrooms_min": 3, "areas": ["Old Harbor"]})
    start = timezone.now() + dt.timedelta(days=1)
    viewing = realestate.schedule_viewing(_req(agent), access.actor_for(agent, ws.pk), {
        "property_id": str(prop.pk), "contact_ids": [str(buyer.pk)], "start_at": start.isoformat()})
    past = m.CalendarEvent.objects.create(workspace=ws, title="Kick-off with Bea", start_at=timezone.now() - dt.timedelta(days=2),
                                          end_at=timezone.now() - dt.timedelta(days=2, hours=-1), organizer=agent, contact=buyer)
    note = meetings.create_meeting_note(_req(agent), access.actor_for(agent, ws.pk), {"event_id": str(past.pk), "title": "Kick-off notes",
                                                                                     "body": "Bea wants a garden."})
    meetings.propose_action_item(_req(agent), access.actor_for(agent, ws.pk), {"note_id": str(note.pk), "title": "Send garden listings"})
    return {"ws": ws, "owner": owner, "manager": manager, "agent": agent, "readonly": readonly, "buyer": buyer, "deal": deal,
            "app": app, "prop": prop, "viewing": viewing, "past": past, "note": note}


def ctx_of(org, who, channel="assistant"):
    actor = access.actor_for(org[who], org["ws"].pk)
    return ToolContext(actor=actor, request=_req(org[who]), channel=channel, allow_sensitive=allow_sensitive(actor))


def test_lending_tools_without_amounts_or_documents(org):
    r = run_tool(get_tool("lending_applications_missing_documents"), ctx_of(org, "agent"), {})
    assert r.data["total"] == 1
    a = r.data["applications"][0]
    assert a["reference"] == "APP-0001" and a["missing_documents"] and a["deal"]["name"] == "Bea purchase"
    assert "amount_requested" not in a  # sensitive data is off by default
    text = json.dumps(r.data)
    assert "300000" not in text and "storage_name" not in text and "wrapped_key" not in text
    deals = run_tool(get_tool("deals_waiting_on_documents"), ctx_of(org, "agent"), {}).data
    assert deals["deals"][0]["name"] == "Bea purchase" and deals["deals"][0]["missing"] > 0
    one = run_tool(get_tool("get_lending_application"), ctx_of(org, "agent"), {"application_id": str(org["app"].pk)})
    assert one.data["outstanding_work"] and "not shared with AI" in one.facts[-1]
    assert "decision" not in json.dumps(one.data["application"])
    names = {t.name for t in available_tools(ctx_of(org, "owner").actor, "mcp", ["mcp:write"])}
    assert not {n for n in names if "decision" in n or "document_content" in n or "download" in n}


def test_lending_sensitive_needs_opt_in_and_capability(org):
    AISettings.objects.update_or_create(workspace=org["ws"], defaults={"sensitive_data_enabled": True})
    mgr = run_tool(get_tool("lending_applications_missing_documents"), ctx_of(org, "manager"), {}).data["applications"][0]
    assert mgr["amount_requested"] == "300000.00"
    agent = run_tool(get_tool("lending_applications_missing_documents"), ctx_of(org, "agent"), {}).data["applications"][0]
    assert "amount_requested" not in agent  # agents don't hold the lending-sensitive capability


def test_lending_needs_role(org):
    with pytest.raises(ToolError) as exc:
        run_tool(get_tool("lending_applications_missing_documents"), ctx_of(org, "readonly"), {})
    assert exc.value.code == "permission_denied"


def test_deadlines_properties_and_viewings(org):
    d = run_tool(get_tool("approaching_deadlines"), ctx_of(org, "agent"), {"days": 7}).data["deadlines"]
    assert d[0]["title"] == "Inspection deadline" and d[0]["urgency"] in ("due_soon", "upcoming") and d[0]["parent"]["name"] == "Bea purchase"
    props = run_tool(get_tool("search_properties"), ctx_of(org, "agent"), {"query": "Harbor View"})
    assert props.data["total"] == 1 and props.facts[1].startswith("1 Harbor View")
    imported = run_tool(get_tool("search_properties"), ctx_of(org, "agent"), {"city": "Old Harbor"})
    assert any("[imported: CSV import 2026-10]" in f for f in imported.facts)  # imports are labelled, never presented as own listings
    match = run_tool(get_tool("matching_properties"), ctx_of(org, "agent"), {"contact_id": str(org["buyer"].pk)}).data
    assert any(p["name"].startswith("1 Harbor View") for p in match["properties"])
    v = run_tool(get_tool("viewings"), ctx_of(org, "agent"), {"contact_id": str(org["buyer"].pk)}).data["viewings"]
    assert v[0]["property"]["name"].startswith("1 Harbor View") and v[0]["contacts"][0]["name"] == "Bea Buyer"


def test_viewing_confirmation_is_a_draft_only(org):
    before = m.Activity.objects.count()
    r = run_tool(get_tool("draft_viewing_confirmation"), ctx_of(org, "agent"), {"event_id": str(org["viewing"].pk)})
    assert r.data["status"] == "draft_only" and r.data["draft"]["to"] == ["bea@example.com"]
    assert "Hi Bea" in r.data["draft"]["body"] and "1 Harbor View" in r.data["draft"]["body"]
    assert "not been sent" in r.data["notes"][0]
    assert m.Activity.objects.count() == before
    with pytest.raises(ToolError):
        run_tool(get_tool("draft_viewing_confirmation"), ctx_of(org, "agent"), {"event_id": str(org["past"].pk)})


def test_last_meeting_and_ai_suggested_next_step(org):
    r = run_tool(get_tool("meeting_action_items"), ctx_of(org, "agent"), {"contact_id": str(org["buyer"].pk)}).data
    assert r["event"]["title"] == "Kick-off with Bea" and r["notes"][0]["title"] == "Kick-off notes"
    assert r["action_items"][0]["title"] == "Send garden listings" and r["action_items"][0]["source"] == "manual"
    tasks_before = m.Task.objects.count()
    s = run_tool(get_tool("suggest_next_step"), ctx_of(org, "agent"), {"title": "Book a second viewing", "event_id": str(org["past"].pk)})
    item = m.ActionItem.objects.get(pk=s.data["action_item"]["id"])
    assert item.source == "ai_suggestion" and item.status == "proposed" and m.Task.objects.count() == tasks_before
    _, task = meetings.confirm_action_item(_req(org["agent"]), access.actor_for(org["agent"], org["ws"].pk), item, {})
    assert task.source == "ai_suggestion_confirmed"


def test_team_week_report_is_for_managers(org):
    assert run_tool(get_tool("team_week_report"), ctx_of(org, "manager"), {}).data["new_count"] >= 1
    with pytest.raises(ToolError):
        run_tool(get_tool("team_week_report"), ctx_of(org, "agent"), {})


def chat(org, who, text, context=None):
    return body(api_for(org[who]).post(f"/api/v1/workspaces/{org['ws'].pk}/assistant/chat",
                                       {"messages": [{"role": "user", "content": text}], "context": context or {}}))["data"]


def test_dev_chains_for_vertical_questions(org):
    assert [c["name"] for c in chat(org, "agent", "Which deals are waiting on documents?")["tool_calls"]] == ["deals_waiting_on_documents"]
    assert [c["name"] for c in chat(org, "agent", "Applications missing documents")["tool_calls"]] == ["lending_applications_missing_documents"]
    assert [c["name"] for c in chat(org, "agent", "Approaching deadlines")["tool_calls"]] == ["approaching_deadlines"]
    d = chat(org, "agent", "Draft a viewing confirmation", {"contact_id": str(org["buyer"].pk)})
    assert [c["name"] for c in d["tool_calls"]] == ["viewings", "draft_viewing_confirmation"] and "hasn't been sent" in d["answer"]
    d = chat(org, "agent", "Summarise the last meeting's action items", {"contact_id": str(org["buyer"].pk)})
    assert [c["name"] for c in d["tool_calls"]] == ["meeting_action_items"]
    d = chat(org, "agent", "Prepare me for my next meeting")
    assert [c["name"] for c in d["tool_calls"]] == ["upcoming_appointments", "get_contact_summary", "meeting_action_items"]
    d = chat(org, "agent", "Properties matching this client", {"contact_id": str(org["buyer"].pk)})
    assert [c["name"] for c in d["tool_calls"]] == ["matching_properties"]


def test_vertical_tools_need_their_profile():
    owner = make_user("plain-owner")
    ws = business_workspace(owner, "Plain Org", profiles=["general"])
    names = {t.name for t in available_tools(access.actor_for(owner, ws.pk), "assistant")}
    assert "search_properties" not in names and "lending_applications_missing_documents" not in names
    assert "approaching_deadlines" in names and "meeting_action_items" in names
