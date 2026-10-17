"""Background jobs run by the worker (manage.py lumen_worker):
JOBS = [("name", interval_seconds, callable)]. Jobs are idempotent and each sync handles one
connection (one workspace) at a time."""

from __future__ import annotations


def job_sync():
    from .sync import run_due_syncs

    run_due_syncs()


def job_retention():
    from .sync import apply_retention

    apply_retention()


JOBS: list = [
    ("sync", 60, job_sync),
    ("retention", 3600, job_retention),
]
