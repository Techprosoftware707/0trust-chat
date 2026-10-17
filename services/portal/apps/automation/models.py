"""Automation rules, the events that trigger them, their executions, and in-app notifications.

* An ``AutomationEvent`` is emitted once per business fact (``engine.emit`` after the
  transaction commits; ``dedup_key`` is unique per workspace and event type).
* Each enabled ``AutomationRule`` for that trigger gets one ``AutomationExecution`` per event
  (unique per rule and event), with status, attempts, the last error, retries with backoff and
  a manual retry. Loop protection: a depth limit, a rule never re-triggers itself through its
  own actions, and rate caps per rule and per workspace.
* Actions in this phase are INTERNAL only (assign owner, create task, notify user, update
  related tasks). Nothing here sends email, posts to Slack or changes external records.
"""

from __future__ import annotations

from django.conf import settings
from django.db import models
from django.db.models import Q

from apps.crm.models import TenantModel

USER = settings.AUTH_USER_MODEL


class Trigger(models.TextChoices):
    CONTACT_CREATED = "contact.created", "A contact is created"
    LEAD_CREATED = "lead.created", "A lead is created"
    TASK_OVERDUE = "task.overdue", "A task becomes overdue"
    APPOINTMENT_UPCOMING = "appointment.upcoming", "An appointment is coming up"
    OPPORTUNITY_STAGE_CHANGED = "opportunity.stage_changed", "A deal moves to another stage"
    ACTION_ITEM_PROPOSED = "action_item.proposed", "A next step is suggested"


class AutomationRule(TenantModel):
    name = models.CharField(max_length=120)
    description = models.CharField(max_length=500, blank=True)
    trigger = models.CharField(max_length=40, choices=Trigger.choices)
    conditions = models.JSONField(default=list, blank=True, help_text="[{field, op, value}] (all must match).")
    actions = models.JSONField(default=list, blank=True, help_text="[{type, params}] (internal actions only).")
    enabled = models.BooleanField(default=False)
    template_key = models.SlugField(max_length=60, blank=True, help_text="Set for the seeded example rules.")
    max_runs_per_hour = models.PositiveIntegerField(default=60)
    run_count = models.PositiveIntegerField(default=0)
    last_run_at = models.DateTimeField(null=True, blank=True)
    last_status = models.CharField(max_length=20, blank=True)
    updated_by = models.ForeignKey(USER, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")

    class Meta:
        ordering = ["name"]
        indexes = [models.Index(fields=["workspace", "trigger", "enabled"], name="auto_rule_ws_trigger")]

    def __str__(self) -> str:
        return self.name


class AutomationEvent(TenantModel):
    """One business fact that rules can react to. ``payload`` holds IDs and non-sensitive
    attributes only (never record contents)."""

    event_type = models.CharField(max_length=40, choices=Trigger.choices)
    dedup_key = models.CharField(max_length=200)
    subject_type = models.CharField(max_length=60, blank=True)
    subject_id = models.UUIDField(null=True, blank=True)
    payload = models.JSONField(default=dict, blank=True)
    depth = models.PositiveSmallIntegerField(default=0)
    chain = models.JSONField(default=list, blank=True, help_text="IDs of the rules whose actions led to this event.")
    emitted_by = models.ForeignKey(USER, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")

    class Meta:
        ordering = ["-created_at"]
        constraints = [models.UniqueConstraint(fields=["workspace", "event_type", "dedup_key"], name="auto_event_dedup")]
        indexes = [models.Index(fields=["workspace", "-created_at"], name="auto_event_ws_created")]


class AutomationExecution(TenantModel):
    class Status(models.TextChoices):
        PENDING = "pending", "Waiting to run"
        RUNNING = "running", "Running"
        SUCCEEDED = "succeeded", "Succeeded"
        SKIPPED = "skipped", "Skipped (conditions not met)"
        RETRYING = "retrying", "Failed, will retry"
        FAILED = "failed", "Failed"
        RATE_LIMITED = "rate_limited", "Not run: rate cap reached"
        LOOP_BLOCKED = "loop_blocked", "Not run: loop protection"

    rule = models.ForeignKey(AutomationRule, on_delete=models.CASCADE, related_name="executions")
    event = models.ForeignKey(AutomationEvent, on_delete=models.CASCADE, related_name="executions")
    dedup_key = models.CharField(max_length=120)
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.PENDING)
    attempts = models.PositiveSmallIntegerField(default=0)
    max_attempts = models.PositiveSmallIntegerField(default=3)
    next_attempt_at = models.DateTimeField(null=True, blank=True)
    last_error = models.CharField(max_length=500, blank=True)
    result = models.JSONField(default=dict, blank=True)
    started_at = models.DateTimeField(null=True, blank=True)
    finished_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-created_at"]
        constraints = [models.UniqueConstraint(fields=["workspace", "dedup_key"], name="auto_exec_dedup")]
        indexes = [
            models.Index(fields=["workspace", "status", "next_attempt_at"], name="auto_exec_ws_status"),
            models.Index(fields=["rule", "-created_at"], name="auto_exec_rule"),
        ]


class Notification(TenantModel):
    """An in-app notification for one person. Titles and bodies never carry sensitive
    contents (no lending details, no document names, no message text)."""

    recipient = models.ForeignKey(USER, on_delete=models.CASCADE, related_name="+")
    event_type = models.CharField(max_length=40)
    title = models.CharField(max_length=200)
    body = models.CharField(max_length=300, blank=True)
    link = models.CharField(max_length=300, blank=True, help_text="A route in the workspace app, e.g. #/tasks.")
    related_type = models.CharField(max_length=60, blank=True)
    related_id = models.UUIDField(null=True, blank=True)
    group_key = models.CharField(max_length=120, blank=True)
    count = models.PositiveIntegerField(default=1)
    read_at = models.DateTimeField(null=True, blank=True)
    execution = models.ForeignKey(AutomationExecution, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")

    class Meta:
        ordering = ["-updated_at"]
        indexes = [
            models.Index(fields=["workspace", "recipient", "read_at"], name="auto_notif_recipient"),
            models.Index(fields=["workspace", "recipient", "-updated_at"], name="auto_notif_recent"),
        ]


class NotificationPreference(TenantModel):
    """Notification settings of one person (``user`` set) or the workspace default
    (``user`` empty): mute (optionally until a time), grouping, and which events notify."""

    user = models.ForeignKey(USER, null=True, blank=True, on_delete=models.CASCADE, related_name="+")
    muted = models.BooleanField(default=False)
    muted_until = models.DateTimeField(null=True, blank=True)
    grouping = models.BooleanField(default=True)
    events = models.JSONField(default=dict, blank=True, help_text="{event_type: bool}; missing means on.")

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["workspace", "user"], condition=Q(user__isnull=False), name="auto_pref_unique_user"),
            models.UniqueConstraint(fields=["workspace"], condition=Q(user__isnull=True), name="auto_pref_unique_org"),
        ]
