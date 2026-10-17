"""Access policies of the assistant's tenant models (registered with apps.crm.access)."""

from __future__ import annotations

from apps.crm.access import VIEW, Cap, Policy, _none


class PendingActionPolicy(Policy):
    """A proposal belongs to the person it was prepared for: nobody else sees or decides it."""

    def queryset(self, actor, action):
        qs = self.base(actor)
        if actor.view_level == "none":
            return _none(qs)
        return qs.filter(created_by_id=actor.user.pk)


class AIInteractionPolicy(Policy):
    """The AI audit log: your own entries; owners and admins see everyone's (metadata)."""

    def queryset(self, actor, action):
        qs = self.base(actor)
        if action != VIEW:
            return _none(qs)  # written by the server only
        if actor.can(Cap.ORG_SETTINGS):
            return qs
        return qs.filter(created_by_id=actor.user.pk)
