"""manage.py nexus_automation_scan: run the automation scans once (overdue tasks, upcoming
appointments, due retries). The worker runs them on a schedule; this is for development and
test environments that don't run the worker."""

from __future__ import annotations

from django.core.management.base import BaseCommand

from apps.automation import jobs


class Command(BaseCommand):
    help = "Run the automation scans (overdue tasks, upcoming appointments, retries) once."

    def handle(self, *args, **opts):
        self.stdout.write(f"overdue tasks announced: {jobs.scan_overdue_tasks()}")
        self.stdout.write(f"upcoming appointments announced: {jobs.scan_upcoming_appointments()}")
        self.stdout.write(f"retries run: {jobs.run_retries()}")
