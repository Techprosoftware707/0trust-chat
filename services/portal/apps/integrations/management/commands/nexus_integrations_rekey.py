"""manage.py nexus_integrations_rekey: re-encrypt stored provider credentials with the current
key (the first one in NEXUS_INTEGRATIONS_KEY). Key rotation: put the new key first and keep
the old one after it, restart, run this command, then remove the old key
(docs/nexus/CONFIG.md, "Rotating the integrations key"). Prints counts only, never tokens."""

from __future__ import annotations

from django.core.management.base import BaseCommand, CommandError

from apps.integrations import crypto, tokens


class Command(BaseCommand):
    help = "Re-encrypt stored integration credentials with the current NEXUS_INTEGRATIONS_KEY."

    def handle(self, *args, **opts):
        if not crypto.key_configured():
            raise CommandError("NEXUS_INTEGRATIONS_KEY is not configured.")
        result = tokens.rekey_all()
        self.stdout.write(
            f"current key {result['key_id']}: re-encrypted {result['reencrypted']}, "
            f"already current {result['skipped']}, failed {result['failed']}"
        )
        if result["failed"]:
            raise CommandError("Some credentials use a key that is no longer configured; those connections need reconnecting.")
