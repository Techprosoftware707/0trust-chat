"""Running syncs: one at a time per connection (a lease), never raising provider errors
(they become the connection's status), backing off after failures and rate limits, and
retention of synced external content."""

from __future__ import annotations

import logging
from datetime import timedelta

from django.conf import settings
from django.db.models import Q
from django.utils import timezone

from apps.crm.models import ExternalRecordMapping

from . import crypto
from .http import ProviderError, RateLimited, ReauthRequired, ScopeMissing
from .models import EmailDraft, ExternalRecord, InboxItem, IntegrationConnection, OAuthState, PendingAction, Provider, WebhookEvent
from .providers import adapter_for
from .tokens import mark_needs_reauth

log = logging.getLogger("nexus.integrations")
LEASE = timedelta(minutes=5)
DISCONNECTED_RETENTION = timedelta(days=30)


def _acquire(conn: IntegrationConnection) -> bool:
    now = timezone.now()
    return bool(IntegrationConnection.objects.filter(pk=conn.pk).filter(Q(sync_lease_until__isnull=True) | Q(sync_lease_until__lt=now))
                .update(sync_lease_until=now + LEASE))


def _record(conn: IntegrationConnection, **fields) -> None:
    for k, v in fields.items():
        setattr(conn, k, v)
    IntegrationConnection.objects.filter(pk=conn.pk).update(**fields)


def _error_fields(conn, code: str, message: str, *, retry_in: timedelta, count_failure: bool = True, status: str | None = None) -> dict:
    failures = conn.failure_count + (1 if count_failure else 0)
    status = status or (IntegrationConnection.Status.ERROR if failures >= 3 else conn.status)
    return {
        "status": status, "failure_count": failures, "last_error_code": code[:60], "last_error_message": message[:300],
        "last_error_at": timezone.now(), "next_sync_at": timezone.now() + retry_in, "sync_lease_until": None,
    }


def sync_connection(conn: IntegrationConnection, *, budget_pages: int = 4) -> dict:
    """Syncs one connection now. Returns a small, safe summary."""
    if conn.status in {IntegrationConnection.Status.DISCONNECTED, IntegrationConnection.Status.NEEDS_REAUTH}:
        return {"ok": False, "code": conn.status}
    if not _acquire(conn):
        return {"ok": False, "code": "sync_running"}
    adapter = adapter_for(conn.provider)
    try:
        result = adapter.sync(conn, budget_pages=budget_pages)
    except ReauthRequired as exc:
        if conn.status != IntegrationConnection.Status.NEEDS_REAUTH:
            mark_needs_reauth(conn, exc.detail or exc.code)
        _record(conn, sync_lease_until=None, status=IntegrationConnection.Status.NEEDS_REAUTH)
        return {"ok": False, "code": "reauth_required"}
    except RateLimited as exc:
        wait = max(60.0, float(exc.retry_after or 0))
        _record(conn, **_error_fields(conn, "rate_limited", "The provider asked us to slow down; syncing resumes automatically.",
                                      retry_in=timedelta(seconds=min(wait, 6 * 3600)), count_failure=False))
        return {"ok": False, "code": "rate_limited", "retry_after": int(wait)}
    except ScopeMissing as exc:
        _record(conn, **_error_fields(conn, exc.code, exc.message, retry_in=timedelta(hours=6), status=IntegrationConnection.Status.ERROR))
        return {"ok": False, "code": exc.code}
    except ProviderError as exc:
        backoff = timedelta(minutes=min(60, 2 ** min(conn.failure_count + 1, 6)))
        _record(conn, **_error_fields(conn, exc.code, exc.message, retry_in=backoff))
        return {"ok": False, "code": exc.code}
    except (crypto.KeyMissing, crypto.DecryptionFailed):
        _record(conn, **_error_fields(conn, "encryption_key", "The stored credentials can't be decrypted with the configured key. Reconnect or restore it.",
                                      retry_in=timedelta(hours=1), status=IntegrationConnection.Status.ERROR))
        return {"ok": False, "code": "encryption_key"}
    except Exception:
        log.exception("integration sync of %s connection %s failed", conn.provider, conn.pk)
        _record(conn, **_error_fields(conn, "sync_failed", "Syncing failed unexpectedly. We'll retry.", retry_in=timedelta(minutes=15)))
        return {"ok": False, "code": "sync_failed"}
    now = timezone.now()
    interval = timedelta(seconds=settings.NEXUS_INTEGRATIONS_SYNC_SECONDS if result.complete else 30)
    _record(conn, status=IntegrationConnection.Status.CONNECTED, last_sync_at=now, next_sync_at=now + interval, failure_count=0,
            last_error_code="", last_error_message="", last_error_at=None, sync_requested_at=None, sync_lease_until=None)
    return {"ok": True, **result.as_dict()}


def run_due_syncs(limit: int = 20) -> int:
    now = timezone.now()
    due = (IntegrationConnection.objects.filter(status__in=[IntegrationConnection.Status.CONNECTED, IntegrationConnection.Status.ERROR])
           .filter(Q(next_sync_at__lte=now) | Q(next_sync_at__isnull=True)).order_by("next_sync_at")[:limit])
    count = 0
    for conn in due:
        sync_connection(conn)
        count += 1
    return count


def apply_retention() -> dict:
    """Deletes synced external content past its retention period (docs/nexus/INTEGRATIONS.md)."""
    now = timezone.now()
    counts = {}
    for provider, days in [(Provider.GMAIL, settings.NEXUS_GMAIL_RETENTION_DAYS), (Provider.SLACK, settings.NEXUS_SLACK_RETENTION_DAYS),
                           (Provider.GOHIGHLEVEL, settings.NEXUS_GHL_RETENTION_DAYS)]:
        old = InboxItem.objects.filter(source=provider, occurred_at__lt=now - timedelta(days=days))
        counts[f"{provider}_items"] = delete_items(old)
    counts["external_records"] = ExternalRecord.objects.filter(fetched_at__lt=now - timedelta(days=settings.NEXUS_GHL_RETENTION_DAYS)).delete()[0]
    gone = IntegrationConnection.objects.filter(status=IntegrationConnection.Status.DISCONNECTED, disconnected_at__lt=now - DISCONNECTED_RETENTION)
    for conn in gone:
        purge_connection_data(conn)
    counts["oauth_states"] = OAuthState.objects.filter(expires_at__lt=now - timedelta(hours=1)).delete()[0]
    stale = PendingAction.objects.filter(status=PendingAction.Status.PENDING, expires_at__lt=now)
    counts["actions_expired"] = stale.update(status=PendingAction.Status.CANCELED, payload={}, error_code="expired")
    counts["actions_old"] = PendingAction.objects.exclude(status=PendingAction.Status.PENDING).filter(updated_at__lt=now - timedelta(days=30)).delete()[0]
    EmailDraft.objects.exclude(status=EmailDraft.Status.DRAFT).exclude(body="").update(body="")
    counts["webhooks"] = WebhookEvent.objects.filter(received_at__lt=now - timedelta(days=settings.RETENTION["webhook_days"])).delete()[0]
    return counts


def delete_items(qs) -> int:
    ids = list(qs.values_list("pk", flat=True)[:5000])
    if not ids:
        return 0
    ExternalRecordMapping.objects.filter(object_type="integrations.inboxitem", object_id__in=ids).delete()
    return InboxItem.objects.filter(pk__in=ids).delete()[0]


def purge_connection_data(conn: IntegrationConnection) -> dict:
    """Deletes everything synced through ``conn`` (items, messages, mirrors, mappings)."""
    items = InboxItem.objects.filter(connection=conn)
    n_items = 0
    while True:
        batch = delete_items(items)
        n_items += batch
        if not batch:
            break
    ExternalRecordMapping.objects.filter(workspace_id=conn.workspace_id, provider=conn.provider,
                                         external_id__startswith=f"{conn.account_id}:").delete()
    n_records = ExternalRecord.objects.filter(connection=conn).delete()[0]
    return {"items": n_items, "external_records": n_records}
