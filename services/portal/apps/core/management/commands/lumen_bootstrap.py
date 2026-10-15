"""Idempotent post-migration bootstrap.

* seeds plans from config/plans.yml (only codes that do not exist yet)
* registers/updates the homeserver's OIDC client from the environment
* gives every workspace a subscription row
"""

from __future__ import annotations

from allauth.idp.oidc.models import Client
from django.conf import settings
from django.core.management import call_command
from django.core.management.base import BaseCommand, CommandError

from apps.billing.services import ensure_subscription, seed_plans


class Command(BaseCommand):
    help = "Seed plans and register the homeserver OIDC client (idempotent)."

    def handle(self, *args, **opts):
        call_command("createcachetable", verbosity=0)
        created = seed_plans()
        self.stdout.write(f"plans: created {created or 'none'}")
        if settings.SURFACE in {"public", "test"}:
            if not settings.SYNAPSE_OIDC_CLIENT_SECRET:
                raise CommandError("SYNAPSE_OIDC_CLIENT_SECRET is not configured")
            redirect = f"{settings.MATRIX_BASE_URL}/_synapse/client/oidc/callback"
            client, was_created = Client.objects.get_or_create(
                id=settings.SYNAPSE_OIDC_CLIENT_ID,
                defaults={"name": "Lumen homeserver"},
            )
            client.name = "Lumen homeserver"
            if not client.check_secret(settings.SYNAPSE_OIDC_CLIENT_SECRET):
                client.set_secret(settings.SYNAPSE_OIDC_CLIENT_SECRET)  # stored hashed
            client.type = Client.Type.CONFIDENTIAL
            client.scopes = "openid\nprofile\nemail"
            client.default_scopes = "openid\nprofile"
            client.grant_types = Client.GrantType.AUTHORIZATION_CODE
            client.response_types = "code"
            client.set_redirect_uris([redirect])
            client.skip_consent = True  # first-party client; the user signs in to our own homeserver
            client.save()
            self.stdout.write(f"oidc client: {'created' if was_created else 'updated'} ({client.id} -> {redirect})")
        from apps.workspaces.models import Workspace

        for ws in Workspace.objects.filter(subscription__isnull=True):
            ensure_subscription(ws)
        self.stdout.write(self.style.SUCCESS("bootstrap complete"))
