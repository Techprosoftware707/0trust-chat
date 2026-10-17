"""The role matrix of business records (apps.crm.access) and role management in the portal."""

from datetime import timedelta

import pytest
from django.test import Client
from django.utils import timezone

from apps.core.models import AuditEvent
from apps.crm import access
from apps.crm import models as m
from apps.workspaces import services as ws_services
from apps.workspaces.models import Invitation, Membership, Role

from .factories import ensure_plans
from .nexus_helpers import api_for, base, body, business_workspace, make_user, member

pytestmark = pytest.mark.django_db
ROLES = [Role.OWNER, Role.ADMIN, Role.MANAGER, Role.AGENT, Role.MEMBER, Role.READONLY]
MANAGERS = {Role.OWNER, Role.ADMIN, Role.MANAGER}


@pytest.fixture
def org():
    owner = make_user("org-owner")
    ws = business_workspace(owner, "Matrix Org")
    people = {Role.OWNER: owner}
    for role in ROLES[1:]:
        people[role] = member(ws, role, f"r-{role}")
    other_agent = member(ws, Role.AGENT, "other-agent")
    p = m.Pipeline.objects.filter(workspace=ws).first()
    m.FieldDefinition.objects.create(workspace=ws, entity="contact", key="ssn_last4", label="SSN last 4", field_type="text", sensitive=True)
    team = m.Contact.objects.create(workspace=ws, first_name="Team", owner=other_agent, visibility="team", custom_fields={"ssn_last4": "1234"})
    private = m.Contact.objects.create(workspace=ws, first_name="Private", owner=other_agent, visibility="private")
    assigned = m.Contact.objects.create(workspace=ws, first_name="Assigned", owner=other_agent, visibility="private")
    assigned.assignees.add(people[Role.AGENT])
    opp = m.Opportunity.objects.create(workspace=ws, name="Team deal", pipeline=p, stage=p.stages.first(), owner=other_agent)
    task_other = m.Task.objects.create(workspace=ws, title="Someone else's", assignee=other_agent, created_by=other_agent)
    return {"ws": ws, "people": people, "other_agent": other_agent, "pipeline": p, "team": team, "private": private,
            "assigned": assigned, "opp": opp, "task_other": task_other}


def api(org, role):
    return api_for(org["people"][role])


@pytest.mark.parametrize("role", ROLES)
def test_visibility_by_role(org, role):
    r = api(org, role).get(f"{base(org['ws'])}/contacts")
    assert r.status_code == 200
    names = {row["first_name"] for row in body(r)["data"]}
    assert "Team" in names
    sees_private = role in MANAGERS
    assert ("Private" in names) == sees_private
    assert ("Assigned" in names) == (sees_private or role == Role.AGENT)
    detail = api(org, role).get(f"{base(org['ws'])}/contacts/{org['private'].pk}")
    assert detail.status_code == (200 if sees_private else 404)  # invisible means "doesn't exist"


@pytest.mark.parametrize("role", ROLES)
def test_create_contact_by_role(org, role):
    r = api(org, role).post(f"{base(org['ws'])}/contacts", {"first_name": f"New by {role}"})
    assert r.status_code == (201 if role in MANAGERS | {Role.AGENT} else 403)
    if r.status_code == 403:
        assert body(r)["error"]["code"] == "permission_denied"


@pytest.mark.parametrize("role", ROLES)
def test_change_and_delete_others_records(org, role):
    a = api(org, role)
    r = a.patch(f"{base(org['ws'])}/contacts/{org['team'].pk}", {"priority": "high"})
    assert r.status_code == (200 if role in MANAGERS else 403)  # visible to all, changeable by managers+
    r = a.patch(f"{base(org['ws'])}/opportunities/{org['opp'].pk}", {"priority": "high"})
    assert r.status_code == (200 if role in MANAGERS else 403)
    r = a.delete(f"{base(org['ws'])}/contacts/{org['team'].pk}")
    assert r.status_code == (204 if role in MANAGERS else 403)


def test_agent_changes_own_and_assigned_records(org):
    a = api(org, Role.AGENT)
    assert a.patch(f"{base(org['ws'])}/contacts/{org['assigned'].pk}", {"priority": "high"}).status_code == 200
    created = body(a.post(f"{base(org['ws'])}/contacts", {"first_name": "Mine"}))["data"]
    assert created["owner"]["username"] == "r-agent" and created["permissions"] == {"change": True, "delete": True}
    assert a.delete(f"{base(org['ws'])}/contacts/{org['assigned'].pk}").status_code == 403  # assigned, not owner
    assert a.delete(f"{base(org['ws'])}/contacts/{created['id']}").status_code == 204


@pytest.mark.parametrize("role", ROLES)
def test_crm_configuration_by_role(org, role):
    a = api(org, role)
    stage = org["pipeline"].stages.first()
    can = role in MANAGERS
    assert a.post(f"{base(org['ws'])}/pipelines", {"name": f"P {role}"}).status_code == (201 if can else 403)
    assert a.patch(f"{base(org['ws'])}/stages/{stage.pk}", {"name": "Renamed"}).status_code == (200 if can else 403)
    assert a.post(f"{base(org['ws'])}/fields", {"entity": "contact", "key": f"k_{role}", "label": "K", "field_type": "text"}).status_code == (201 if can else 403)
    tag = a.post(f"{base(org['ws'])}/tags", {"name": f"T {role}"})
    assert tag.status_code == (201 if role in MANAGERS | {Role.AGENT} else 403)


@pytest.mark.parametrize("role", ROLES)
def test_org_settings_only_owner_and_admin(org, role):
    r = api(org, role).patch(f"/api/v1/workspaces/{org['ws'].pk}/settings", {"save_to_record_enabled": True})
    assert r.status_code == (200 if role in {Role.OWNER, Role.ADMIN} else 403)
    assert api(org, role).get(f"/api/v1/workspaces/{org['ws'].pk}/settings").status_code == 200


@pytest.mark.parametrize("role", ROLES)
def test_tasks_by_role(org, role):
    a = api(org, role)
    me = org["people"][role]
    r = a.post(f"{base(org['ws'])}/tasks", {"title": "Mine"})
    assert r.status_code == (403 if role == Role.READONLY else 201)
    if r.status_code == 201:
        task = body(r)["data"]
        assert task["assignee"]["username"] == me.username
        assert a.patch(f"{base(org['ws'])}/tasks/{task['id']}", {"status": "done"}).status_code == 200
    r = a.post(f"{base(org['ws'])}/tasks", {"title": "For someone else", "assignee_id": str(org["other_agent"].public_id)})
    assert r.status_code == (201 if role in MANAGERS | {Role.AGENT} else 403)
    r = a.patch(f"{base(org['ws'])}/tasks/{org['task_other'].pk}", {"status": "done"})
    assert r.status_code == (200 if role in MANAGERS else 403)


@pytest.mark.parametrize("role", ROLES)
def test_timeline_events_links_by_role(org, role):
    a = api(org, role)
    writes = role in MANAGERS | {Role.AGENT}
    r = a.post(f"{base(org['ws'])}/activities", {"kind": "note", "summary": "Hello", "contact_id": str(org["team"].pk)})
    assert r.status_code == (201 if writes else 403)
    r = a.post(f"{base(org['ws'])}/room-links", {"room_id": f"!room{role}:lumen.test", "contact_id": str(org["team"].pk)})
    assert r.status_code == (201 if writes else 403)
    start = (timezone.now() + timedelta(days=1)).isoformat()
    end = (timezone.now() + timedelta(days=1, hours=1)).isoformat()
    r = a.post(f"{base(org['ws'])}/events", {"title": "Sync", "start_at": start, "end_at": end})
    assert r.status_code == (403 if role == Role.READONLY else 201)
    r = a.post(f"{base(org['ws'])}/events", {"title": "For other", "start_at": start, "end_at": end, "organizer_id": str(org["other_agent"].public_id)})
    assert r.status_code == (201 if role in MANAGERS else 403)
    assert a.get(f"{base(org['ws'])}/mappings").status_code == (200 if role in MANAGERS else 403)


@pytest.mark.parametrize("role", ROLES)
def test_sensitive_custom_fields(org, role):
    r = api(org, role).get(f"{base(org['ws'])}/contacts/{org['team'].pk}")
    values = body(r)["data"]["custom_fields"]
    hidden = role in {Role.MEMBER, Role.READONLY}
    assert ("ssn_last4" in values) == (not hidden)
    ev = AuditEvent.objects.filter(action="crm.contact.read", target_id=str(org["team"].pk), actor=org["people"][role])
    assert ev.exists() and ev.first().metadata["reason"] == "contact_detail"


@pytest.mark.parametrize("role", ROLES)
def test_capability_summary_matches_matrix(org, role):
    data = body(api(org, role).get(f"/api/v1/workspaces/{org['ws'].pk}"))["data"]
    assert data["role"] == role
    caps = data["capabilities"]
    assert caps["org.settings"] == (role in {Role.OWNER, Role.ADMIN})
    assert caps["integrations.own"] == (role in {Role.OWNER, Role.ADMIN})
    assert caps["crm.configure"] == (role in MANAGERS)
    assert caps["records.create"] == (role in MANAGERS | {Role.AGENT})
    assert data["view_level"] == ("all" if role in MANAGERS else "scoped" if role == Role.AGENT else "team")
    assert data["features"]["crm"] is True


def test_writes_are_audited_without_contents(org):
    a = api(org, Role.MANAGER)
    r = a.post(f"{base(org['ws'])}/contacts", {"first_name": "Secretname", "email": "secret@example.com"})
    cid = body(r)["data"]["id"]
    a.patch(f"{base(org['ws'])}/contacts/{cid}", {"last_name": "Hidden"})
    a.delete(f"{base(org['ws'])}/contacts/{cid}")
    events = AuditEvent.objects.filter(target_id=cid).order_by("id")
    assert [e.action for e in events] == ["crm.contact.create", "crm.contact.update", "crm.contact.delete"]
    for e in events:
        assert e.actor == org["people"][Role.MANAGER] and e.metadata["workspace"] == str(org["ws"].pk)
        assert "Secretname" not in str(e.metadata) and "secret@example.com" not in str(e.metadata) and "Hidden" not in str(e.metadata)
    assert events[1].metadata["fields"] == ["last_name"]


def test_feature_disabled_without_business_profile():
    ensure_plans()
    owner = make_user("plain")
    ws = ws_services.create_workspace(owner, "Plain chat workspace")
    a = api_for(owner)
    r = a.get(f"/api/v1/workspaces/{ws.pk}/crm/contacts")
    assert r.status_code == 403 and body(r)["error"]["code"] == "feature_disabled"
    assert body(a.get(f"/api/v1/workspaces/{ws.pk}"))["data"]["features"]["crm"] is False
    # The owner turns the business workspace on; the free plan allows "general" only.
    r = a.patch(f"/api/v1/workspaces/{ws.pk}/settings", {"business_profiles": ["real_estate"]})
    assert r.status_code == 403 and body(r)["error"]["code"] == "plan_limit"
    r = a.patch(f"/api/v1/workspaces/{ws.pk}/settings", {"business_profiles": ["general"]})
    assert r.status_code == 200 and body(r)["data"]["features"]["crm"] is True
    assert m.Pipeline.objects.filter(workspace=ws, kind="general").count() == 1
    assert a.get(f"/api/v1/workspaces/{ws.pk}/crm/contacts").status_code == 200


def test_access_actor_requires_membership(org):
    outsider = make_user("outsider")
    from django.http import Http404

    with pytest.raises(Http404):
        access.actor_for(outsider, org["ws"].pk)


# --- role management in the portal ------------------------------------------------------------


def test_owner_invites_with_business_roles(org):
    c = Client(); c.force_login(org["people"][Role.OWNER])
    for role in [Role.MANAGER, Role.AGENT, Role.READONLY, Role.ADMIN]:
        c.post(f"/portal/workspaces/{org['ws'].pk}/invite/", {"email": f"{role}@example.org", "role": role})
        assert Invitation.objects.get(email=f"{role}@example.org").role == role
    r = c.get(f"/portal/workspaces/{org['ws'].pk}/")
    assert b"Agent / Broker" in r.content and b"Read-only" in r.content and b"Team member" in r.content


def test_admin_gives_roles_below_admin_only(org):
    admin = org["people"][Role.ADMIN]
    _, _ = ws_services.invite(admin, org["ws"].pk, "mgr@example.org", Role.MANAGER)
    with pytest.raises(Exception):
        ws_services.invite(admin, org["ws"].pk, "adm@example.org", Role.ADMIN)
    target = Membership.objects.get(workspace=org["ws"], user=org["people"][Role.MEMBER])
    assert ws_services.change_role(admin, org["ws"].pk, target.pk, Role.AGENT).role == Role.AGENT
    with pytest.raises(Exception):
        ws_services.change_role(admin, org["ws"].pk, target.pk, Role.ADMIN)
    other_admin = Membership.objects.get(workspace=org["ws"], user=admin)
    owner = org["people"][Role.OWNER]
    assert ws_services.change_role(owner, org["ws"].pk, other_admin.pk, Role.MANAGER).role == Role.MANAGER


@pytest.mark.parametrize("role", [Role.MANAGER, Role.AGENT, Role.MEMBER, Role.READONLY])
def test_non_admins_cannot_change_roles(org, role):
    target = Membership.objects.get(workspace=org["ws"], user=org["other_agent"])
    c = Client(); c.force_login(org["people"][role])
    c.post(f"/portal/workspaces/{org['ws'].pk}/members/{target.pk}/role/", {"role": Role.READONLY})
    target.refresh_from_db()
    assert target.role == Role.AGENT


def test_portal_role_change_form(org):
    target = Membership.objects.get(workspace=org["ws"], user=org["other_agent"])
    c = Client(); c.force_login(org["people"][Role.OWNER])
    r = c.post(f"/portal/workspaces/{org['ws'].pk}/members/{target.pk}/role/", {"role": Role.READONLY}, follow=True)
    target.refresh_from_db()
    assert target.role == Role.READONLY and b"is now read-only" in r.content
    assert AuditEvent.objects.filter(action="workspace.role_change", metadata__role="readonly").exists()


def test_invitation_acceptance_keeps_business_role(org):
    inv, token = ws_services.invite(org["people"][Role.OWNER], org["ws"].pk, "newagent@example.org", Role.AGENT)
    u = make_user("newagent", email="newagent@example.org")
    ms = ws_services.accept_invitation(u, token)
    assert ms.role == Role.AGENT
