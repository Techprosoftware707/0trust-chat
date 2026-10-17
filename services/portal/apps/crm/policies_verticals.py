"""Access policies of the vertical records (real estate, lending, documents), deal milestones
and meeting notes / action items. Registered with ``apps.crm.access`` in ``CrmConfig.ready``.

The same rules as the foundation's policies apply (ARCHITECTURE.md, section 3): rows of
another workspace never exist for an actor; invisible rows answer 404; child records inherit
the visibility of their parent record.

Lending is stricter than the rest of the CRM: an application and everything under it
(borrowers, checklist, documents, notes, milestones, history) is visible to owners, admins and
managers (``Cap.LENDING_SENSITIVE``) and to the application's assigned broker / loan officer
(``Cap.LENDING_ACCESS``) only. Team members and read-only people never see applications, and
nothing about an application is "shared with the team".
"""

from __future__ import annotations

from django.db.models import Q

from . import access
from . import models as m
from .access import CHANGE, DELETE, VIEW, Actor, Cap, Policy, _none


class OwnedRecordPolicy(Policy):
    """Like contacts: managers see everything; agents their own (owner/creator) plus records
    shared with the team; team members and read-only people the shared ones."""

    def __init__(self, model, owner_field: str = "owner"):
        self.model = model
        self.owner_field = owner_field

    def _mine(self, actor: Actor) -> Q:
        return Q(**{f"{self.owner_field}_id": actor.user.pk})

    def queryset(self, actor, action):
        qs = self.base(actor)
        level = actor.view_level
        if action == VIEW:
            if level == "all":
                return qs
            if level == "scoped":
                return qs.filter(Q(visibility=m.Visibility.TEAM) | self._mine(actor) | Q(created_by_id=actor.user.pk))
            if level == "team":
                return qs.filter(visibility=m.Visibility.TEAM)
            return _none(qs)
        if action == CHANGE:
            if actor.can(Cap.RECORDS_CHANGE_ALL):
                return qs
            if actor.can(Cap.RECORDS_CHANGE_OWN):
                return qs.filter(self._mine(actor) | Q(created_by_id=actor.user.pk))
            return _none(qs)
        if action == DELETE:
            if actor.can(Cap.RECORDS_DELETE_ALL):
                return qs
            if actor.can(Cap.RECORDS_DELETE_OWN):
                return qs.filter(self._mine(actor))
            return _none(qs)
        raise ValueError(action)


class ChildPolicy(Policy):
    """Rows that belong to one or more parent records: visible when every parent is visible,
    changeable/deletable when the ``owner_parent`` is changeable."""

    def __init__(self, model, parents: dict[str, type], owner_parent: str):
        self.model = model
        self.parents = parents
        self.owner_parent = owner_parent

    def queryset(self, actor, action):
        qs = self.base(actor)
        if action == VIEW:
            for fname, pmodel in self.parents.items():
                qs = qs.filter(**{f"{fname}__in": access.for_actor(actor, pmodel, VIEW).values("pk")})
            return qs
        pmodel = self.parents[self.owner_parent]
        for fname, other in self.parents.items():
            if fname != self.owner_parent:
                qs = qs.filter(**{f"{fname}__in": access.for_actor(actor, other, VIEW).values("pk")})
        return qs.filter(**{f"{self.owner_parent}__in": access.for_actor(actor, pmodel, CHANGE).values("pk")})


class ClientPreferencePolicy(ChildPolicy):
    def __init__(self):
        super().__init__(m.ClientPreference, {"contact": m.Contact}, "contact")


class MilestonePolicy(Policy):
    """Milestones of a deal follow the deal; milestones of a lending application follow the
    (sensitive) application."""

    model = m.Milestone

    def queryset(self, actor, action):
        qs = self.base(actor)
        act = VIEW if action == VIEW else CHANGE
        opps = access.for_actor(actor, m.Opportunity, act).values("pk")
        apps_ = access.for_actor(actor, m.LendingApplication, act).values("pk")
        return qs.filter(Q(opportunity__in=opps) | Q(application__in=apps_))


class LendingApplicationPolicy(Policy):
    model = m.LendingApplication

    def queryset(self, actor, action):
        qs = self.base(actor)
        if actor.can(Cap.LENDING_SENSITIVE):
            if action == DELETE and not actor.can(Cap.RECORDS_DELETE_ALL):
                return _none(qs)
            return qs
        if actor.can(Cap.LENDING_ACCESS) and action in (VIEW, CHANGE):
            # The assigned broker / loan officer only: being the creator is not enough.
            return qs.filter(loan_officer_id=actor.user.pk)
        return _none(qs)


class ApplicationChildPolicy(Policy):
    """Everything under an application: visible/changeable exactly when the application is."""

    def __init__(self, model, field: str = "application", *, writable: bool = True):
        self.model = model
        self.field = field
        self.writable = writable

    def queryset(self, actor, action):
        qs = self.base(actor)
        if action != VIEW and not self.writable:
            return _none(qs)
        act = VIEW if action == VIEW else CHANGE
        return qs.filter(**{f"{self.field}__in": access.for_actor(actor, m.LendingApplication, act).values("pk")})


class ApplicationNotePolicy(Policy):
    model = m.ApplicationNote

    def queryset(self, actor, action):
        qs = self.base(actor).filter(application__in=access.for_actor(actor, m.LendingApplication, VIEW).values("pk"))
        managers = actor.can(Cap.LENDING_SENSITIVE)
        if action == VIEW:
            if managers:
                return qs
            V = m.ApplicationNote.Visibility
            return qs.filter(Q(visibility=V.STAFF) | Q(visibility=V.PRIVATE, created_by_id=actor.user.pk))
        # Notes are changed or deleted by their author (or managers).
        return qs if managers else qs.filter(created_by_id=actor.user.pk)


class DocumentAccessLogPolicy(Policy):
    """The document access log: managers (owner, admin, manager) only."""

    model = m.DocumentAccessLog

    def queryset(self, actor, action):
        qs = self.base(actor)
        if action == VIEW and actor.can(Cap.LENDING_SENSITIVE):
            return qs
        return _none(qs)  # written by the server only


class ChecklistTemplatePolicy(Policy):
    model = m.ChecklistTemplate

    def queryset(self, actor, action):
        qs = self.base(actor)
        if action == VIEW:
            return qs if actor.can(Cap.LENDING_ACCESS) else _none(qs)
        return qs if actor.can(Cap.CRM_CONFIGURE) else _none(qs)


class MeetingNotePolicy(Policy):
    model = m.MeetingNote

    def queryset(self, actor, action):
        qs = self.base(actor)
        u = actor.user.pk
        if action == VIEW:
            if actor.view_level == "all":
                return qs
            if actor.view_level == "none":
                return _none(qs)
            V = m.MeetingNote.Visibility
            parents = access._parents_visible(actor) & (
                Q(event__isnull=True) | Q(event__in=access.for_actor(actor, m.CalendarEvent, VIEW).values("pk"))
            )
            attending = m.CalendarEvent.attendee_users.through.objects.filter(user_id=u).values("calendarevent_id")
            at_meeting = Q(event__organizer_id=u) | Q(event__in=attending)
            return qs.filter(
                Q(created_by_id=u) | (Q(visibility=V.TEAM) & parents) | (Q(visibility=V.ATTENDEES) & parents & at_meeting)
            )
        if actor.can(Cap.RECORDS_CHANGE_ALL):
            return qs
        if actor.can(Cap.EVENTS_CREATE):
            return qs.filter(created_by_id=u)
        return _none(qs)


class ActionItemPolicy(Policy):
    model = m.ActionItem

    def queryset(self, actor, action):
        qs = self.base(actor)
        u = actor.user.pk
        if action == VIEW:
            if actor.view_level == "all":
                return qs
            if actor.view_level == "none":
                return _none(qs)
            notes = access.for_actor(actor, m.MeetingNote, VIEW).values("pk")
            events = access.for_actor(actor, m.CalendarEvent, VIEW).values("pk")
            parents = (
                access._parents_visible(actor)
                & (Q(note__isnull=True) | Q(note__in=notes))
                & (Q(event__isnull=True) | Q(event__in=events))
            )
            return qs.filter(parents | Q(created_by_id=u) | Q(suggested_assignee_id=u))
        if actor.can(Cap.RECORDS_CHANGE_ALL):
            return qs
        if actor.can(Cap.TASKS_CREATE) or actor.can(Cap.TASKS_CREATE_OWN):
            return qs.filter(Q(created_by_id=u) | Q(suggested_assignee_id=u))
        return _none(qs)


def register_all() -> None:
    access.register(m.Property, OwnedRecordPolicy(m.Property))
    access.register(m.LendingApplication, LendingApplicationPolicy())
    access.register(m.Milestone, MilestonePolicy())
    access.register(m.MeetingNote, MeetingNotePolicy())
    access.register(m.ActionItem, ActionItemPolicy())
    access.register(m.SecureDocument, ApplicationChildPolicy(m.SecureDocument))
    access.register(m.DocumentChecklistItem, ApplicationChildPolicy(m.DocumentChecklistItem))
    for model, policy in [
        (m.PropertyContact, ChildPolicy(m.PropertyContact, {"property": m.Property, "contact": m.Contact}, "property")),
        (m.OpportunityProperty, ChildPolicy(m.OpportunityProperty, {"opportunity": m.Opportunity, "property": m.Property}, "opportunity")),
        (m.ClientPreference, ClientPreferencePolicy()),
        (m.ApplicationBorrower, ApplicationChildPolicy(m.ApplicationBorrower)),
        (m.LendingStageHistory, ApplicationChildPolicy(m.LendingStageHistory, writable=False)),
        (m.ApplicationNote, ApplicationNotePolicy()),
        (m.DocumentDownloadGrant, ApplicationChildPolicy(m.DocumentDownloadGrant, "document__application", writable=False)),
        (m.DocumentAccessLog, DocumentAccessLogPolicy()),
        (m.ChecklistTemplate, ChecklistTemplatePolicy()),
    ]:
        access.register(model, policy, referencable=False)
