"""Extra Home dashboard sections (verticals team): today's meetings, approaching deadlines,
lending applications missing documents, suggested next steps waiting for review, and the
connected-service health slot.

Connected-service health is an EXTENSION POINT, not data of its own: any Nexus app may ship
``health.py`` with ``def service_health(actor) -> list[dict]`` returning, for what *this
actor* may know about, items of the shape the integrations team's provider uses
(``apps/integrations/health.py``): ``{"service", "label", "status" (connected | needs_reauth |
error | not_connected | not_configured), "status_label", "detail", "checked_at", "link",
"mock", "mock_label"}``. Providers must not call the network (stored states only). Home shows
the items (with the mock label when ``mock``), or nothing when no app provides the hook.
Never invent a status.
"""

from __future__ import annotations

import datetime as dt
import logging

from django.db.models import Q
from django.utils import timezone

from apps.core.extensions import nexus_modules

from . import access, lending, realestate
from . import models as m
from . import serializers as s
from . import serializers_verticals as sv
from .access import Actor, Cap

log = logging.getLogger("nexus.home")


def connected_services(actor: Actor) -> list[dict] | None:
    """Items from every app's ``health.service_health(actor)``; ``None`` if no app provides
    the hook (the UI then shows nothing)."""
    providers = [mod for _app, mod in nexus_modules("health") if hasattr(mod, "service_health")]
    if not providers:
        return None
    items: list[dict] = []
    for mod in providers:
        try:
            items.extend(mod.service_health(actor) or [])
        except Exception:  # a broken provider must not break Home
            log.exception("service_health provider %s failed", mod.__name__)
    return items


def home_extras(actor: Actor, ctx: s.Ctx, *, team: bool, now=None) -> dict:
    now = now or timezone.now()
    local = timezone.localtime(now)
    start = local.replace(hour=0, minute=0, second=0, microsecond=0)
    events = access.for_actor(actor, m.CalendarEvent).filter(start_at__lt=start + dt.timedelta(days=1), end_at__gte=start,
                                                             status=m.CalendarEvent.Status.SCHEDULED)
    if not team:
        attending = m.CalendarEvent.attendee_users.through.objects.filter(user_id=actor.user.pk).values("calendarevent_id")
        events = events.filter(Q(organizer=actor.user) | Q(pk__in=attending))
    todays = list(s.event_queryset(events.order_by("start_at"))[:12])
    s.prepare_events(ctx, todays)
    today = timezone.localdate()
    deadlines = realestate.approaching_deadlines(actor, days=7, limit=10)
    missing = None
    if actor.features.get("lending") and actor.can(Cap.LENDING_ACCESS):
        missing = lending.applications_missing_documents(actor, limit=8)
    proposals = access.for_actor(actor, m.ActionItem).filter(status=m.ActionItem.Status.PROPOSED)
    if not team:
        proposals = proposals.filter(Q(suggested_assignee=actor.user) | Q(created_by=actor.user) | Q(suggested_assignee__isnull=True))
    return {
        "meetings_today": [s.event(ctx, e) for e in todays],
        "approaching_deadlines": [sv.milestone_json(ctx, ms, today) for ms in deadlines],
        "applications_missing_documents": missing,
        "suggested_next_steps": proposals.count(),
        "connected_services": connected_services(actor),
    }
