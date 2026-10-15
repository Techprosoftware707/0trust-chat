from django.core.management.base import BaseCommand, CommandError

from apps.core.auditchain import verify_chain


class Command(BaseCommand):
    help = "Verify the hash chain of the audit log."

    def handle(self, *args, **opts):
        result = verify_chain()
        if not result["ok"]:
            raise CommandError(f"Audit chain broken at event {result['broken_at']}: {result['reason']}")
        self.stdout.write(self.style.SUCCESS(f"Audit chain intact ({result['checked']} events)."))
