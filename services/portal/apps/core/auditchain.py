"""Verification of the hash-chained audit log."""

from __future__ import annotations

from .models import AuditEvent


def verify_chain(limit: int | None = None) -> dict:
    """Recompute hashes oldest-first. Retention purges drop the oldest rows, so
    the first remaining row's ``prev_hash`` is taken as the anchor."""
    qs = AuditEvent.objects.order_by("id")
    if limit:
        qs = qs[:limit]
    prev = None
    checked = 0
    for ev in qs.iterator():
        if prev is not None and ev.prev_hash != prev:
            return {"ok": False, "checked": checked, "broken_at": ev.pk, "reason": "prev_hash mismatch"}
        if ev.compute_hash() != ev.hash:
            return {"ok": False, "checked": checked, "broken_at": ev.pk, "reason": "content hash mismatch"}
        prev = ev.hash
        checked += 1
    return {"ok": True, "checked": checked, "broken_at": None, "reason": ""}
