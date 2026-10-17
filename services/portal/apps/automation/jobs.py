"""Background jobs run by the worker (manage.py lumen_worker):
JOBS = [("name", interval_seconds, callable)]. Jobs are idempotent and scope every query to
one workspace at a time.

* ``overdue_tasks``: open tasks that passed their due time in the last day announce
  ``task.overdue`` once per (task, due time);
* ``appointment_reminders``: scheduled events starting within ``NEXUS_AUTOMATION_REMINDER_MINUTES``
  announce ``appointment.upcoming`` once per (event, start time);
* ``retries``: failed executions whose backoff has passed run again;
* ``retention``: old events, executions and read notifications are deleted after
  ``NEXUS_AUTOMATION_RETENTION_DAYS``.

Only workspaces with an enabled rule for the trigger are scanned.
"""

from __future__ import annotations

import datetime as dt

from django.conf import settings
from django.utils import timezone

from apps.crm import models as crm

from . import engine
from . import models as am
from .models import Trigger


def _workspaces_with(trigger: str) -> list:
    return list(am.AutomationRule.objects.filter(trigger=trigger, enabled=True).values_list("workspace_id", flat=True).distinct())


def scan_overdue_tasks(now=None) -> int:
    now = now or timezone.now()
    emitted = 0
    for ws_id in _workspaces_with(Trigger.TASK_OVERDUE):
        tasks = crm.Task.objects.filter(workspace_id=ws_id, status__in=[crm.Task.Status.OPEN, crm.Task.Status.IN_PROGRESS],
                                        due_at__lt=now, due_at__gte=now - dt.timedelta(days=1))
        for t in tasks.select_related("contact", "opportunity")[:500]:
            engine.record_and_dispatch(ws_id, Trigger.TASK_OVERDUE, subject_type="crm.task", subject_id=t.pk,
                                       dedup_key=f"{t.pk}:{t.due_at.isoformat()}", payload=engine.task_facts(t))
            emitted += 1
    return emitted


def reminder_minutes() -> int:
    return int(getattr(settings, "NEXUS_AUTOMATION_REMINDER_MINUTES", 60))


def scan_upcoming_appointments(now=None) -> int:
    now = now or timezone.now()
    emitted = 0
    for ws_id in _workspaces_with(Trigger.APPOINTMENT_UPCOMING):
        events = crm.CalendarEvent.objects.filter(workspace_id=ws_id, status=crm.CalendarEvent.Status.SCHEDULED, start_at__gt=now,
                                                  start_at__lte=now + dt.timedelta(minutes=reminder_minutes()))
        for e in events[:500]:
            engine.record_and_dispatch(ws_id, Trigger.APPOINTMENT_UPCOMING, subject_type="crm.calendarevent", subject_id=e.pk,
                                       dedup_key=f"{e.pk}:{e.start_at.isoformat()}", payload=engine.event_facts(e))
            emitted += 1
    return emitted


def run_retries(now=None) -> int:
    return engine.run_due_retries(now)


def retention(now=None) -> dict:
    now = now or timezone.now()
    days = int(getattr(settings, "NEXUS_AUTOMATION_RETENTION_DAYS", 90))
    cutoff = now - dt.timedelta(days=days)
    S = am.AutomationExecution.Status
    out = {
        "executions": am.AutomationExecution.objects.filter(created_at__lt=cutoff).exclude(status__in=[S.RETRYING, S.PENDING]).delete()[0],
        "notifications": am.Notification.objects.filter(read_at__isnull=False, read_at__lt=cutoff).delete()[0],
    }
    out["events"] = am.AutomationEvent.objects.filter(created_at__lt=cutoff, executions__isnull=True).delete()[0]
    # Download grants are single-use and short-lived: drop the expired ones.
    out["download_grants"] = crm.DocumentDownloadGrant.objects.filter(expires_at__lt=now - dt.timedelta(days=1)).delete()[0]
    return out


JOBS: list = [
    ("overdue_tasks", 300, scan_overdue_tasks),
    ("appointment_reminders", 300, scan_upcoming_appointments),
    ("retries", 60, run_retries),
    ("retention", 3600, retention),
]
