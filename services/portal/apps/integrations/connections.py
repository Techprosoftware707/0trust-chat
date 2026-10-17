"""Managing connections: private-token connect, settings, sync now, disconnect.

Ownership and disconnect (docs/nexus/INTEGRATIONS.md, "Ownership and disconnect"):

* Gmail connections are personal: the person who connected owns them; only they see the
  synced mail. They or a workspace owner/admin can disconnect (offboarding).
* GoHighLevel and Slack connections are workspace-wide: connected and disconnected by owners
  and admins (``Cap.INTEGRATIONS_OWN``); the connecting admin is recorded as the owner.
* Disconnect revokes the grant at the provider where the API supports it (Google revoke
  endpoint, Slack ``auth.revoke``, HighLevel uninstall API when configured; a HighLevel
  private token must be deleted in HighLevel), deletes the stored tokens immediately and, by
  default, deletes everything synced through the connection. With ``delete_data=false`` the
  synced items stay visible (read-only, marked disconnected) for 30 days, then the retention
  job deletes them. Entries already linked to CRM timelines are business records and stay.
"""

from __future__ import annotations

from django.core.exceptions import PermissionDenied
from django.db import transaction
from django.utils import timezone

from apps.api.errors import Conflict, ValidationFailed
from apps.api.schema import F, validate
from apps.crm import access
from apps.crm.access import CHANGE, DELETE, Cap

from . import conf, crypto, sync
from .errors import provider_call
from .http import ProviderError
from .models import IntegrationConnection, Provider
from .oauth import FlowError, require_can_connect, save_connection
from .providers import OAuthFailed, adapter_for
from .tokens import TokenSet, delete_tokens


def connect_private_token(request, actor, body: dict) -> IntegrationConnection:
    data = validate(body, {
        "provider": F.choice([Provider.GOHIGHLEVEL], required=True),
        "token": F.string(max_length=2000, required=True, blank=False),
        "location_id": F.string(max_length=120, required=True, blank=False),
    })
    require_can_connect(actor, data["provider"])
    if not crypto.key_configured():
        raise Conflict("The server has no encryption key for integrations yet (NEXUS_INTEGRATIONS_KEY).", code="encryption_key_missing")
    adapter = adapter_for(data["provider"])
    tokens = TokenSet(access_token=data["token"])
    try:
        info = adapter.identify(tokens, {"location_id": data["location_id"]})
    except OAuthFailed as exc:
        raise ValidationFailed(exc.message, fields={"token": [exc.message]}) from None
    except ProviderError as exc:
        raise ValidationFailed(exc.message, fields={"token": [exc.message]}) from None
    info.scopes = []  # chosen in HighLevel when the token was created; not reported by the API
    try:
        return save_connection(request, actor, data["provider"], info, tokens, auth_method=IntegrationConnection.AuthMethod.PRIVATE_TOKEN)
    except FlowError as exc:
        raise Conflict(exc.message, code=exc.code) from None


def update_settings(request, actor, conn: IntegrationConnection, body: dict) -> IntegrationConnection:
    """PATCH settings. Slack: ``channels`` (IDs; the bot must be a member), ``private_channels``
    (needs the optional scopes), ``my_slack_user_id`` (each person, for "mentions me").
    GoHighLevel: ``workflow_triggers_enabled`` (owners/admins)."""
    if conn.provider == Provider.SLACK:
        data = validate(body, {
            "channels": F.list(F.string(max_length=40, blank=False), max_items=50),
            "private_channels": F.boolean(),
            "my_slack_user_id": F.string(max_length=40),
        }, partial=True)
        settings = dict(conn.settings or {})
        changed = []
        if "my_slack_user_id" in data:
            if not access.for_actor(actor, IntegrationConnection).filter(pk=conn.pk).exists():
                raise PermissionDenied()
            value = data["my_slack_user_id"].upper()
            if value and not (value[0] in "UW" and value.isalnum()):
                raise ValidationFailed(fields={"my_slack_user_id": ["A Slack member ID looks like U0123ABCD (Profile → ⋮ → Copy member ID)."]})
            member_map = dict(settings.get("member_map") or {})
            if value:
                member_map[str(actor.user.public_id)] = value
            else:
                member_map.pop(str(actor.user.public_id), None)
            settings["member_map"] = member_map
            changed.append("my_slack_user_id")
        admin_keys = {"channels", "private_channels"} & set(data)
        if admin_keys:
            access.get_for_actor(actor, IntegrationConnection, conn.pk, CHANGE)
            if "private_channels" in data:
                if data["private_channels"] and not {"groups:read", "groups:history"} <= set(conn.granted_scopes or []):
                    raise ValidationFailed(fields={"private_channels": ["Reconnect Slack with private channels allowed first."]})
                settings["private_channels"] = data["private_channels"]
                changed.append("private_channels")
            if "channels" in data:
                with provider_call(conn):
                    available = {c["id"]: c for c in adapter_for(Provider.SLACK).channels(conn)}
                chosen = []
                for cid in data["channels"]:
                    ch = available.get(cid)
                    if ch is None:
                        raise ValidationFailed(fields={"channels": ["Unknown channel, or one the app can't see."]})
                    if not ch["is_member"]:
                        raise ValidationFailed(fields={"channels": [f"Invite the app to #{ch['name']} first (/invite in Slack)."]})
                    if ch["is_private"] and not settings.get("private_channels"):
                        raise ValidationFailed(fields={"channels": ["Private channels need the admin opt-in."]})
                    chosen.append({"id": ch["id"], "name": ch["name"], "is_private": ch["is_private"]})
                removed = {c["id"] for c in settings.get("channels") or []} - {c["id"] for c in chosen}
                settings["channels"] = chosen
                changed.append("channels")
                if removed:
                    from .models import InboxItem

                    sync.delete_items(InboxItem.objects.filter(connection=conn, data__channel__in=list(removed)))
                state = dict(conn.sync_state or {})
                state["backfilled"] = [c for c in state.get("backfilled") or [] if c not in removed]
                conn.sync_state = state
                conn.next_sync_at = timezone.now()
        conn.settings = settings
        conn.save(update_fields=["settings", "sync_state", "next_sync_at", "updated_at"])
        access.audit_write(request, actor, "update", conn, fields=changed)
        return conn
    if conn.provider == Provider.GOHIGHLEVEL:
        data = validate(body, {"workflow_triggers_enabled": F.boolean()}, partial=True)
        access.get_for_actor(actor, IntegrationConnection, conn.pk, CHANGE)
        access.require(actor, Cap.INTEGRATIONS_OWN, "Only owners and admins can change workflow triggers.")
        if "workflow_triggers_enabled" in data:
            conn.settings = {**(conn.settings or {}), "workflow_triggers_enabled": data["workflow_triggers_enabled"]}
            conn.save(update_fields=["settings", "updated_at"])
            access.audit_write(request, actor, "update", conn, fields=["workflow_triggers_enabled"])
        return conn
    validate(body, {})
    return conn


def sync_now(request, actor, conn: IntegrationConnection) -> dict:
    access.get_for_actor(actor, IntegrationConnection, conn.pk, CHANGE)
    if conn.status == IntegrationConnection.Status.NEEDS_REAUTH:
        raise Conflict("Reconnect this integration before syncing.", code="reauth_required")
    if conn.status == IntegrationConnection.Status.DISCONNECTED:
        raise Conflict("This integration is disconnected.", code="disconnected")
    IntegrationConnection.objects.filter(pk=conn.pk).update(sync_requested_at=timezone.now(), failure_count=0)
    conn.failure_count = 0
    outcome = sync.sync_connection(conn, budget_pages=2)
    access.audit_write(request, actor, "sync", conn, extra={"ok": outcome.get("ok", False)})
    return outcome


def disconnect(request, actor, conn: IntegrationConnection, body: dict) -> dict:
    data = validate(body, {"delete_data": F.boolean(default=True)})
    access.get_for_actor(actor, IntegrationConnection, conn.pk, DELETE)
    if conn.status == IntegrationConnection.Status.DISCONNECTED:
        raise Conflict("This integration is already disconnected.", code="disconnected")
    revoked = False
    try:
        revoked = adapter_for(conn.provider).revoke(conn)
    except (ProviderError, crypto.DecryptionFailed, crypto.KeyMissing):
        revoked = False
    with transaction.atomic():
        delete_tokens(conn)
        conn.status = IntegrationConnection.Status.DISCONNECTED
        conn.disconnected_at = timezone.now()
        conn.next_sync_at = None
        conn.sync_lease_until = None
        conn.last_error_code = conn.last_error_message = ""
        conn.save(update_fields=["status", "disconnected_at", "next_sync_at", "sync_lease_until", "last_error_code", "last_error_message", "updated_at"])
        purged = sync.purge_connection_data(conn) if data["delete_data"] else {}
        access.audit_write(request, actor, "disconnect", conn, fields=["status", "tokens"] + (["synced_data"] if purged else []),
                           extra={"provider": conn.provider, "revoked_at_provider": revoked, "deleted_data": data["delete_data"]})
    return {"revoked_at_provider": revoked, "deleted_data": data["delete_data"], **({"deleted": purged} if purged else {}),
            "manual_step": _manual_revoke_step(conn, revoked)}


def _manual_revoke_step(conn: IntegrationConnection, revoked: bool) -> str:
    if revoked:
        return ""
    if conn.provider == Provider.GOHIGHLEVEL:
        if conn.auth_method == IntegrationConnection.AuthMethod.PRIVATE_TOKEN:
            return "Delete or rotate the private integration token in HighLevel (Settings → Private Integrations)."
        return "Uninstall the app from the sub-account in HighLevel to remove its access there too."
    if conn.provider == Provider.GMAIL:
        return "Google didn't confirm the revocation. You can remove the app's access at myaccount.google.com/permissions."
    return "Slack didn't confirm the revocation. You can remove the app in Slack (Apps → Manage)."


def provider_catalog(actor) -> list[dict]:
    from . import serializers as s

    conns = list(access.for_actor(actor, IntegrationConnection).exclude(status=IntegrationConnection.Status.DISCONNECTED)
                 .select_related("owner").order_by("provider", "account_label"))
    out = []
    for pid, spec in conf.SPECS.items():
        methods = conf.available_methods(pid)
        from .oauth import can_connect

        out.append({
            "id": pid,
            "label": spec.label,
            "description": spec.description,
            "scope": spec.scope,
            "configured": bool(methods),
            "oauth_configured": conf.oauth_configured(pid),
            "mock": conf.mock_mode(),
            "mock_label": conf.MOCK_LABEL if conf.mock_mode() else None,
            "mock_refused": conf.mock_refused(),
            "methods": methods,
            "can_connect": can_connect(actor, pid) and bool(methods),
            "scopes": [{"scope": sc, "why": why} for sc, why in spec.scopes] + (
                [{"scope": sc, "why": why, "optional": True} for sc, why in conf.SLACK_PRIVATE_SCOPES] if pid == Provider.SLACK else []),
            "setup": {
                "env": [{"name": e.name, "secret": e.secret, "set": e.is_set, "note": e.note} for e in conf.env_vars(pid)],
                "steps": spec.steps,
                "redirect_uri": conf.redirect_uri(pid),
                "webhook_url": conf.webhook_url(pid),
                "docs_url": spec.docs_url,
            },
            "connections": [s.connection(actor, c) for c in conns if c.provider == pid],
        })
    return out
