"""In-app notifications and their preferences.

``notify(...)`` is the one way to notify someone. It honours the recipient's preferences,
falling back to the workspace defaults (``NotificationPreference`` with no user): mute
(optionally until a time), which events notify, and grouping (repeats of the same kind within
``GROUP_WINDOW`` update one notification and count up instead of piling up).

Notifications never carry sensitive contents: no lending details, no document names, no
message text. Only the recipient can read their notifications (managers can't either).
"""

from __future__ import annotations

import datetime as dt

from django.core.exceptions import PermissionDenied
from django.db.models import F as DbF
from django.utils import timezone

from apps.api.errors import ValidationFailed
from apps.api.schema import F, validate
from apps.crm import access
from apps.crm.access import Actor, Cap

from . import models as am
from .models import Trigger

GROUP_WINDOW = dt.timedelta(hours=12)

EVENT_TYPES: dict[str, str] = {
    "assignment": "Something is assigned to you by an automation",
    Trigger.TASK_OVERDUE.value: "Overdue tasks",
    Trigger.APPOINTMENT_UPCOMING.value: "Upcoming appointments",
    Trigger.LEAD_CREATED.value: "New leads",
    Trigger.CONTACT_CREATED.value: "New contacts",
    Trigger.OPPORTUNITY_STAGE_CHANGED.value: "Deal stage changes",
    Trigger.ACTION_ITEM_PROPOSED.value: "Suggested next steps",
}


def _row(workspace_id, user) -> am.NotificationPreference | None:
    return am.NotificationPreference.objects.filter(workspace_id=workspace_id, user=user).first()


def effective_preferences(workspace_id, user) -> dict:
    """The workspace defaults overlaid with the person's own settings."""
    org = _row(workspace_id, None)
    mine = _row(workspace_id, user) if user is not None else None
    events = {k: True for k in EVENT_TYPES}
    for row in (org, mine):
        if row is not None:
            events.update({k: bool(v) for k, v in (row.events or {}).items() if k in EVENT_TYPES})
    now = timezone.now()

    def muted(row):
        return bool(row and (row.muted or (row.muted_until and row.muted_until > now)))

    return {
        "muted": muted(mine) or muted(org),
        "muted_until": mine.muted_until if mine and mine.muted_until and mine.muted_until > now else None,
        "grouping": mine.grouping if mine is not None else (org.grouping if org is not None else True),
        "events": events,
    }


def notify(workspace, recipient, *, event_type: str, title: str, body: str = "", link: str = "", related=None, group_key: str = "",
           execution=None, is_demo: bool = False) -> am.Notification | None:
    """Notifies ``recipient`` unless their preferences say no. Returns the notification
    (new or grouped), or ``None`` when muted or switched off."""
    prefs = effective_preferences(workspace.pk, recipient)
    if prefs["muted"] or not prefs["events"].get(event_type, True):
        return None
    if prefs["grouping"] and group_key:
        existing = (am.Notification.objects.filter(workspace=workspace, recipient=recipient, group_key=group_key, read_at__isnull=True,
                                                   updated_at__gte=timezone.now() - GROUP_WINDOW).order_by("-updated_at").first())
        if existing is not None:
            am.Notification.objects.filter(pk=existing.pk).update(count=DbF("count") + 1, title=title[:200], body=body[:300],
                                                                  link=link[:300], updated_at=timezone.now())
            existing.refresh_from_db()
            return existing
    return am.Notification.objects.create(
        workspace=workspace, recipient=recipient, event_type=event_type, title=title[:200], body=body[:300], link=link[:300],
        related_type=related._meta.label_lower if related is not None else "", related_id=getattr(related, "pk", None),
        group_key=group_key[:120], execution=execution, is_demo=is_demo,
    )


# --- reading and marking (the recipient only) ------------------------------------------------------


def notifications_for(actor: Actor, *, unread_only: bool = False):
    """The actor's own notifications, newest first."""
    qs = access.for_actor(actor, am.Notification)
    if unread_only:
        qs = qs.filter(read_at__isnull=True)
    return qs.order_by("-updated_at", "pk")


def unread_count(actor: Actor) -> int:
    return access.for_actor(actor, am.Notification).filter(read_at__isnull=True).count()


def mark_read(actor: Actor, n: am.Notification, read: bool = True) -> am.Notification:
    n.read_at = timezone.now() if read else None
    n.save(update_fields=["read_at", "updated_at"])
    return n


def mark_all_read(actor: Actor) -> int:
    return access.for_actor(actor, am.Notification).filter(read_at__isnull=True).update(read_at=timezone.now())


# --- preferences ----------------------------------------------------------------------------------------

PREF_SPEC = {
    "muted": F.boolean(),
    "muted_until": F.datetime(null=True),
    "grouping": F.boolean(),
    "events": F.object(max_keys=20),
}


def _clean_events(raw: dict) -> dict:
    bad = [k for k in raw if k not in EVENT_TYPES]
    if bad:
        raise ValidationFailed(fields={"events": [f"Unknown event: {str(bad[0])[:40]}."]})
    if any(not isinstance(v, bool) for v in raw.values()):
        raise ValidationFailed(fields={"events": ["Each event is on (true) or off (false)."]})
    return dict(raw)


def preference_dict(workspace_id, user) -> dict:
    row = _row(workspace_id, user)
    return {
        "scope": "user" if user is not None else "workspace",
        "muted": bool(row and row.muted),
        "muted_until": row.muted_until if row else None,
        "grouping": row.grouping if row else True,
        "events": {k: bool((row.events or {}).get(k, True)) if row else True for k in EVENT_TYPES},
        "event_labels": EVENT_TYPES,
    }


def update_preferences(request, actor: Actor, body: dict, *, workspace_default: bool = False) -> dict:
    """Saves the actor's own preferences, or (owners/admins, ``workspace_default``) the
    workspace defaults."""
    if workspace_default:
        access.require(actor, Cap.ORG_SETTINGS, "Only owners and admins change the workspace's notification defaults.")
    user = None if workspace_default else actor.user
    data = validate(body, PREF_SPEC, partial=True)
    row = _row(actor.workspace_id, user) or am.NotificationPreference(workspace=actor.workspace, user=user, created_by=actor.user)
    if "events" in data:
        merged = dict(row.events or {})
        merged.update(_clean_events(data.pop("events")))
        row.events = merged
    for key in ("muted", "muted_until", "grouping"):
        if key in data:
            setattr(row, key, data[key])
    row.save()
    from apps.core.audit import audit

    audit(request, f"automation.notificationpreference.{'org' if workspace_default else 'user'}", target=row, actor=actor.user,
          metadata={"workspace": str(actor.workspace_id), "fields": sorted(body)})
    return preference_dict(actor.workspace_id, user)


def ensure_can_view_org_defaults(actor: Actor) -> None:
    if actor.view_level == "none":
        raise PermissionDenied()
