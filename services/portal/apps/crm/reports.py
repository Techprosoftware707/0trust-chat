"""Reports, aggregated server-side from the records the actor may see (``access.for_actor``):
pipeline by stage, value and owner; this week's team pipeline; activity counts; task
completion; lending checklist status; approaching deadlines.

Only counts and sums leave this module (plus record names for the deadline list): no record
contents, no lending documents. The API requires ``Cap.REPORTS_VIEW`` (owners, admins,
managers); the functions themselves only ever aggregate what the actor can see.
"""

from __future__ import annotations

import datetime as dt
from decimal import Decimal

from django.db.models import Count, Q, Sum
from django.db.models import F as DbF
from django.db.models.functions import TruncDate
from django.utils import timezone

from . import access, realestate
from . import models as m
from .access import Actor, Cap
from .serializers import money, user_ref


def _week_start(now) -> dt.datetime:
    local = timezone.localtime(now)
    start = local - dt.timedelta(days=local.weekday())
    return start.replace(hour=0, minute=0, second=0, microsecond=0)


def _users(ids) -> dict:
    from apps.accounts.models import User

    return {u.pk: u for u in User.objects.filter(pk__in=[i for i in ids if i])}


def pipeline_report(actor: Actor, pipeline: m.Pipeline | None = None) -> dict:
    """Open deals of a pipeline by stage (count, value, probability-weighted value) and by
    owner, plus won/lost totals."""
    if pipeline is None:
        pipeline = access.for_actor(actor, m.Pipeline).filter(archived=False).exclude(kind=m.Pipeline.Kind.LENDING) \
            .order_by("-is_default", "position").first()
    if pipeline is None:
        return {"pipeline": None, "stages": [], "owners": [], "totals": {}}
    opps = access.for_actor(actor, m.Opportunity).filter(pipeline=pipeline)
    stages = list(pipeline.stages.order_by("position", "created_at"))
    agg = {r["stage_id"]: r for r in opps.values("stage_id").annotate(n=Count("pk"), total=Sum("value"))}
    rows = []
    weighted_total = Decimal(0)
    for st in stages:
        a = agg.get(st.pk, {})
        total = a.get("total") or Decimal(0)
        weighted = total * Decimal(st.probability or 0) / 100 if not (st.is_won or st.is_lost) else Decimal(0)
        weighted_total += weighted
        rows.append({"id": str(st.pk), "name": st.name, "is_won": st.is_won, "is_lost": st.is_lost, "probability": st.probability,
                     "count": a.get("n", 0), "value": money(total), "weighted_value": money(weighted)})
    open_ = opps.filter(status=m.Opportunity.Status.OPEN)
    by_owner = list(open_.values("owner_id").annotate(n=Count("pk"), total=Sum("value")).order_by("-total"))
    users = _users(r["owner_id"] for r in by_owner)
    owners = [{"owner": user_ref(users.get(r["owner_id"])), "count": r["n"], "value": money(r["total"] or Decimal(0))} for r in by_owner]
    return {
        "pipeline": {"id": str(pipeline.pk), "name": pipeline.name, "kind": pipeline.kind, "currency": pipeline.currency},
        "stages": rows,
        "owners": owners,
        "totals": {
            "open_count": open_.count(), "open_value": money(open_.aggregate(t=Sum("value"))["t"] or Decimal(0)),
            "weighted_value": money(weighted_total),
            "won_count": opps.filter(status=m.Opportunity.Status.WON).count(),
            "won_value": money(opps.filter(status=m.Opportunity.Status.WON).aggregate(t=Sum("value"))["t"] or Decimal(0)),
            "lost_count": opps.filter(status=m.Opportunity.Status.LOST).count(),
        },
    }


def team_week(actor: Actor, now=None) -> dict:
    """This week (Monday 00:00 local time to now): new deals, stage moves, wins and losses,
    per owner."""
    now = now or timezone.now()
    start = _week_start(now)
    opps = access.for_actor(actor, m.Opportunity)
    new = opps.filter(created_at__gte=start)
    won = opps.filter(status=m.Opportunity.Status.WON, closed_at__gte=start)
    lost = opps.filter(status=m.Opportunity.Status.LOST, closed_at__gte=start)
    moves = access.for_actor(actor, m.StageHistory).filter(created_at__gte=start, from_stage__isnull=False)
    owner_ids = set(new.values_list("owner_id", flat=True)) | set(won.values_list("owner_id", flat=True)) \
        | set(lost.values_list("owner_id", flat=True))
    users = _users(owner_ids)

    def per(qs):
        return {r["owner_id"]: (r["n"], r["total"] or Decimal(0)) for r in qs.values("owner_id").annotate(n=Count("pk"), total=Sum("value"))}

    pn, pw, pl = per(new), per(won), per(lost)
    people = []
    for uid in owner_ids:
        people.append({"owner": user_ref(users.get(uid)), "new": pn.get(uid, (0, 0))[0], "new_value": money(Decimal(pn.get(uid, (0, 0))[1])),
                       "won": pw.get(uid, (0, 0))[0], "won_value": money(Decimal(pw.get(uid, (0, 0))[1])), "lost": pl.get(uid, (0, 0))[0]})
    people.sort(key=lambda r: (-(r["won"] + r["new"]), (r["owner"] or {}).get("name", "")))
    return {
        "week_start": start,
        "generated_at": now,
        "new_count": new.count(), "new_value": money(new.aggregate(t=Sum("value"))["t"] or Decimal(0)),
        "moved_count": moves.count(),
        "won_count": won.count(), "won_value": money(won.aggregate(t=Sum("value"))["t"] or Decimal(0)),
        "lost_count": lost.count(),
        "people": people,
    }


def activity_report(actor: Actor, days: int = 30, now=None) -> dict:
    """Timeline entries of the last ``days`` days by kind, by person and per day."""
    now = now or timezone.now()
    since = now - dt.timedelta(days=days)
    qs = access.for_actor(actor, m.Activity).filter(occurred_at__gte=since, occurred_at__lte=now)
    by_kind = {r["kind"]: r["n"] for r in qs.values("kind").annotate(n=Count("pk"))}
    by_actor = list(qs.exclude(actor__isnull=True).values("actor_id").annotate(n=Count("pk")).order_by("-n")[:20])
    users = _users(r["actor_id"] for r in by_actor)
    per_day = {r["d"]: r["n"] for r in qs.annotate(d=TruncDate("occurred_at")).values("d").annotate(n=Count("pk"))}
    series = []
    for i in range(days, -1, -1):
        d = (now - dt.timedelta(days=i)).date()
        series.append({"date": d, "count": per_day.get(d, 0)})
    return {"days": days, "total": qs.count(), "by_kind": by_kind,
            "by_person": [{"person": user_ref(users.get(r["actor_id"])), "count": r["n"]} for r in by_actor], "per_day": series}


def task_report(actor: Actor, days: int = 30, now=None) -> dict:
    """Task completion over the last ``days`` days, overall and per assignee."""
    now = now or timezone.now()
    since = now - dt.timedelta(days=days)
    tasks = access.for_actor(actor, m.Task)
    open_q = Q(status__in=[m.Task.Status.OPEN, m.Task.Status.IN_PROGRESS])
    created = tasks.filter(created_at__gte=since)
    completed = tasks.filter(status=m.Task.Status.DONE, completed_at__gte=since)
    due_in_period = tasks.filter(due_at__gte=since, due_at__lt=now)
    on_time = due_in_period.filter(status=m.Task.Status.DONE).filter(Q(completed_at__lte=DbF("due_at"))).count()
    rows = list(tasks.filter(open_q | Q(completed_at__gte=since)).exclude(assignee__isnull=True).values("assignee_id").annotate(
        open=Count("pk", filter=open_q),
        overdue=Count("pk", filter=open_q & Q(due_at__lt=now)),
        done=Count("pk", filter=Q(status=m.Task.Status.DONE, completed_at__gte=since)),
    ).order_by("-overdue", "-open"))
    users = _users(r["assignee_id"] for r in rows)
    due_count = due_in_period.count()
    return {
        "days": days,
        "created": created.count(),
        "completed": completed.count(),
        "open": tasks.filter(open_q).count(),
        "overdue": tasks.filter(open_q, due_at__lt=now).count(),
        "due_in_period": due_count,
        "completed_on_time": on_time,
        "on_time_rate": round(100 * on_time / due_count) if due_count else None,
        "by_source": {r["source"]: r["n"] for r in created.values("source").annotate(n=Count("pk"))},
        "people": [{"person": user_ref(users.get(r["assignee_id"])), "open": r["open"], "overdue": r["overdue"], "done": r["done"]}
                   for r in rows[:30]],
    }


def lending_report(actor: Actor) -> dict:
    """Lending applications by stage and document checklist status (counts only). Empty for
    people without lending access."""
    if not actor.can(Cap.LENDING_ACCESS):
        return {"available": False}
    apps_ = access.for_actor(actor, m.LendingApplication).exclude(status__in=["withdrawn", "completed"])
    items = access.for_actor(actor, m.DocumentChecklistItem).filter(application__in=apps_.values("pk"))
    today = timezone.localdate()
    outstanding = items.filter(required=True, status__in=m.DocumentChecklistItem.OUTSTANDING)
    by_stage = list(apps_.values("stage__name", "stage__position").annotate(n=Count("pk"), total=Sum("amount_requested"))
                    .order_by("stage__position"))
    return {
        "available": True,
        "applications": apps_.count(),
        "amount_requested": money(apps_.aggregate(t=Sum("amount_requested"))["t"] or Decimal(0)),
        "by_stage": [{"stage": r["stage__name"], "count": r["n"], "amount": money(r["total"] or Decimal(0))} for r in by_stage],
        "checklist": {s: items.filter(status=s).count() for s in m.DocumentChecklistItem.Status.values},
        "outstanding_required": outstanding.count(),
        "overdue_items": outstanding.filter(due_date__lt=today).count(),
        "applications_missing_documents": apps_.filter(pk__in=outstanding.values("application_id")).count(),
        "awaiting_review": items.filter(status=m.DocumentChecklistItem.Status.RECEIVED).count(),
        "decisions": {d: apps_.filter(decision=d).count() for d in ("approved", "conditional", "declined")},
    }


def deadlines_report(actor: Actor, days: int = 14) -> dict:
    """Open deadlines and milestones due within ``days`` days, overdue first."""
    rows = realestate.approaching_deadlines(actor, days=days, limit=100)
    today = timezone.localdate()
    out = []
    for ms in rows:
        out.append({
            "id": str(ms.pk), "title": ms.title, "category": ms.category, "type": ms.milestone_type, "due_date": ms.due_date,
            "urgency": realestate.milestone_urgency(ms, today),
            "opportunity": {"id": str(ms.opportunity_id), "name": ms.opportunity.name} if ms.opportunity_id else None,
            "application": {"id": str(ms.application_id), "reference": ms.application.reference} if ms.application_id else None,
            "responsible": user_ref(ms.responsible),
        })
    return {"days": days, "count": len(out), "overdue": sum(1 for r in out if r["urgency"] == "overdue"),
            "due_soon": sum(1 for r in out if r["urgency"] == "due_soon"), "items": out}
