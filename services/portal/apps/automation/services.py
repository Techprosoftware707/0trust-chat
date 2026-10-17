"""Automation rules: validation, create/update/delete, the catalog the editor shows, manual
retries, and the example rules seeded for new business workspaces.

Only owners, admins and managers (``Cap.AUTOMATION_MANAGE``) manage rules. Saving a rule makes
the saver its owner: its actions run with that person's permissions. Actions are INTERNAL in
this phase (assign owner, create task, notify user, update related tasks); external actions
(email, Slack, GoHighLevel) come later, only where an integration supports them, and only with
confirmation.
"""

from __future__ import annotations

import datetime as dt
import uuid

from django.utils import timezone

from apps.api.errors import ValidationFailed
from apps.api.schema import F, Invalid, validate
from apps.crm import access
from apps.crm import models as crm
from apps.crm.access import Actor, Cap

from . import engine
from . import models as am
from .models import Trigger

ACTION_TYPES = {
    "assign_owner": "Assign an owner",
    "create_task": "Create a task",
    "notify_user": "Notify someone in the app",
    "update_related_tasks": "Complete or cancel related tasks",
}
# Which actions make sense for which trigger's record.
ACTIONS_FOR = {
    Trigger.CONTACT_CREATED: ["assign_owner", "create_task", "notify_user", "update_related_tasks"],
    Trigger.LEAD_CREATED: ["assign_owner", "create_task", "notify_user", "update_related_tasks"],
    Trigger.TASK_OVERDUE: ["assign_owner", "create_task", "notify_user"],
    Trigger.APPOINTMENT_UPCOMING: ["create_task", "notify_user"],
    Trigger.OPPORTUNITY_STAGE_CHANGED: ["assign_owner", "create_task", "notify_user", "update_related_tasks"],
    Trigger.ACTION_ITEM_PROPOSED: ["create_task", "notify_user"],
}
RECIPIENTS = {"subject_owner": "The record's owner / assignee", "attendees": "Organizer and attendees (appointments)",
              "rule_owner": "The rule's owner"}
ASSIGNEES = {"subject_owner": "The record's owner / assignee", "rule_owner": "The rule's owner"}
PLACEHOLDERS = {
    Trigger.CONTACT_CREATED: ["{contact.name}"],
    Trigger.LEAD_CREATED: ["{contact.name}"],
    Trigger.TASK_OVERDUE: ["{task.title}", "{contact.name}"],
    Trigger.APPOINTMENT_UPCOMING: ["{event.title}", "{event.time}"],
    Trigger.OPPORTUNITY_STAGE_CHANGED: ["{opportunity.name}", "{stage.name}", "{from_stage.name}", "{pipeline.name}"],
    Trigger.ACTION_ITEM_PROPOSED: ["{item.title}"],
}


def catalog() -> dict:
    """Everything the rule editor needs: triggers, condition fields, operators, actions."""
    return {
        "triggers": [{"value": t.value, "label": t.label, "condition_fields": engine.CONDITION_FIELDS[t.value],
                      "actions": ACTIONS_FOR[t.value], "placeholders": PLACEHOLDERS[t.value]} for t in Trigger],
        "operators": engine.OPERATORS,
        "actions": [{"value": k, "label": v} for k, v in ACTION_TYPES.items()],
        "recipients": [{"value": k, "label": v} for k, v in RECIPIENTS.items()],
        "assignees": [{"value": k, "label": v} for k, v in ASSIGNEES.items()],
        "external_actions": "Not available yet: email, Slack and GoHighLevel actions come with the integrations, and will ask for confirmation.",
    }


RULE_SPEC = {
    "name": F.string(max_length=120, required=True, blank=False),
    "description": F.string(max_length=500),
    "trigger": F.choice(Trigger.values, required=True),
    "conditions": F.list(F.object(max_keys=3), max_items=10, unique=False),
    "actions": F.list(F.object(max_keys=2), max_items=5, unique=False),
    "enabled": F.boolean(default=False),
    "max_runs_per_hour": F.integer(min_value=1, max_value=1000, default=60),
}


def _person(actor: Actor, value, field: str) -> str:
    if value in ("subject_owner", "rule_owner", "attendees"):
        return value
    try:
        uuid.UUID(str(value))
    except (TypeError, ValueError):
        raise ValidationFailed(fields={field: ["Choose a person or one of the listed roles."]}) from None
    return str(access.resolve_member(actor, str(value), field_name=field).public_id)


def _clean_conditions(trigger: str, conditions: list) -> list:
    allowed = engine.CONDITION_FIELDS[trigger]
    clean = []
    for i, c in enumerate(conditions):
        fld, op, value = c.get("field"), c.get("op", "equals"), c.get("value")
        if fld not in allowed:
            raise ValidationFailed(fields={f"conditions.{i}.field": [f"Choose one of: {', '.join(allowed)}."]})
        if op not in engine.OPERATORS:
            raise ValidationFailed(fields={f"conditions.{i}.op": [f"Choose one of: {', '.join(engine.OPERATORS)}."]})
        if op == "in":
            if not isinstance(value, list) or not value or len(value) > 20 or not all(isinstance(v, (str, bool, int)) for v in value):
                raise ValidationFailed(fields={f"conditions.{i}.value": ["Give a list of up to 20 values."]})
        elif not isinstance(value, (str, bool, int)) or (isinstance(value, str) and len(value) > 120):
            raise ValidationFailed(fields={f"conditions.{i}.value": ["Give a value (text up to 120 characters, a number or true/false)."]})
        clean.append({"field": fld, "op": op, "value": value})
    return clean


def _text(params: dict, key: str, limit: int, field: str, *, required: bool = False) -> str:
    try:
        return F.string(max_length=limit, blank=not required).parse(params.get(key, "")) if key in params or required else ""
    except Invalid as exc:
        raise ValidationFailed(fields={field: [str(exc)]}) from None


def _clean_actions(actor: Actor, trigger: str, actions: list) -> list:
    if not actions:
        raise ValidationFailed(fields={"actions": ["Add at least one action."]})
    clean = []
    for i, a in enumerate(actions):
        kind, params = a.get("type"), a.get("params") or {}
        f = f"actions.{i}"
        if kind not in ACTION_TYPES:
            raise ValidationFailed(fields={f"{f}.type": ["This action isn't available. External actions come later, with confirmation."]})
        if kind not in ACTIONS_FOR[trigger]:
            raise ValidationFailed(fields={f"{f}.type": ["This action doesn't fit the trigger."]})
        if not isinstance(params, dict) or len(params) > 6:
            raise ValidationFailed(fields={f"{f}.params": ["Must be an object."]})
        out: dict = {}
        if kind == "assign_owner":
            if params.get("user_ids"):
                ids = params["user_ids"]
                if not isinstance(ids, list) or len(ids) > 20:
                    raise ValidationFailed(fields={f"{f}.params.user_ids": ["Give up to 20 people."]})
                out["user_ids"] = [str(u.public_id) for u in access.resolve_members(actor, ids, field_name=f"{f}.params.user_ids")]
            else:
                out["user_id"] = str(access.resolve_member(actor, params.get("user_id"), field_name=f"{f}.params.user_id").public_id) \
                    if params.get("user_id") else None
                if out["user_id"] is None:
                    raise ValidationFailed(fields={f"{f}.params.user_id": ["Choose who becomes the owner."]})
            only = params.get("only_if_unassigned", True)
            if not isinstance(only, bool):
                raise ValidationFailed(fields={f"{f}.params.only_if_unassigned": ["Must be true or false."]})
            out["only_if_unassigned"] = only
        elif kind == "create_task":
            out["title"] = _text(params, "title", 200, f"{f}.params.title", required=True)
            out["assignee"] = _person(actor, params.get("assignee", "subject_owner"), f"{f}.params.assignee")
            if out["assignee"] == "attendees":
                raise ValidationFailed(fields={f"{f}.params.assignee": ["A task has one assignee."]})
            hours = params.get("due_in_hours", 0)
            if isinstance(hours, bool) or not isinstance(hours, int) or not 0 <= hours <= 24 * 365:
                raise ValidationFailed(fields={f"{f}.params.due_in_hours": ["Between 0 and 8760 hours."]})
            out["due_in_hours"] = hours
            prio = params.get("priority", "normal")
            if prio not in crm.Priority.values:
                raise ValidationFailed(fields={f"{f}.params.priority": ["Unknown priority."]})
            out["priority"] = prio
        elif kind == "notify_user":
            out["recipient"] = _person(actor, params.get("recipient", "subject_owner"), f"{f}.params.recipient")
            if out["recipient"] == "attendees" and trigger != Trigger.APPOINTMENT_UPCOMING:
                raise ValidationFailed(fields={f"{f}.params.recipient": ["Attendees exist for appointments only."]})
            out["title"] = _text(params, "title", 200, f"{f}.params.title", required=True)
            out["body"] = _text(params, "body", 300, f"{f}.params.body")
        elif kind == "update_related_tasks":
            status = params.get("set_status", "done")
            if status not in (crm.Task.Status.DONE, crm.Task.Status.CANCELED):
                raise ValidationFailed(fields={f"{f}.params.set_status": ["Complete (done) or cancel (canceled)."]})
            only = params.get("only_automation", True)
            if not isinstance(only, bool):
                raise ValidationFailed(fields={f"{f}.params.only_automation": ["Must be true or false."]})
            out = {"set_status": status, "only_automation": only}
        clean.append({"type": kind, "params": out})
    return clean


def create_rule(request, actor: Actor, body: dict) -> am.AutomationRule:
    """A new rule (off unless ``enabled``); the creator owns it."""
    access.require(actor, Cap.AUTOMATION_MANAGE, "Only owners, admins and managers manage automations.")
    data = validate(body, RULE_SPEC)
    rule = am.AutomationRule(workspace=actor.workspace, created_by=actor.user, updated_by=actor.user, name=data["name"],
                             description=data["description"], trigger=data["trigger"], enabled=data["enabled"],
                             max_runs_per_hour=data["max_runs_per_hour"])
    rule.conditions = _clean_conditions(rule.trigger, data["conditions"])
    rule.actions = _clean_actions(actor, rule.trigger, data["actions"])
    rule.save()
    access.audit_write(request, actor, "create", rule, fields=list(body))
    return rule


def update_rule(request, actor: Actor, rule: am.AutomationRule, body: dict) -> am.AutomationRule:
    """Changes a rule. The person who saves it becomes its owner (its actions use their
    permissions from now on)."""
    spec = dict(RULE_SPEC)
    spec["name"] = F.string(max_length=120, blank=False)
    spec["trigger"] = F.choice(Trigger.values)
    data = validate(body, spec, partial=True)
    changed: list[str] = []
    for key in ("name", "description", "enabled", "max_runs_per_hour", "trigger"):
        if key in data and getattr(rule, key) != data[key]:
            setattr(rule, key, data[key])
            changed.append(key)
    if "conditions" in data or "trigger" in data:
        rule.conditions = _clean_conditions(rule.trigger, data.get("conditions", rule.conditions))
        changed.append("conditions")
    if "actions" in data or "trigger" in data:
        rule.actions = _clean_actions(actor, rule.trigger, data.get("actions", rule.actions))
        changed.append("actions")
    rule.updated_by = actor.user
    rule.save()
    access.audit_write(request, actor, "update", rule, fields=changed)
    return rule


def retry_execution(request, actor: Actor, execution: am.AutomationExecution) -> am.AutomationExecution:
    """Runs a failed, rate-limited or loop-blocked execution again now (manual retry).
    Loop protection still applies: a rule never runs for its own actions' events."""
    S = am.AutomationExecution.Status
    if execution.status in (S.SUCCEEDED, S.RUNNING, S.PENDING, S.SKIPPED):
        raise ValidationFailed(fields={"status": ["Only failed or blocked runs can be retried."]})
    if str(execution.rule_id) in [str(x) for x in execution.event.chain] or execution.event.depth > engine.max_depth():
        raise ValidationFailed(fields={"status": ["Loop protection: this run can't be retried."]})
    execution.max_attempts = max(execution.max_attempts, execution.attempts + 1)
    execution.save(update_fields=["max_attempts", "updated_at"])
    access.audit_write(request, actor, "retry", execution, fields=["status"])
    return engine.run_execution(execution, manual=True)


# --- example rules (the brief's examples), seeded per workspace --------------------------------------

EXAMPLES = [
    {
        "template_key": "new-lead-follow-up",
        "name": "New lead: assign an owner and a follow-up task",
        "description": "A new lead without an owner goes to the rule's owner, and the lead's owner gets a follow-up task due in a day.",
        "trigger": Trigger.LEAD_CREATED,
        "conditions": [],
        "actions": [
            {"type": "assign_owner", "params": {"user_id": "@owner", "only_if_unassigned": True}},
            {"type": "create_task", "params": {"title": "Follow up with new lead {contact.name}", "assignee": "subject_owner",
                                               "due_in_hours": 24, "priority": "high"}},
        ],
    },
    {
        "template_key": "appointment-reminder",
        "name": "Appointment reminder",
        "description": "An hour before an appointment, the organizer and internal attendees get a reminder in the app.",
        "trigger": Trigger.APPOINTMENT_UPCOMING,
        "conditions": [],
        "actions": [{"type": "notify_user", "params": {"recipient": "attendees", "title": "Coming up at {event.time}: {event.title}",
                                                       "body": ""}}],
    },
    {
        "template_key": "task-overdue-notify",
        "name": "Overdue task: notify the assignee",
        "description": "When a task passes its due time, its assignee is notified in the app.",
        "trigger": Trigger.TASK_OVERDUE,
        "conditions": [],
        "actions": [{"type": "notify_user", "params": {"recipient": "subject_owner", "title": "Overdue: {task.title}", "body": ""}}],
    },
    {
        "template_key": "stage-change-update-tasks",
        "name": "Deal stage change: update tasks",
        "description": "When a deal moves, its open automation tasks are completed and the owner gets a task for the new stage.",
        "trigger": Trigger.OPPORTUNITY_STAGE_CHANGED,
        "conditions": [{"field": "stage.is_lost", "op": "equals", "value": False}],
        "actions": [
            {"type": "update_related_tasks", "params": {"set_status": "done", "only_automation": True}},
            {"type": "create_task", "params": {"title": "{opportunity.name}: next step for {stage.name}", "assignee": "subject_owner",
                                               "due_in_hours": 48, "priority": "normal"}},
        ],
    },
]


def seed_example_rules(workspace, user, *, enabled: bool = False, is_demo: bool = False) -> list[am.AutomationRule]:
    """Creates the example rules (idempotent by ``template_key``), owned by ``user``."""
    created = []
    for ex in EXAMPLES:
        if am.AutomationRule.objects.filter(workspace=workspace, template_key=ex["template_key"]).exists():
            continue
        actions = []
        for a in ex["actions"]:
            params = dict(a["params"])
            if params.get("user_id") == "@owner":
                params["user_id"] = str(user.public_id)
            actions.append({"type": a["type"], "params": params})
        created.append(am.AutomationRule.objects.create(
            workspace=workspace, created_by=user, updated_by=user, name=ex["name"], description=ex["description"],
            trigger=ex["trigger"], conditions=ex["conditions"], actions=actions, enabled=enabled, template_key=ex["template_key"],
            is_demo=is_demo,
        ))
    return created


def execution_summary(actor: Actor) -> dict:
    """Counts for the admin page: failures waiting for attention, last 24 hours."""
    qs = access.for_actor(actor, am.AutomationExecution)
    since = timezone.now() - dt.timedelta(hours=24)
    S = am.AutomationExecution.Status
    return {
        "failed": qs.filter(status=S.FAILED).count(),
        "retrying": qs.filter(status=S.RETRYING).count(),
        "blocked": qs.filter(status__in=[S.RATE_LIMITED, S.LOOP_BLOCKED], created_at__gte=since).count(),
        "succeeded_24h": qs.filter(status=S.SUCCEEDED, created_at__gte=since).count(),
    }
