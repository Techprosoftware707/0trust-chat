"""manage.py nexus_demo_reset: delete the synthetic demo records.

Deletes only rows with is_demo=True in workspaces whose business settings are flagged as
demo, never anything else; demo rows that real rows still depend on are kept and reported.
Accounts, memberships and the workspace itself stay (run nexus_demo_seed to refill).
Refuses unless NEXUS_ENVIRONMENT is development or test.
"""

from __future__ import annotations

from django.core.management.base import BaseCommand, CommandError

from apps.crm.demo import DemoRefused, reset


class Command(BaseCommand):
    help = "Delete the synthetic demo records (development/test environments only)."

    def handle(self, *args, **opts):
        try:
            result = reset()
        except DemoRefused as exc:
            raise CommandError(str(exc)) from None
        self.stdout.write(f"demo workspaces: {result['workspaces']}")
        for label, n in sorted(result["deleted"].items()):
            self.stdout.write(f"deleted {n} {label}")
        for label, n in sorted(result["kept"].items()):
            self.stdout.write(self.style.WARNING(f"kept {n} {label} (non-demo records depend on them)"))
        self.stdout.write(self.style.SUCCESS("demo reset complete"))
