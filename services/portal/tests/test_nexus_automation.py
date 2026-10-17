"""Automation: rules (managers only, internal actions only), the event emitter (after commit,
deduplicated), executions with retries/backoff and manual retry, loop protection (own chain,
depth limit, rate caps), visible failures, the scheduled scans, and in-app notifications with
per-user and per-workspace preferences."""

from datetime import timedelta

import pytest
from django.utils import timezone

from apps.automation import engine, jobs
from apps.automation import models as am
from apps.automation.services import seed_example_rules
from apps.core.models import AuditEvent
from apps.crm import models as m
from apps.workspaces.models import Membership, Role

from .nexus_helpers import api_for, base, body, business_workspace, make_user, member

pytestmark = pytest.mark.django_db


@pytest.fixture
def org():
    owner = make_user("a-owner1")
    ws = business_workspace(owner, "Auto Org", profiles=["general", "real_estate"])
    manager = member(ws, Role.MANAGER, "a-manager")
    agent = member(ws, Role.AGENT, "a-agent1")
    agent2 = member(ws, Role.AGENT, "a-agent2")
    teammate = member(ws, Role.MEMBER, "a-member")
    return {"ws": ws, "owner": owner, "manager": manager, "agent": agent, "agent2": agent2, "teammate": teammate}


def auto(org, user=None):
    return api_for(user or org["manager"]), f"/api/v1/workspaces/{org['ws'].pk}/automation"


def rule(org, **kw):
    defaults = {"name": "R", "trigger": "lead.created", "enabled": True,
                "actions": [{"type": "notify_user", "params": {"recipient": "rule_owner", "title": "New lead {contact.name}"}}]}
    defaults.update(kw)
    a, root = auto(org)
    r = a.post(f"{root}/rules", defaults)
    assert r.status_code == 201, r.content
    return am.AutomationRule.objects.get(pk=body(r)["data"]["id"])


def new_lead(org, user=None, **kw):
    r = api_for(user or org["agent"]).post(f"{base(org['ws'])}/contacts", {"first_name": "Lena", "last_name": "Lead", "kind": "lead", **kw})
    assert r.status_code == 201, r.content
    return m.Contact.objects.get(pk=body(r)["data"]["id"])


# --- rules ------------------------------------------------------------------------------------------


def test_rules_are_for_managers_and_internal_actions_only(org):
    for who in ("agent", "teammate"):
        a, root = auto(org, org[who])
        assert a.get(f"{root}/rules").status_code == 403
        assert a.post(f"{root}/rules", {"name": "x", "trigger": "lead.created", "actions": []}).status_code == 403
    a, root = auto(org)
    cat = body(a.get(f"{root}/catalog"))["data"]
    assert {t["value"] for t in cat["triggers"]} == {"contact.created", "lead.created", "task.overdue", "appointment.upcoming",
                                                      "opportunity.stage_changed", "action_item.proposed"}
    assert {x["value"] for x in cat["actions"]} == {"assign_owner", "create_task", "notify_user", "update_related_tasks"}
    assert "confirmation" in cat["external_actions"]
    bad = [
        ({"actions": [{"type": "send_email", "params": {}}]}, "actions.0.type"),
        ({"actions": [{"type": "update_related_tasks", "params": {}}], "trigger": "appointment.upcoming"}, "actions.0.type"),
        ({"conditions": [{"field": "contact.ssn", "op": "equals", "value": "x"}]}, "conditions.0.field"),
        ({"conditions": [{"field": "contact.kind", "op": "regex", "value": "x"}], "trigger": "contact.created"}, "conditions.0.op"),
        ({"actions": [{"type": "assign_owner", "params": {"user_id": str(make_user("stranger").public_id)}}]}, "actions.0.params.user_id"),
        ({"actions": []}, "actions"),
    ]
    for extra, field in bad:
        data = {"name": "Bad", "trigger": "lead.created", "actions": [{"type": "notify_user", "params": {"title": "x"}}], **extra}
        r = a.post(f"{root}/rules", data)
        assert r.status_code == 400 and field in body(r)["error"]["fields"], (extra, r.content)
    r = rule(org, name="Good")
    assert AuditEvent.objects.filter(action="automation.automationrule.create", target_id=str(r.pk)).exists()
    resp = a.patch(f"{root}/rules/{r.pk}", {"enabled": False})
    assert body(resp)["data"]["enabled"] is False and body(resp)["data"]["owner"]["username"] == "a-manager"
    assert a.delete(f"{root}/rules/{r.pk}").status_code == 204


def test_example_rules_new_lead_gets_owner_and_follow_up(org, django_capture_on_commit_callbacks):
    seed_example_rules(org["ws"], org["manager"], enabled=True)
    assert am.AutomationRule.objects.filter(workspace=org["ws"]).count() == 4
    assert len(seed_example_rules(org["ws"], org["manager"])) == 0  # idempotent
    with django_capture_on_commit_callbacks(execute=True):
        unowned = new_lead(org, owner_id=None)
        owned = new_lead(org, first_name="Owen")
    unowned.refresh_from_db()
    owned.refresh_from_db()
    assert unowned.owner == org["manager"] and owned.owner == org["agent"]
    t1 = m.Task.objects.get(contact=unowned)
    t2 = m.Task.objects.get(contact=owned)
    assert t1.source == t2.source == "automation" and t1.assignee == org["manager"] and t2.assignee == org["agent"]
    assert t1.title == "Follow up with new lead Lena Lead" and t1.priority == "high"
    # the agent is told about the task an automation gave them
    n = am.Notification.objects.get(recipient=org["agent"])
    assert n.event_type == "assignment" and n.link == "#/tasks"
    ex = am.AutomationExecution.objects.filter(rule__template_key="new-lead-follow-up")
    assert ex.count() == 2 and set(ex.values_list("status", flat=True)) == {"succeeded"}
    audit = AuditEvent.objects.filter(action="crm.contact.update", target_id=str(unowned.pk)).first()
    assert audit.metadata["via"] == "automation" and audit.actor == org["manager"]


def test_events_fire_after_commit_and_are_deduplicated(org, django_capture_on_commit_callbacks):
    rule(org)
    with django_capture_on_commit_callbacks(execute=False) as callbacks:
        c = new_lead(org)
    assert not am.AutomationEvent.objects.exists()  # nothing before the commit
    for cb in callbacks:
        cb()
    assert am.AutomationEvent.objects.count() == 1 and am.AutomationExecution.objects.count() == 1
    # The same fact again: no second event, no second execution.
    engine.record_and_dispatch(org["ws"].pk, "lead.created", subject_type="crm.contact", subject_id=c.pk, dedup_key=str(c.pk),
                               payload={"contact": engine.contact_facts(c)})
    assert am.AutomationEvent.objects.count() == 1 and am.AutomationExecution.objects.count() == 1
    assert am.Notification.objects.filter(recipient=org["manager"]).count() == 1


def test_rolled_back_writes_trigger_nothing(org, django_capture_on_commit_callbacks):
    rule(org)
    with django_capture_on_commit_callbacks(execute=True):
        r = api_for(org["agent"]).post(f"{base(org['ws'])}/contacts", {"kind": "lead", "tag_ids": ["00000000-0000-0000-0000-000000000000"],
                                                                         "first_name": "Ghost"})
    assert r.status_code == 400 and not am.AutomationEvent.objects.exists()


def test_conditions_and_disabled_rules(org, django_capture_on_commit_callbacks):
    rule(org, trigger="contact.created", conditions=[{"field": "contact.source", "op": "equals", "value": "Website form"}])
    rule(org, name="Off", enabled=False)
    with django_capture_on_commit_callbacks(execute=True):
        new_lead(org, source="Referral")
        new_lead(org, first_name="Webby", source="website form")
    statuses = sorted(am.AutomationExecution.objects.values_list("status", flat=True))
    assert statuses == ["skipped", "succeeded"]
    assert not am.AutomationExecution.objects.filter(rule__name="Off").exists()


# --- loop protection --------------------------------------------------------------------------------


@pytest.fixture
def emitting_action(monkeypatch, org):
    """A test action that announces another lead.created (as a future external action could)."""
    seq = iter(range(1, 100))

    def act(actor, rule_, event, execution, subject, params):
        engine.emit(rule_.workspace_id, "lead.created", subject=subject, dedup_key=f"loop-{next(seq)}",
                    payload=event.payload, actor=actor.user)
        return {"type": "test_emit"}

    monkeypatch.setitem(engine.ACTIONS, "test_emit", act)
    return act


def _raw_rule(org, name):
    return am.AutomationRule.objects.create(workspace=org["ws"], name=name, trigger="lead.created", enabled=True, created_by=org["manager"],
                                            updated_by=org["manager"], actions=[{"type": "test_emit", "params": {}}])


def test_a_rule_never_retriggers_itself_and_chains_stop(org, emitting_action, django_capture_on_commit_callbacks):
    r1, r2 = _raw_rule(org, "R1"), _raw_rule(org, "R2")
    with django_capture_on_commit_callbacks(execute=True):
        new_lead(org)
    ex = list(am.AutomationExecution.objects.select_related("event"))
    for x in ex:
        if x.status == "succeeded":
            assert str(x.rule_id) not in [str(i) for i in x.event.chain]  # a rule never ran for its own action's event
    blocked = [x for x in ex if x.status == "loop_blocked"]
    assert blocked and all("own action" in x.last_error or "triggered each other" in x.last_error for x in blocked)
    assert max(x.event.depth for x in ex) <= 2  # both rules are in every chain by then: it stops
    assert {r1.pk, r2.pk} == {x.rule_id for x in blocked}


def test_depth_limit(org, emitting_action, settings, django_capture_on_commit_callbacks):
    settings.NEXUS_AUTOMATION_MAX_DEPTH = 0
    _raw_rule(org, "R1")
    rule(org, name="Notify")  # a second rule that would happily run at any depth
    with django_capture_on_commit_callbacks(execute=True):
        new_lead(org)
    deep = am.AutomationExecution.objects.filter(event__depth=1)
    assert deep.exists() and set(deep.values_list("status", flat=True)) == {"loop_blocked"}


def test_rate_caps_per_rule_and_workspace(org, settings, django_capture_on_commit_callbacks):
    r = rule(org, max_runs_per_hour=2)
    with django_capture_on_commit_callbacks(execute=True):
        for i in range(3):
            new_lead(org, first_name=f"L{i}")
    assert sorted(am.AutomationExecution.objects.filter(rule=r).values_list("status", flat=True)) == ["rate_limited", "succeeded", "succeeded"]
    settings.NEXUS_AUTOMATION_MAX_RUNS_PER_HOUR = 2
    r2 = rule(org, name="Second")
    with django_capture_on_commit_callbacks(execute=True):
        new_lead(org, first_name="Late")
    assert am.AutomationExecution.objects.get(rule=r2).status == "rate_limited"


# --- failures, retries, visibility -------------------------------------------------------------------------


def test_failures_retry_with_backoff_then_fail_visibly_and_can_be_retried(org, monkeypatch, django_capture_on_commit_callbacks):
    r = rule(org)

    def boom(*a, **k):
        raise RuntimeError("secret record contents 123")

    monkeypatch.setitem(engine.ACTIONS, "notify_user", boom)
    with django_capture_on_commit_callbacks(execute=True):
        new_lead(org)
    x = am.AutomationExecution.objects.get(rule=r)
    assert x.status == "retrying" and x.attempts == 1 and "secret" not in x.last_error and "RuntimeError" in x.last_error
    assert timedelta(seconds=55) < x.next_attempt_at - timezone.now() <= timedelta(seconds=60)
    assert jobs.run_retries() == 0  # not due yet
    assert jobs.run_retries(now=timezone.now() + timedelta(seconds=61)) == 1
    x.refresh_from_db()
    assert x.attempts == 2 and x.status == "retrying" and x.next_attempt_at - timezone.now() > timedelta(seconds=250)
    jobs.run_retries(now=timezone.now() + timedelta(seconds=400))
    x.refresh_from_db()
    assert x.attempts == 3 and x.status == "failed" and x.next_attempt_at is None
    a, root = auto(org)
    problems = body(a.get(f"{root}/executions", {"status": "problems"}))["data"]
    assert [p["id"] for p in problems] == [str(x.pk)] and problems[0]["can_retry"] and problems[0]["last_error"]
    assert body(a.get(f"{root}/executions/summary"))["data"]["failed"] == 1
    # Fixed: a manual retry runs it now.
    monkeypatch.undo()
    resp = a.post(f"{root}/executions/{x.pk}/retry", {})
    assert body(resp)["data"]["status"] == "succeeded" and body(resp)["data"]["attempts"] == 4
    assert AuditEvent.objects.filter(action="automation.automationexecution.retry", target_id=str(x.pk)).exists()
    assert a.post(f"{root}/executions/{x.pk}/retry", {}).status_code == 400  # succeeded runs can't be retried
    agent, _ = auto(org, org["agent"])
    assert agent.post(f"{root}/executions/{x.pk}/retry", {}).status_code == 404


def test_rules_run_with_their_owners_permissions(org, django_capture_on_commit_callbacks):
    r = rule(org)
    Membership.objects.filter(workspace=org["ws"], user=org["manager"]).update(role=Role.AGENT)
    with django_capture_on_commit_callbacks(execute=True):
        new_lead(org)
    x = am.AutomationExecution.objects.get(rule=r)
    assert x.status == "failed" and "no longer manage automations" in x.last_error and x.attempts == 1


# --- triggers: stage change, overdue scan, appointment reminder, action items ------------------------------


def test_stage_change_updates_tasks(org, django_capture_on_commit_callbacks):
    seed_example_rules(org["ws"], org["manager"], enabled=True)
    p = m.Pipeline.objects.get(workspace=org["ws"], kind="general")
    stages = list(p.stages.order_by("position"))
    o = m.Opportunity.objects.create(workspace=org["ws"], name="Moving deal", pipeline=p, stage=stages[0], owner=org["agent"])
    old = m.Task.objects.create(workspace=org["ws"], title="Old automation task", opportunity=o, assignee=org["agent"], source="automation")
    manual = m.Task.objects.create(workspace=org["ws"], title="Manual", opportunity=o, assignee=org["agent"])
    with django_capture_on_commit_callbacks(execute=True):
        r = api_for(org["agent"]).post(f"{base(org['ws'])}/opportunities/{o.pk}/move", {"stage_id": str(stages[1].pk)})
    assert r.status_code == 200
    old.refresh_from_db()
    manual.refresh_from_db()
    assert old.status == "done" and manual.status == "open"
    new = m.Task.objects.get(opportunity=o, status="open", source="automation")
    assert new.title == f"Moving deal: next step for {stages[1].name}" and new.assignee == org["agent"]
    # moving to a lost stage doesn't match the rule's condition
    with django_capture_on_commit_callbacks(execute=True):
        api_for(org["agent"]).post(f"{base(org['ws'])}/opportunities/{o.pk}/move", {"stage_id": str(stages[-1].pk)})
    assert am.AutomationExecution.objects.filter(rule__template_key="stage-change-update-tasks", status="skipped").count() == 1


def test_overdue_scan_notifies_once_and_honours_grouping(org):
    seed_example_rules(org["ws"], org["manager"], enabled=True)
    now = timezone.now()
    t1 = m.Task.objects.create(workspace=org["ws"], title="Late one", assignee=org["agent"], due_at=now - timedelta(hours=1))
    m.Task.objects.create(workspace=org["ws"], title="Late two", assignee=org["agent"], due_at=now - timedelta(hours=2))
    m.Task.objects.create(workspace=org["ws"], title="Ancient", assignee=org["agent"], due_at=now - timedelta(days=3))
    m.Task.objects.create(workspace=org["ws"], title="Done", assignee=org["agent"], due_at=now - timedelta(hours=1), status="done")
    assert jobs.scan_overdue_tasks() == 2
    assert jobs.scan_overdue_tasks() == 2  # scanned again, but...
    assert am.AutomationEvent.objects.filter(event_type="task.overdue").count() == 2  # ...each fact once
    notes = am.Notification.objects.filter(recipient=org["agent"], event_type="task.overdue")
    assert notes.count() == 1 and notes.first().count == 2  # grouped
    # Moving the due time is a new fact.
    m.Task.objects.filter(pk=t1.pk).update(due_at=now - timedelta(minutes=5))
    jobs.scan_overdue_tasks()
    assert am.AutomationEvent.objects.filter(event_type="task.overdue").count() == 3


def test_appointment_reminders_reach_organizer_and_attendees(org):
    seed_example_rules(org["ws"], org["manager"], enabled=True)
    start = timezone.now() + timedelta(minutes=30)
    e = m.CalendarEvent.objects.create(workspace=org["ws"], title="Viewing soon", kind="viewing", start_at=start, end_at=start + timedelta(minutes=30),
                                       organizer=org["agent"])
    e.attendee_users.set([org["agent2"], org["teammate"]])
    later = m.CalendarEvent.objects.create(workspace=org["ws"], title="Tomorrow", start_at=start + timedelta(days=1),
                                           end_at=start + timedelta(days=1, hours=1), organizer=org["agent"])
    assert jobs.scan_upcoming_appointments() == 1
    got = set(am.Notification.objects.filter(event_type="appointment.upcoming").values_list("recipient__username", flat=True))
    assert got == {"a-agent1", "a-agent2", "a-member"}
    assert later.pk not in set(am.AutomationEvent.objects.values_list("subject_id", flat=True))
    n = am.Notification.objects.filter(recipient=org["agent2"]).first()
    assert n.title.endswith("Viewing soon") and n.link == f"#/calendar/event/{e.pk}"


def test_action_item_proposed_trigger(org, django_capture_on_commit_callbacks):
    rule(org, trigger="action_item.proposed", actions=[{"type": "notify_user", "params": {"recipient": "subject_owner",
                                                                                           "title": "Suggested for you: {item.title}"}}])
    with django_capture_on_commit_callbacks(execute=True):
        r = api_for(org["agent"]).post(f"{base(org['ws'])}/action-items", {"title": "Send listings", "suggested_assignee_id": str(org["agent2"].public_id),
                                                                             "contact_id": str(new_lead(org).pk)})
    assert r.status_code == 201
    n = am.Notification.objects.get(recipient=org["agent2"], event_type="action_item.proposed")
    assert n.title == "Suggested for you: Send listings" and n.link == "#/calls/next-steps"


def test_notifications_skip_people_who_cannot_see_the_record(org, django_capture_on_commit_callbacks):
    rule(org, trigger="contact.created", actions=[{"type": "notify_user", "params": {"recipient": str(org["teammate"].public_id),
                                                                                     "title": "New contact {contact.name}"}}])
    with django_capture_on_commit_callbacks(execute=True):
        new_lead(org, visibility="private", first_name="Hidden")
        new_lead(org, first_name="Shared")
    titles = list(am.Notification.objects.filter(recipient=org["teammate"]).values_list("title", flat=True))
    assert titles == ["New contact Shared Lead"]


# --- notifications and preferences -------------------------------------------------------------------------------


def test_notification_api_is_private_to_the_recipient(org, django_capture_on_commit_callbacks):
    rule(org)
    with django_capture_on_commit_callbacks(execute=True):
        new_lead(org)
    mgr, root = auto(org)
    rows = body(mgr.get(f"{root}/notifications"))["data"]
    assert len(rows) == 1 and rows[0]["title"] == "New lead Lena Lead" and not rows[0]["read"]
    assert body(mgr.get(f"{root}/notifications/unread-count"))["data"]["unread"] == 1
    nid = rows[0]["id"]
    owner, _ = auto(org, org["owner"])
    assert owner.patch(f"{root}/notifications/{nid}", {"read": True}).status_code == 404  # not even the workspace owner
    assert body(owner.get(f"{root}/notifications"))["data"] == []
    assert body(mgr.patch(f"{root}/notifications/{nid}", {"read": True}))["data"]["read"] is True
    assert body(mgr.get(f"{root}/notifications/unread-count"))["data"]["unread"] == 0


def test_preferences_mute_events_grouping_and_workspace_defaults(org, django_capture_on_commit_callbacks):
    rule(org)
    mgr, root = auto(org)
    r = mgr.patch(f"{root}/preferences", {"events": {"lead.created": False}})
    assert body(r)["data"]["mine"]["events"]["lead.created"] is False
    with django_capture_on_commit_callbacks(execute=True):
        new_lead(org)
    assert not am.Notification.objects.filter(recipient=org["manager"]).exists()
    mgr.patch(f"{root}/preferences", {"events": {"lead.created": True}, "muted_until": (timezone.now() + timedelta(hours=1)).isoformat()})
    with django_capture_on_commit_callbacks(execute=True):
        new_lead(org, first_name="B")
    assert not am.Notification.objects.filter(recipient=org["manager"]).exists()
    mgr.patch(f"{root}/preferences", {"muted_until": None, "grouping": False})
    with django_capture_on_commit_callbacks(execute=True):
        new_lead(org, first_name="C")
        new_lead(org, first_name="D")
    assert am.Notification.objects.filter(recipient=org["manager"]).count() == 2  # not grouped
    assert mgr.patch(f"{root}/preferences", {"events": {"nonsense": True}}).status_code == 400
    # Workspace defaults: owners and admins only; they apply to everyone without their own setting.
    assert mgr.patch(f"{root}/preferences/workspace", {"muted": True}).status_code == 403
    owner, _ = auto(org, org["owner"])
    assert owner.patch(f"{root}/preferences/workspace", {"events": {"lead.created": False}}).status_code == 200
    data = body(owner.get(f"{root}/preferences"))["data"]
    assert data["workspace"]["events"]["lead.created"] is False and data["effective"]["events"]["lead.created"] is False
    assert AuditEvent.objects.filter(action="automation.notificationpreference.org").exists()
