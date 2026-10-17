"""Access policy of MCP connections (registered with apps.crm.access)."""

from __future__ import annotations

from apps.crm.access import VIEW, Cap, Policy, _none


class McpGrantPolicy(Policy):
    """Your own connections to this workspace; owners and admins see and revoke everyone's."""

    def queryset(self, actor, action):
        qs = self.base(actor)
        if actor.view_level == "none":
            return _none(qs)
        if actor.can(Cap.ORG_SETTINGS):
            return qs
        if action in (VIEW, "delete"):
            return qs.filter(user_id=actor.user.pk)
        return _none(qs)
