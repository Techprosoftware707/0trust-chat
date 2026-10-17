"""JSON API of automation and notifications: /api/v1/workspaces/<id>/automation/...

Rules, executions (history and failures) and manual retries: owners, admins, managers.
Notifications and preferences: every member, for themselves; workspace defaults: owners and
admins change them.
"""

from __future__ import annotations

from apps.api.decorators import api_endpoint
from apps.api.http import created, json_body, no_content, ok, paginated
from apps.api.schema import F, query_bool, query_param
from apps.crm import access
from apps.crm.access import CHANGE, DELETE, Actor, Cap
from apps.crm.serializers import user_ref

from . import models as am
from . import notifications, services

auto_endpoint = lambda methods: api_endpoint(methods=methods, feature="automation")  # noqa: E731


def rule_json(rule: am.AutomationRule) -> dict:
    return {
        "id": str(rule.pk),
        "name": rule.name,
        "description": rule.description,
        "trigger": rule.trigger,
        "trigger_label": am.Trigger(rule.trigger).label,
        "conditions": rule.conditions,
        "actions": rule.actions,
        "enabled": rule.enabled,
        "template_key": rule.template_key,
        "max_runs_per_hour": rule.max_runs_per_hour,
        "run_count": rule.run_count,
        "last_run_at": rule.last_run_at,
        "last_status": rule.last_status,
        "owner": user_ref(rule.updated_by or rule.created_by),
        "is_demo": rule.is_demo,
        "created_at": rule.created_at,
        "updated_at": rule.updated_at,
    }


def execution_json(x: am.AutomationExecution) -> dict:
    return {
        "id": str(x.pk),
        "rule": {"id": str(x.rule_id), "name": x.rule.name},
        "event": {"type": x.event.event_type, "subject": {"type": x.event.subject_type, "id": str(x.event.subject_id) if x.event.subject_id else None},
                  "depth": x.event.depth},
        "status": x.status,
        "status_label": am.AutomationExecution.Status(x.status).label,
        "attempts": x.attempts,
        "max_attempts": x.max_attempts,
        "next_attempt_at": x.next_attempt_at,
        "last_error": x.last_error,
        "result": x.result,
        "started_at": x.started_at,
        "finished_at": x.finished_at,
        "created_at": x.created_at,
        "can_retry": x.status in {"failed", "retrying", "rate_limited"},
    }


def notification_json(n: am.Notification) -> dict:
    return {
        "id": str(n.pk),
        "event_type": n.event_type,
        "title": n.title,
        "body": n.body,
        "link": n.link,
        "related": {"type": n.related_type, "id": str(n.related_id)} if n.related_type and n.related_id else None,
        "count": n.count,
        "read": n.read_at is not None,
        "read_at": n.read_at,
        "created_at": n.created_at,
        "updated_at": n.updated_at,
    }


@auto_endpoint(["GET"])
def catalog(request, actor: Actor):
    access.require(actor, Cap.AUTOMATION_MANAGE)
    return ok(services.catalog())


@auto_endpoint(["GET", "POST"])
def rules(request, actor: Actor):
    """GET filters: trigger, enabled (bool)."""
    access.require(actor, Cap.AUTOMATION_MANAGE, "Only owners, admins and managers manage automations.")
    if request.method == "POST":
        return created(rule_json(services.create_rule(request, actor, json_body(request))))
    qs = access.for_actor(actor, am.AutomationRule).select_related("created_by", "updated_by")
    trigger = query_param(request, "trigger", F.choice(am.Trigger.values))
    if trigger:
        qs = qs.filter(trigger=trigger)
    enabled = query_bool(request, "enabled")
    if enabled is not None:
        qs = qs.filter(enabled=enabled)
    return paginated(request, qs.order_by("name", "pk"), rule_json, default_limit=100)


@auto_endpoint(["GET", "PATCH", "DELETE"])
def rule_detail(request, actor: Actor, rule_id):
    if request.method == "GET":
        return ok(rule_json(access.get_for_actor(actor, am.AutomationRule, rule_id)))
    if request.method == "DELETE":
        rule = access.get_for_actor(actor, am.AutomationRule, rule_id, DELETE)
        access.audit_write(request, actor, "delete", rule)
        rule.delete()
        return no_content()
    rule = access.get_for_actor(actor, am.AutomationRule, rule_id, CHANGE)
    return ok(rule_json(services.update_rule(request, actor, rule, json_body(request))))


@auto_endpoint(["GET"])
def executions(request, actor: Actor):
    """History and failures. Filters: rule, status (failed|retrying|succeeded|skipped|
    rate_limited|loop_blocked|problems)."""
    access.require(actor, Cap.AUTOMATION_MANAGE)
    qs = access.for_actor(actor, am.AutomationExecution).select_related("rule", "event")
    rule_id = query_param(request, "rule", F.uuid())
    if rule_id:
        qs = qs.filter(rule=access.resolve_one(actor, am.AutomationRule, str(rule_id), field_name="rule"))
    status = query_param(request, "status", F.choice(am.AutomationExecution.Status.values + ["problems"]))
    if status == "problems":
        qs = qs.filter(status__in=["failed", "retrying", "rate_limited", "loop_blocked"])
    elif status:
        qs = qs.filter(status=status)
    response = paginated(request, qs.order_by("-created_at", "pk"), execution_json)
    return response


@auto_endpoint(["GET"])
def execution_summary(request, actor: Actor):
    access.require(actor, Cap.AUTOMATION_MANAGE)
    return ok(services.execution_summary(actor))


@auto_endpoint(["POST"])
def execution_retry(request, actor: Actor, execution_id):
    x = access.get_for_actor(actor, am.AutomationExecution, execution_id, CHANGE,
                             queryset=access.for_actor(actor, am.AutomationExecution).select_related("rule", "event"))
    return ok(execution_json(services.retry_execution(request, actor, x)))


# --- notifications ----------------------------------------------------------------------------------


@auto_endpoint(["GET"])
def notification_list(request, actor: Actor):
    """The caller's own notifications, newest first. Filter: unread (bool)."""
    qs = notifications.notifications_for(actor, unread_only=bool(query_bool(request, "unread", False)))
    resp = paginated(request, qs, notification_json)
    return resp


@auto_endpoint(["GET"])
def notification_unread(request, actor: Actor):
    return ok({"unread": notifications.unread_count(actor)})


@auto_endpoint(["PATCH"])
def notification_detail(request, actor: Actor, notification_id):
    n = access.get_for_actor(actor, am.Notification, notification_id, CHANGE)
    from apps.api.schema import validate

    data = validate(json_body(request), {"read": F.boolean(required=True)})
    return ok(notification_json(notifications.mark_read(actor, n, data["read"])))


@auto_endpoint(["POST"])
def notification_read_all(request, actor: Actor):
    return ok({"marked": notifications.mark_all_read(actor)})


@auto_endpoint(["GET", "PATCH"])
def preferences(request, actor: Actor):
    """The caller's notification preferences (and the workspace defaults they inherit)."""
    if request.method == "PATCH":
        mine = notifications.update_preferences(request, actor, json_body(request))
    else:
        mine = notifications.preference_dict(actor.workspace_id, actor.user)
    return ok({"mine": mine, "workspace": notifications.preference_dict(actor.workspace_id, None),
               "effective": notifications.effective_preferences(actor.workspace_id, actor.user),
               "can_edit_workspace": actor.can(Cap.ORG_SETTINGS)})


@auto_endpoint(["PATCH"])
def workspace_preferences(request, actor: Actor):
    """Owners/admins: the workspace's default notification settings."""
    return ok(notifications.update_preferences(request, actor, json_body(request), workspace_default=True))
