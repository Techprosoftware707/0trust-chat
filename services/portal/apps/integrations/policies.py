"""Access policies of the integrations models (registered with ``apps.crm.access``).

* Connections: workspace-wide ones (GoHighLevel, Slack) are visible to everyone with record
  access and managed by owners/admins (``Cap.INTEGRATIONS_OWN``); a personal mailbox
  connection is visible to its owner and to owners/admins (status only: never the mail),
  and can be disconnected by either (offboarding).
* Inbox items: personal items (Gmail) only ever to the mailbox owner, not even to admins;
  workspace items (Slack, GoHighLevel) to everyone with record access. Changing an item's
  workspace state (assignee, priority, labels, done) needs ``Cap.ACTIVITIES_CREATE`` (or the
  owner, for personal items).
* Drafts, mutes and pending actions belong to the person who made them.
* External records (GoHighLevel mirror) are read-only for everyone with record access.
"""

from __future__ import annotations

from django.db.models import Q

from apps.crm.access import CHANGE, DELETE, VIEW, Cap, Policy, _none

from . import models as m


class ConnectionPolicy(Policy):
    model = m.IntegrationConnection

    def queryset(self, actor, action):
        qs = self.base(actor)
        if actor.view_level == "none":
            return _none(qs)
        mine = Q(owner_id=actor.user.pk)
        workspace = Q(scope=m.IntegrationConnection.Scope.WORKSPACE)
        if action == VIEW:
            return qs if actor.can(Cap.INTEGRATIONS_OWN) else qs.filter(workspace | mine)
        if action in (CHANGE, DELETE):
            if actor.can(Cap.INTEGRATIONS_OWN):
                return qs
            return qs.filter(mine & Q(scope=m.IntegrationConnection.Scope.PERSONAL))
        raise ValueError(action)


def _item_view_q(actor) -> Q:
    return Q(visibility=m.InboxItem.Visibility.WORKSPACE) | Q(visibility=m.InboxItem.Visibility.PERSONAL, owner_id=actor.user.pk)


class InboxItemPolicy(Policy):
    model = m.InboxItem

    def queryset(self, actor, action):
        qs = self.base(actor).exclude(connection__status=m.IntegrationConnection.Status.DISCONNECTED)
        if actor.view_level == "none":
            return _none(qs)
        if action == VIEW:
            return qs.filter(_item_view_q(actor))
        if action in (CHANGE, DELETE):
            personal = Q(visibility=m.InboxItem.Visibility.PERSONAL, owner_id=actor.user.pk)
            if actor.can(Cap.ACTIVITIES_CREATE) or actor.can(Cap.RECORDS_CHANGE_ALL):
                return qs.filter(_item_view_q(actor))
            return qs.filter(personal)
        raise ValueError(action)


class EmailMessagePolicy(Policy):
    model = m.EmailMessage

    def queryset(self, actor, action):
        qs = self.base(actor)
        if action != VIEW:
            return _none(qs)  # written by sync only
        return qs.filter(item__in=InboxItemPolicy().queryset(actor, VIEW).values("pk"))


class OwnRowsPolicy(Policy):
    """Rows that belong to one person (``user`` or ``created_by``)."""

    def __init__(self, model, field: str):
        self.model = model
        self.field = field

    def queryset(self, actor, action):
        qs = self.base(actor)
        if actor.view_level == "none":
            return _none(qs)
        return qs.filter(**{f"{self.field}_id": actor.user.pk})


class EmailDraftPolicy(Policy):
    model = m.EmailDraft

    def queryset(self, actor, action):
        qs = self.base(actor).filter(created_by_id=actor.user.pk)
        return qs.filter(item__in=InboxItemPolicy().queryset(actor, VIEW).values("pk"))


class InboxLinkPolicy(Policy):
    model = m.InboxLink

    def queryset(self, actor, action):
        qs = self.base(actor)
        if actor.view_level == "none":
            return _none(qs)
        visible_items = InboxItemPolicy().queryset(actor, VIEW).values("pk")
        if action == VIEW:
            # The target end is checked per row (any registered type) by the caller.
            return qs.filter(item__in=visible_items)
        if actor.can(Cap.RECORDS_CHANGE_ALL):
            return qs.filter(item__in=visible_items)
        if actor.can(Cap.ACTIVITIES_CREATE):
            return qs.filter(item__in=visible_items, created_by_id=actor.user.pk)
        return _none(qs)


class ExternalRecordPolicy(Policy):
    model = m.ExternalRecord

    def queryset(self, actor, action):
        qs = self.base(actor).exclude(connection__status=m.IntegrationConnection.Status.DISCONNECTED)
        if action != VIEW or actor.view_level == "none":
            return _none(qs)
        return qs.filter(connection__scope=m.IntegrationConnection.Scope.WORKSPACE)


def register_all() -> None:
    from apps.crm import access

    access.register(m.IntegrationConnection, ConnectionPolicy(), referencable=False)
    access.register(m.InboxItem, InboxItemPolicy())
    access.register(m.EmailMessage, EmailMessagePolicy(), referencable=False)
    access.register(m.EmailDraft, EmailDraftPolicy(), referencable=False)
    access.register(m.InboxLink, InboxLinkPolicy(), referencable=False)
    access.register(m.InboxMute, OwnRowsPolicy(m.InboxMute, "user"), referencable=False)
    access.register(m.PendingAction, OwnRowsPolicy(m.PendingAction, "user"), referencable=False)
    access.register(m.ExternalRecord, ExternalRecordPolicy())
