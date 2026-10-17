"""Access policies of the automation app (registered in ``AutomationConfig.ready``).

* Rules, events and executions: owners, admins and managers (``Cap.AUTOMATION_MANAGE``).
* Notifications: their recipient only. Nobody else, managers included, reads them.
* Notification preferences: a person's own row; the workspace default row is readable by
  every member and changed by owners/admins (checked in ``notifications.update_preferences``).
"""

from __future__ import annotations

from django.db.models import Q

from apps.crm import access
from apps.crm.access import VIEW, Cap, Policy, _none

from . import models as am


class ManagePolicy(Policy):
    def __init__(self, model, *, writable: bool = True):
        self.model = model
        self.writable = writable

    def queryset(self, actor, action):
        qs = self.base(actor)
        if not actor.can(Cap.AUTOMATION_MANAGE) or (action != VIEW and not self.writable):
            return _none(qs)
        return qs


class NotificationPolicy(Policy):
    model = am.Notification

    def queryset(self, actor, action):
        return self.base(actor).filter(recipient_id=actor.user.pk)


class PreferencePolicy(Policy):
    model = am.NotificationPreference

    def queryset(self, actor, action):
        qs = self.base(actor)
        if action == VIEW:
            return qs.filter(Q(user_id=actor.user.pk) | Q(user__isnull=True))
        if actor.can(Cap.ORG_SETTINGS):
            return qs.filter(Q(user_id=actor.user.pk) | Q(user__isnull=True))
        return qs.filter(user_id=actor.user.pk)


def register_all() -> None:
    access.register(am.AutomationRule, ManagePolicy(am.AutomationRule), referencable=False)
    access.register(am.AutomationEvent, ManagePolicy(am.AutomationEvent, writable=False), referencable=False)
    access.register(am.AutomationExecution, ManagePolicy(am.AutomationExecution), referencable=False)
    access.register(am.Notification, NotificationPolicy(), referencable=False)
    access.register(am.NotificationPreference, PreferencePolicy(), referencable=False)
