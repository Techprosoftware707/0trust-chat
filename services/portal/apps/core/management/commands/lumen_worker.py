"""Background worker: health probes, billing lifecycle, deletions, retention, email.

Runs as a single long-lived process. A PostgreSQL advisory lock guarantees
that only one worker instance executes jobs even if the service is scaled.
"""

from __future__ import annotations

import logging
import signal
import time
from datetime import timedelta
from pathlib import Path

from django.conf import settings
from django.core.mail import send_mail
from django.core.management.base import BaseCommand
from django.db import close_old_connections, connection, transaction
from django.utils import timezone

log = logging.getLogger("lumen.worker")

LOCK_ID = 7_400_042


class Job:
    def __init__(self, name, interval, fn):
        self.name, self.interval, self.fn = name, interval, fn
        self.next_run = 0.0


def job_probes_fast():
    from apps.core.models import HealthSnapshot
    from apps.ops.probes import run_probe

    for name in ["website", "ops", "homeserver", "database", "disk", "backups", "billing", "turn", "chat_app"]:
        r = run_probe(name)
        HealthSnapshot.objects.create(component=name, status=r.status, summary=r.summary[:300], detail=r.detail, latency_ms=r.latency_ms)


def job_probes_slow():
    from apps.core.models import HealthSnapshot
    from apps.ops.probes import run_probe

    for name in ["tls", "federation", "email"]:
        r = run_probe(name)
        HealthSnapshot.objects.create(component=name, status=r.status, summary=r.summary[:300], detail=r.detail, latency_ms=r.latency_ms)


def job_billing_lifecycle():
    from apps.billing.services import run_lifecycle

    counters = run_lifecycle()
    if any(counters.values()):
        from apps.core.audit import audit

        audit(None, "billing.lifecycle", metadata=counters)


def job_reconcile_stripe():
    from apps.billing.models import Subscription
    from apps.billing.providers import StripeProvider, get_provider

    provider = get_provider()
    if not isinstance(provider, StripeProvider) or not provider.is_configured():
        return
    from django.db.models import Q

    stale = timezone.now() - timedelta(hours=24)
    due = Subscription.objects.filter(provider="stripe").exclude(provider_subscription_id="").filter(
        Q(last_reconciled_at__isnull=True) | Q(last_reconciled_at__lt=stale)
    )
    for sub in due:
        try:
            provider.reconcile(sub)
        except Exception as exc:  # keep going; recorded in logs only
            log.warning("reconcile %s failed: %s", sub.pk, type(exc).__name__)


def job_account_deletions():
    from apps.accounts.models import AccountStatus, RetiredUsername, User, end_all_sessions
    from apps.core.audit import audit
    from apps.ops.synapse import SynapseAdmin, SynapseError
    from apps.workspaces.models import Membership, Role

    synapse = SynapseAdmin()
    due = User.objects.filter(status=AccountStatus.PENDING_DELETION, deletion_scheduled_for__lte=timezone.now())
    for user in due:
        # 1. Deactivate the Matrix account (erase profile + mark messages for erasure).
        if synapse.configured:
            try:
                if synapse.user(user.matrix_id) is not None:
                    synapse.deactivate(user.matrix_id, erase=True)
            except SynapseError as exc:
                log.warning("deactivation of %s failed (%s); will retry", user.pk, exc)
                continue
        else:
            log.warning("cannot deactivate Matrix account for user %s: no admin token; will retry", user.pk)
            continue
        with transaction.atomic():
            # 2. Workspaces: hand ownership to an admin, else the oldest member, else delete.
            for m in Membership.objects.filter(user=user, role=Role.OWNER).select_related("workspace"):
                others = Membership.objects.filter(workspace=m.workspace).exclude(user=user).order_by("created_at")
                successor = others.filter(role=Role.ADMIN).first() or others.first()
                if successor is None:
                    m.workspace.delete()
                else:
                    successor.role = Role.OWNER
                    successor.save(update_fields=["role"])
            end_all_sessions(user)
            RetiredUsername.objects.get_or_create(username=user.username)
            uid, username = user.pk, user.username
            user.delete()
        audit(None, "account.deleted", target_type="user", target_id=str(uid), metadata={"username_retired": username})


def job_retention():
    from allauth.idp.oidc.models import Token

    from apps.billing.models import WebhookEvent
    from apps.core import ratelimit
    from apps.core.models import AuditEvent, HealthSnapshot, OutboundEmail, SecurityEvent, SupportTicket
    from apps.workspaces.models import Invitation

    now = timezone.now()
    r = settings.RETENTION
    SecurityEvent.objects.filter(at__lt=now - timedelta(days=r["security_events_days"])).delete()
    HealthSnapshot.objects.filter(at__lt=now - timedelta(days=r["health_days"])).delete()
    WebhookEvent.objects.filter(received_at__lt=now - timedelta(days=r["webhook_days"])).delete()
    SupportTicket.objects.filter(status="closed", created_at__lt=now - timedelta(days=r["support_days"])).delete()
    Invitation.objects.filter(expires_at__lt=now - timedelta(days=30)).delete()
    OutboundEmail.objects.filter(sent_at__isnull=False).delete()
    Token.objects.filter(expires_at__lt=now).delete()
    ratelimit.purge_old()
    with transaction.atomic():
        with connection.cursor() as cur:
            cur.execute("SET LOCAL lumen.audit_purge = 'on'")
        AuditEvent.objects.filter(at__lt=now - timedelta(days=r["audit_days"])).delete()
    from django.contrib.sessions.models import Session

    Session.objects.filter(expire_date__lt=now).delete()


def job_outbound_email():
    from apps.core.models import OutboundEmail

    if not settings.EMAIL_ENABLED:
        return
    for msg in OutboundEmail.objects.filter(sent_at__isnull=True, attempts__lt=5).order_by("created_at")[:50]:
        try:
            send_mail(msg.subject, msg.body, settings.DEFAULT_FROM_EMAIL, [msg.to], fail_silently=False)
        except Exception as exc:
            msg.attempts += 1
            msg.last_error = f"{type(exc).__name__}"[:300]
            msg.save(update_fields=["attempts", "last_error"])
        else:
            msg.sent_at = timezone.now()
            msg.body = ""  # do not keep message bodies after delivery
            msg.save(update_fields=["sent_at", "body"])


class Command(BaseCommand):
    help = "Run the Lumen background worker."

    def add_arguments(self, parser):
        parser.add_argument("--once", action="store_true", help="Run every job once and exit")

    def handle(self, *args, **opts):
        self._stop = False
        signal.signal(signal.SIGTERM, self._sigterm)
        signal.signal(signal.SIGINT, self._sigterm)
        jobs = [
            Job("probes_fast", 60, job_probes_fast),
            Job("probes_slow", 900, job_probes_slow),
            Job("outbound_email", 30, job_outbound_email),
            Job("billing_lifecycle", 300, job_billing_lifecycle),
            Job("account_deletions", 600, job_account_deletions),
            Job("reconcile_stripe", 3600, job_reconcile_stripe),
            Job("retention", 3600, job_retention),
        ]
        if opts["once"]:
            for job in jobs:
                self._run(job)
            return
        while not self._stop:
            close_old_connections()
            if not self._acquire_lock():
                time.sleep(15)
                continue
            now = time.monotonic()
            Path("/tmp/worker-heartbeat").touch()  # nosec B108 - container-private tmpfs, health check only
            for job in jobs:
                if self._stop:
                    break
                if now >= job.next_run:
                    self._run(job)
                    job.next_run = time.monotonic() + job.interval
            time.sleep(5)
        self.stdout.write("worker stopped")

    def _sigterm(self, *_):
        self._stop = True

    def _acquire_lock(self) -> bool:
        try:
            with connection.cursor() as cur:
                cur.execute("SELECT pg_try_advisory_lock(%s)", [LOCK_ID])
                return bool(cur.fetchone()[0])
        except Exception:
            connection.close()
            return False

    def _run(self, job: Job):
        start = time.monotonic()
        try:
            job.fn()
        except Exception:
            log.exception("job %s failed", job.name)
        else:
            log.info("job %s finished in %.1fs", job.name, time.monotonic() - start)
