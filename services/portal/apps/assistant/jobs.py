"""Background jobs of the AI assistant (run by manage.py lumen_worker)."""

from __future__ import annotations

from datetime import timedelta

from django.utils import timezone


def purge_ai_content() -> int:
    """Drops retained conversation content whose retention period has ended."""
    from .interactions import purge_expired_content

    return purge_expired_content()


def expire_pending_actions() -> int:
    """Marks expired proposals failed and deletes decided ones after 30 days (the audit
    log keeps the record that they existed)."""
    from .models import PendingAction

    now = timezone.now()
    n = PendingAction.objects.filter(status=PendingAction.Status.PENDING, expires_at__lte=now).update(
        status=PendingAction.Status.FAILED, error_code="expired", decided_at=now)
    PendingAction.objects.exclude(status=PendingAction.Status.PENDING).filter(updated_at__lt=now - timedelta(days=30)).delete()
    return n


JOBS = [
    ("purge_ai_content", 3600, purge_ai_content),
    ("expire_pending_actions", 600, expire_pending_actions),
]
