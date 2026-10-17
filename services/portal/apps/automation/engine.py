"""The automation engine: events, rule matching, executions, retries and loop protection.

    engine.emit(workspace_id, "contact.created", subject=contact, dedup_key=str(contact.pk),
                payload={"contact": engine.contact_facts(contact)}, actor=request_user)

``emit`` runs after the surrounding transaction commits (``transaction.on_commit``), so a
rolled-back write never triggers anything. It records one ``AutomationEvent`` per
(workspace, event type, dedup key) — the same fact never fires twice — and one
``AutomationExecution`` per enabled rule and event, then runs it.

Loop protection:

* depth: events caused by an automation's own actions carry ``depth + 1``; beyond
  ``NEXUS_AUTOMATION_MAX_DEPTH`` nothing runs (status ``loop_blocked``);
* a rule never runs for an event its own actions caused (``chain``), however deep;
* rate caps: ``AutomationRule.max_runs_per_hour`` per rule and
  ``NEXUS_AUTOMATION_MAX_RUNS_PER_HOUR`` per workspace (status ``rate_limited``).

Failures are retried with backoff (``RETRY_BACKOFF``) by the worker job ``retries`` and can
be retried by hand (``services.retry_execution``). Every failure stays visible in the
execution history; error messages never contain record contents.

Actions are INTERNAL only: assign owner, create task, notify user, update related tasks.
They run with the permissions of the person who owns the rule (who last saved it), through
``apps.crm.access``, and are audited like any other write.
"""

from __future__ import annotations

import contextvars
import datetime as dt
import logging
import re
from dataclasses import dataclass, field

from django.apps import apps as django_apps
from django.conf import settings
from django.core.exceptions import PermissionDenied
from django.db import IntegrityError, transaction
from django.db.models import F as DbF
from django.http import Http404
from django.utils import timezone

from apps.crm import access
from apps.crm import models as crm
from apps.crm.access import CHANGE, VIEW, Actor, Cap

from . import models as am
from .models import Trigger

log = logging.getLogger("nexus.automation")

RETRY_BACKOFF = [60, 300, 1800]  # seconds before attempt 2, 3, 4
RECENT_WINDOW = dt.timedelta(hours=1)


def max_depth() -> int:
    return int(getattr(settings, "NEXUS_AUTOMATION_MAX_DEPTH", 3))


def workspace_hourly_cap() -> int:
    return int(getattr(settings, "NEXUS_AUTOMATION_MAX_RUNS_PER_HOUR", 300))


class AutomationError(Exception):
    """A failure whose message is safe to show (it never contains record contents)."""

    retryable = False


class TransientError(AutomationError):
    retryable = True


# --- execution context (loop protection) ---------------------------------------------------------


@dataclass(frozen=True)
class _Ctx:
    rule_id: str
    depth: int
    chain: tuple[str, ...] = field(default_factory=tuple)


_current: contextvars.ContextVar[_Ctx | None] = contextvars.ContextVar("nexus_automation_ctx", default=None)


def current_context() -> _Ctx | None:
    return _current.get()


# --- facts (event payloads: IDs and non-sensitive attributes only) ----------------------------------


def contact_facts(c: crm.Contact) -> dict:
    return {"id": str(c.pk), "kind": c.kind, "source": c.source[:60], "priority": c.priority, "roles": list(c.roles or []),
            "has_owner": c.owner_id is not None, "visibility": c.visibility}


def stage_change_facts(o: crm.Opportunity, previous: crm.Stage, target: crm.Stage) -> dict:
    return {
        "opportunity": {"id": str(o.pk), "pipeline_id": str(o.pipeline_id), "pipeline_kind": o.pipeline.kind, "priority": o.priority,
                        "has_owner": o.owner_id is not None},
        "stage": {"id": str(target.pk), "name": target.name, "is_won": target.is_won, "is_lost": target.is_lost},
        "from_stage": {"id": str(previous.pk), "name": previous.name},
    }


def task_facts(t: crm.Task) -> dict:
    return {"task": {"id": str(t.pk), "priority": t.priority, "source": t.source, "has_contact": t.contact_id is not None,
                     "has_opportunity": t.opportunity_id is not None}}


def event_facts(e: crm.CalendarEvent) -> dict:
    return {"event": {"id": str(e.pk), "kind": e.kind, "has_room": bool(e.matrix_room_id)}}


def action_item_facts(a) -> dict:
    return {"item": {"id": str(a.pk), "source": a.source, "has_assignee": a.suggested_assignee_id is not None}}


# Condition fields offered per trigger (dotted paths into the payload).
CONDITION_FIELDS: dict[str, list[str]] = {
    Trigger.CONTACT_CREATED: ["contact.kind", "contact.source", "contact.priority", "contact.roles", "contact.has_owner"],
    Trigger.LEAD_CREATED: ["contact.source", "contact.priority", "contact.roles", "contact.has_owner"],
    Trigger.TASK_OVERDUE: ["task.priority", "task.source", "task.has_contact", "task.has_opportunity"],
    Trigger.APPOINTMENT_UPCOMING: ["event.kind", "event.has_room"],
    Trigger.OPPORTUNITY_STAGE_CHANGED: ["opportunity.pipeline_id", "opportunity.pipeline_kind", "opportunity.priority",
                                        "stage.name", "stage.is_won", "stage.is_lost", "from_stage.name"],
    Trigger.ACTION_ITEM_PROPOSED: ["item.source", "item.has_assignee"],
}
OPERATORS = ["equals", "not_equals", "in", "contains"]

SUBJECT_MODEL = {
    Trigger.CONTACT_CREATED: crm.Contact,
    Trigger.LEAD_CREATED: crm.Contact,
    Trigger.TASK_OVERDUE: crm.Task,
    Trigger.APPOINTMENT_UPCOMING: crm.CalendarEvent,
    Trigger.OPPORTUNITY_STAGE_CHANGED: crm.Opportunity,
    Trigger.ACTION_ITEM_PROPOSED: crm.ActionItem,
}


def _lookup(payload: dict, path: str):
    cur = payload
    for part in path.split("."):
        if not isinstance(cur, dict) or part not in cur:
            return None
        cur = cur[part]
    return cur


def _norm(v):
    return v.strip().lower() if isinstance(v, str) else v


def condition_matches(cond: dict, payload: dict) -> bool:
    actual = _lookup(payload, cond.get("field", ""))
    op, expected = cond.get("op", "equals"), cond.get("value")
    if op == "equals":
        return _norm(actual) == _norm(expected)
    if op == "not_equals":
        return _norm(actual) != _norm(expected)
    if op == "in":
        return isinstance(expected, list) and _norm(actual) in [_norm(x) for x in expected]
    if op == "contains":
        if isinstance(actual, list):
            return _norm(expected) in [_norm(x) for x in actual]
        return isinstance(actual, str) and isinstance(expected, str) and expected.lower() in actual.lower()
    return False


def conditions_match(conditions: list, payload: dict) -> bool:
    return all(condition_matches(c, payload) for c in conditions or [])


# --- emit -------------------------------------------------------------------------------------------


def emit(workspace_id, event_type: str, *, subject=None, dedup_key: str, payload: dict | None = None, actor=None) -> None:
    """Announces a business fact. Runs matching rules after the current transaction commits
    (immediately outside a transaction). Never raises into the caller."""
    ctx = _current.get()
    depth = ctx.depth + 1 if ctx else 0
    chain = list(ctx.chain) + [ctx.rule_id] if ctx else []
    subject_type = subject._meta.label_lower if subject is not None else ""
    subject_id = subject.pk if subject is not None else None
    actor_id = getattr(actor, "pk", None)

    def _run():
        try:
            record_and_dispatch(workspace_id, event_type, subject_type=subject_type, subject_id=subject_id, dedup_key=dedup_key,
                                payload=payload or {}, depth=depth, chain=chain, actor_id=actor_id)
        except Exception:  # never break the request that caused the event
            log.exception("automation dispatch failed for %s", event_type)

    transaction.on_commit(_run, robust=True)


def record_and_dispatch(workspace_id, event_type, *, subject_type="", subject_id=None, dedup_key, payload, depth=0, chain=(),
                        actor_id=None) -> am.AutomationEvent | None:
    rules = list(am.AutomationRule.objects.filter(workspace_id=workspace_id, trigger=event_type, enabled=True).order_by("created_at"))
    if not rules:
        return None  # nothing listens: no event row (keeps the table small)
    try:
        with transaction.atomic():
            event = am.AutomationEvent.objects.create(
                workspace_id=workspace_id, event_type=event_type, dedup_key=str(dedup_key)[:200], subject_type=subject_type,
                subject_id=subject_id, payload=payload, depth=depth, chain=list(chain), emitted_by_id=actor_id,
            )
    except IntegrityError:
        return None  # the same fact was announced before: never fires twice
    for rule in rules:
        start_execution(rule, event)
    return event


def _recent_runs(qs) -> int:
    since = timezone.now() - RECENT_WINDOW
    return qs.filter(created_at__gte=since).exclude(status__in=[am.AutomationExecution.Status.RATE_LIMITED,
                                                               am.AutomationExecution.Status.LOOP_BLOCKED]).count()


def start_execution(rule: am.AutomationRule, event: am.AutomationEvent) -> am.AutomationExecution | None:
    S = am.AutomationExecution.Status
    status, reason = S.PENDING, ""
    if str(rule.pk) in [str(x) for x in event.chain]:
        status, reason = S.LOOP_BLOCKED, "Not run: this rule's own action caused the event."
    elif event.depth > max_depth():
        status, reason = S.LOOP_BLOCKED, f"Not run: more than {max_depth()} automations triggered each other."
    elif _recent_runs(am.AutomationExecution.objects.filter(rule=rule)) >= rule.max_runs_per_hour:
        status, reason = S.RATE_LIMITED, f"Not run: this rule already ran {rule.max_runs_per_hour} times in the last hour."
    elif _recent_runs(am.AutomationExecution.objects.filter(workspace_id=rule.workspace_id)) >= workspace_hourly_cap():
        status, reason = S.RATE_LIMITED, "Not run: the workspace reached its hourly automation limit."
    try:
        with transaction.atomic():
            execution = am.AutomationExecution.objects.create(
                workspace_id=rule.workspace_id, rule=rule, event=event, dedup_key=f"{rule.pk}:{event.pk}", status=status,
                last_error=reason, next_attempt_at=timezone.now() if status == S.PENDING else None, is_demo=rule.is_demo,
            )
    except IntegrityError:
        return None
    if status == S.PENDING:
        run_execution(execution)
    else:
        _touch_rule(rule, status)
    return execution


def _touch_rule(rule: am.AutomationRule, status: str) -> None:
    am.AutomationRule.objects.filter(pk=rule.pk).update(last_run_at=timezone.now(), last_status=status)


# --- running ----------------------------------------------------------------------------------------


def rule_actor(rule: am.AutomationRule) -> Actor:
    """The person whose permissions the rule's actions use: whoever last saved it. They must
    still be an active member who may manage automations."""
    user = rule.updated_by or rule.created_by
    if user is None or not user.is_active or getattr(user, "status", "active") != "active":
        raise AutomationError("The person who owns this rule is no longer active. Save the rule again to take it over.")
    try:
        actor = access.actor_for(user, rule.workspace_id)
    except Http404:
        raise AutomationError("The person who owns this rule left the workspace. Save the rule again to take it over.") from None
    if not actor.can(Cap.AUTOMATION_MANAGE):
        raise AutomationError("The person who owns this rule may no longer manage automations. Save it again to take it over.")
    return actor


def load_subject(event: am.AutomationEvent):
    if not event.subject_type or not event.subject_id:
        return None
    try:
        model = django_apps.get_model(event.subject_type)
    except (LookupError, ValueError):
        return None
    return model.objects.filter(workspace_id=event.workspace_id, pk=event.subject_id).first()


def _safe_error(exc: Exception) -> str:
    if isinstance(exc, (AutomationError, PermissionDenied)):
        return (str(exc) or "Not allowed.")[:500]
    if isinstance(exc, Http404):
        return "A record the rule needs no longer exists or isn't visible to the rule's owner."
    # Anything else: the exception type only (its message could quote record contents).
    return f"Unexpected error ({type(exc).__name__}). It will be retried."


def run_execution(execution: am.AutomationExecution, *, manual: bool = False) -> am.AutomationExecution:
    """Runs one execution (all actions in one transaction: all or nothing)."""
    S = am.AutomationExecution.Status
    rule, event = execution.rule, execution.event
    execution.status = S.RUNNING
    execution.attempts += 1
    execution.started_at = timezone.now()
    execution.next_attempt_at = None
    execution.save(update_fields=["status", "attempts", "started_at", "next_attempt_at", "updated_at"])
    try:
        if not rule.enabled and not manual:
            raise AutomationError("The rule was turned off before it ran.")
        actor = rule_actor(rule)
        subject = load_subject(event)
        if event.subject_type and subject is None:
            execution.status, execution.last_error = S.SKIPPED, "The record no longer exists."
        elif not conditions_match(rule.conditions, event.payload):
            execution.status, execution.last_error = S.SKIPPED, ""
        else:
            token = _current.set(_Ctx(rule_id=str(rule.pk), depth=event.depth, chain=tuple(str(x) for x in event.chain)))
            try:
                with transaction.atomic():
                    results = []
                    for action in rule.actions or []:
                        fn = ACTIONS.get(action.get("type"))
                        if fn is None:
                            raise AutomationError(f"Unknown action {str(action.get('type'))[:40]!r}.")
                        results.append(fn(actor, rule, event, execution, subject, action.get("params") or {}))
            finally:
                _current.reset(token)
            execution.status, execution.last_error, execution.result = S.SUCCEEDED, "", {"actions": results}
    except Exception as exc:  # noqa: BLE001 - every failure is recorded and visible
        retryable = getattr(exc, "retryable", not isinstance(exc, (AutomationError, PermissionDenied, Http404)))
        execution.last_error = _safe_error(exc)
        if retryable and execution.attempts < execution.max_attempts:
            execution.status = S.RETRYING
            execution.next_attempt_at = timezone.now() + dt.timedelta(seconds=RETRY_BACKOFF[min(execution.attempts - 1, len(RETRY_BACKOFF) - 1)])
        else:
            execution.status = S.FAILED
        log.warning("automation execution %s failed (%s)", execution.pk, type(exc).__name__)
    execution.finished_at = timezone.now()
    execution.save(update_fields=["status", "last_error", "result", "next_attempt_at", "finished_at", "updated_at"])
    am.AutomationRule.objects.filter(pk=rule.pk).update(last_run_at=execution.finished_at, last_status=execution.status,
                                                        run_count=DbF("run_count") + 1)
    return execution


def run_due_retries(now=None, limit: int = 100) -> int:
    now = now or timezone.now()
    due = list(am.AutomationExecution.objects.filter(status=am.AutomationExecution.Status.RETRYING, next_attempt_at__lte=now)
               .select_related("rule", "event").order_by("next_attempt_at")[:limit])
    for execution in due:
        run_execution(execution)
    return len(due)


# --- actions (internal only) ---------------------------------------------------------------------------

_PLACEHOLDER = re.compile(r"\{([a-z_]+)\.([a-z_]+)\}")


def labels_for(subject, event: am.AutomationEvent) -> dict[str, str]:
    """Values for title templates, from the subject as it is now."""
    out: dict[str, str] = {}
    if isinstance(subject, crm.Contact):
        out["contact.name"] = subject.display_name
    elif isinstance(subject, crm.Opportunity):
        out["opportunity.name"] = subject.name
        out["stage.name"] = _lookup(event.payload, "stage.name") or subject.stage.name
        out["from_stage.name"] = _lookup(event.payload, "from_stage.name") or ""
        out["pipeline.name"] = subject.pipeline.name
    elif isinstance(subject, crm.Task):
        out["task.title"] = subject.title
        if subject.contact_id:
            out["contact.name"] = subject.contact.display_name
    elif isinstance(subject, crm.CalendarEvent):
        out["event.title"] = subject.title
        out["event.time"] = timezone.localtime(subject.start_at).strftime("%H:%M")
    elif isinstance(subject, crm.ActionItem):
        out["item.title"] = subject.title
    return out


def render(template: str, labels: dict[str, str], limit: int) -> str:
    text = _PLACEHOLDER.sub(lambda mt: labels.get(f"{mt.group(1)}.{mt.group(2)}", ""), template or "")
    return re.sub(r"\s+", " ", text).strip()[:limit]


def subject_link(subject) -> str:
    if isinstance(subject, crm.Contact):
        return f"#/contacts/{subject.pk}"
    if isinstance(subject, crm.Opportunity):
        return f"#/crm/{subject.pk}"
    if isinstance(subject, crm.Task):
        return "#/tasks"
    if isinstance(subject, crm.CalendarEvent):
        return f"#/calendar/event/{subject.pk}"
    if isinstance(subject, crm.ActionItem):
        return "#/calls/next-steps"
    return ""


def subject_owner(subject):
    for attr in ("owner", "assignee", "organizer", "suggested_assignee"):
        if hasattr(subject, attr):
            return getattr(subject, attr)
    return None


def _member(actor: Actor, public_id):
    try:
        return access.resolve_member(actor, public_id, field_name="user_id")
    except Exception:  # noqa: BLE001 - surfaced as a safe message
        raise AutomationError("A person named in the rule is no longer a member of this workspace.") from None


def _can_view(user, workspace_id, obj) -> bool:
    try:
        viewer = access.actor_for(user, workspace_id)
    except Http404:
        return False
    return access.for_actor(viewer, type(obj), VIEW).filter(pk=obj.pk).exists()


def _notify(rule, execution, subject, recipient, *, event_type: str, title: str, body: str = "") -> bool:
    from .notifications import notify

    if recipient is None or not _can_view(recipient, rule.workspace_id, subject):
        return False
    n = notify(rule.workspace, recipient, event_type=event_type, title=title, body=body, link=subject_link(subject), related=subject,
               group_key=f"{event_type}:{rule.pk}", execution=execution, is_demo=rule.is_demo)
    return n is not None


def act_assign_owner(actor, rule, event, execution, subject, params) -> dict:
    """Sets the subject's owner (contacts, deals) or assignee (tasks): one person, or the next
    person of ``user_ids`` in turn (round robin)."""
    if params.get("user_ids"):
        people = [_member(actor, pid) for pid in params["user_ids"]]
        turn = am.AutomationExecution.objects.filter(rule=rule, status=am.AutomationExecution.Status.SUCCEEDED).count()
        user = people[turn % len(people)]
    else:
        user = _member(actor, params.get("user_id"))
    field_name = "assignee" if isinstance(subject, crm.Task) else "owner"
    if not hasattr(subject, field_name) or not isinstance(subject, (crm.Contact, crm.Opportunity, crm.Task)):
        raise AutomationError("This trigger's record has no owner to assign.")
    if params.get("only_if_unassigned", True) and getattr(subject, f"{field_name}_id") is not None:
        return {"type": "assign_owner", "changed": False, "reason": "already assigned"}
    if not access.for_actor(actor, type(subject), CHANGE).filter(pk=subject.pk).exists():
        raise AutomationError("The rule's owner may not change this record.")
    if getattr(subject, f"{field_name}_id") == user.pk:
        return {"type": "assign_owner", "changed": False}
    setattr(subject, field_name, user)
    subject.save(update_fields=[field_name, "updated_at"])
    access.audit_write(None, actor, "update", subject, fields=[field_name], extra={"via": "automation", "rule": str(rule.pk)})
    name = labels_for(subject, event)
    label = name.get("contact.name") or name.get("opportunity.name") or name.get("task.title") or "a record"
    notified = user != actor.user and _notify(rule, execution, subject, user, event_type="assignment", title=f"Assigned to you: {label}"[:200])
    return {"type": "assign_owner", "changed": True, "user": str(user.public_id), "notified": bool(notified)}


def _task_links(subject):
    if isinstance(subject, crm.Contact):
        return {"contact": subject}
    if isinstance(subject, crm.Opportunity):
        return {"opportunity": subject, "contact": subject.contacts.order_by("opportunity_links__id").first()}
    if isinstance(subject, crm.Task):
        return {"contact": subject.contact, "opportunity": subject.opportunity}
    if isinstance(subject, crm.CalendarEvent):
        return {"contact": subject.contact, "opportunity": subject.opportunity, "related": subject}
    if isinstance(subject, crm.ActionItem):
        return {"contact": subject.contact, "opportunity": subject.opportunity}
    return {}


def act_create_task(actor, rule, event, execution, subject, params) -> dict:
    from apps.crm import services

    labels = labels_for(subject, event)
    title = render(params.get("title") or "Follow up", labels, 200) or "Follow up"
    who = params.get("assignee") or "subject_owner"
    if who == "subject_owner":
        assignee = subject_owner(subject) or actor.user
    elif who == "rule_owner":
        assignee = actor.user
    else:
        assignee = _member(actor, who)
    hours = int(params.get("due_in_hours") or 0)
    due = timezone.now() + dt.timedelta(hours=hours) if hours else None
    links = _task_links(subject)
    links = {k: v for k, v in links.items() if v is not None and (k == "related" or access.for_actor(actor, type(v)).filter(pk=v.pk).exists())}
    visibility = getattr(subject, "visibility", crm.Visibility.TEAM)
    if visibility not in crm.Visibility.values:
        visibility = crm.Visibility.TEAM
    t = services.record_automation_task(actor, title=title, assignee=assignee, due_at=due, priority=params.get("priority") or "normal",
                                        visibility=visibility, **links)
    notified = assignee != actor.user and _notify(rule, execution, t, assignee, event_type="assignment", title=f"New task for you: {t.title}"[:200])
    return {"type": "create_task", "task_id": str(t.pk), "notified": bool(notified)}


def act_notify_user(actor, rule, event, execution, subject, params) -> dict:
    labels = labels_for(subject, event)
    title = render(params.get("title") or rule.name, labels, 200) or rule.name[:200]
    body = render(params.get("body") or "", labels, 300)
    who = params.get("recipient") or "subject_owner"
    if who == "subject_owner":
        people = [subject_owner(subject)]
    elif who == "attendees" and isinstance(subject, crm.CalendarEvent):
        people = [subject.organizer, *subject.attendee_users.all()]
    elif who == "rule_owner":
        people = [actor.user]
    else:
        people = [_member(actor, who)]
    seen, sent = set(), 0
    for person in people:
        if person is None or person.pk in seen:
            continue
        seen.add(person.pk)
        sent += _notify(rule, execution, subject, person, event_type=event.event_type, title=title, body=body)
    return {"type": "notify_user", "notified": sent}


def act_update_related_tasks(actor, rule, event, execution, subject, params) -> dict:
    """Completes or cancels the open tasks of the subject deal/contact (by default only the
    ones automations created)."""
    from apps.crm import services

    if isinstance(subject, crm.Opportunity):
        qs = crm.Task.objects.filter(workspace_id=rule.workspace_id, opportunity=subject)
    elif isinstance(subject, crm.Contact):
        qs = crm.Task.objects.filter(workspace_id=rule.workspace_id, contact=subject)
    else:
        raise AutomationError("Only deals and contacts have related tasks to update.")
    qs = qs.filter(status__in=[crm.Task.Status.OPEN, crm.Task.Status.IN_PROGRESS])
    if params.get("only_automation", True):
        qs = qs.filter(source=crm.Task.Source.AUTOMATION)
    status = params.get("set_status") or crm.Task.Status.DONE
    changeable = access.for_actor(actor, crm.Task, CHANGE)
    updated = 0
    for t in qs.filter(pk__in=changeable.values("pk")):
        services._task_status(t, status, actor)
        t.save(update_fields=["status", "completed_at", "completed_by", "updated_at"])
        access.audit_write(None, actor, "update", t, fields=["status"], extra={"via": "automation", "rule": str(rule.pk)})
        updated += 1
    return {"type": "update_related_tasks", "updated": updated}


ACTIONS = {
    "assign_owner": act_assign_owner,
    "create_task": act_create_task,
    "notify_user": act_notify_user,
    "update_related_tasks": act_update_related_tasks,
}
