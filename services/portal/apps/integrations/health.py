"""Connected-services summary for the Home dashboard (the verticals team's ``connected_services``).

``service_health(actor)`` returns one row per provider, from real connection states only:

* ``connected`` / ``needs_reauth`` / ``error`` — the state of the connection the actor can see
  (their own Gmail mailbox; the workspace's GoHighLevel and Slack connections);
* ``not_connected`` — set up on the server, but nothing connected yet;
* ``not_configured`` — the server lacks the credentials (or the encryption key).

Mock connections and mock mode are flagged (``mock`` / ``mock_label``). Nothing here calls a
provider: ``checked_at`` is the last successful sync (or the last error).
"""

from __future__ import annotations

from apps.crm import access

from . import conf
from .models import IntegrationConnection, Provider

PRIORITY = {IntegrationConnection.Status.NEEDS_REAUTH: 0, IntegrationConnection.Status.ERROR: 1, IntegrationConnection.Status.CONNECTED: 2}
STATUS_LABEL = {
    "connected": "Connected",
    "needs_reauth": "Needs to be reconnected",
    "error": "Error",
    "not_connected": "Not connected",
    "not_configured": "Not set up on this server",
}


def service_health(actor) -> list[dict]:
    rows = []
    visible = list(access.for_actor(actor, IntegrationConnection).exclude(status=IntegrationConnection.Status.DISCONNECTED))
    for provider, spec in conf.SPECS.items():
        conns = [c for c in visible if c.provider == provider and (provider != Provider.GMAIL or c.owner_id == actor.user.pk)]
        conns.sort(key=lambda c: PRIORITY.get(c.status, 9))
        mock = conf.mock_mode()
        if conns:
            c = conns[0]
            status = c.status
            if status == IntegrationConnection.Status.CONNECTED and c.last_error_code:
                detail = c.last_error_message or "Connected; the last sync had a problem."
            elif status == IntegrationConnection.Status.CONNECTED:
                detail = c.account_label
            else:
                detail = c.last_error_message or STATUS_LABEL.get(status, status)
            checked = c.last_error_at if status != IntegrationConnection.Status.CONNECTED else c.last_sync_at
            mock = c.is_mock
        else:
            status = "not_connected" if conf.available_methods(provider) else "not_configured"
            detail = (f"Connect {spec.label} in Integrations." if status == "not_connected"
                      else "An administrator needs to add the credentials first.")
            checked = None
        rows.append({
            "service": provider,
            "label": spec.label,
            "status": status,
            "status_label": STATUS_LABEL.get(status, status),
            "detail": detail[:300],
            "checked_at": checked,
            "link": "#/integrations",
            "mock": bool(mock),
            "mock_label": conf.MOCK_LABEL if mock else None,
        })
    return rows
