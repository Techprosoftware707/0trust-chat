"""manage.py nexus_demo_seed: create the synthetic demo workspace (idempotent).

Refuses unless NEXUS_ENVIRONMENT is development or test. Demo accounts (demo-avery owner,
demo-morgan manager, demo-riley and demo-jordan agents, demo-casey team member, demo-sam
read-only) get the password from --password / NEXUS_DEMO_PASSWORD, or a random one that is
printed once when the accounts are first created.
"""

from __future__ import annotations

import os

from django.core.management.base import BaseCommand, CommandError

from apps.crm.demo import TEAM, DemoRefused, seed


class Command(BaseCommand):
    help = "Create the synthetic Nexus demo workspace (development/test environments only)."

    def add_arguments(self, parser):
        parser.add_argument("--password", help="Password for new demo accounts (default: NEXUS_DEMO_PASSWORD or random).")
        parser.add_argument("--reset-passwords", action="store_true", help="Also set this password on existing demo accounts.")

    def handle(self, *args, **opts):
        password = opts.get("password") or os.environ.get("NEXUS_DEMO_PASSWORD") or None
        try:
            result = seed(password=password, reset_passwords=opts["reset_passwords"])
        except DemoRefused as exc:
            raise CommandError(str(exc)) from None
        ws = result["workspace"]
        self.stdout.write(f"demo workspace: {ws.name} ({ws.pk})")
        n = result["created"]
        self.stdout.write(f"business records: {n} created" if n else "business records: already present (nothing missing)")
        if result["users"]:
            self.stdout.write(f"demo accounts created: {', '.join(result['users'])}")
        if result["password"]:
            self.stdout.write(f"password of the new demo accounts (shown once): {result['password']}")
        self.stdout.write("accounts: " + ", ".join(f"{u} ({r})" for u, _f, _l, _e, r in TEAM))
        self.stdout.write(self.style.SUCCESS("demo seed complete"))
