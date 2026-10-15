"""Create (or promote) an operator account and issue a one-time setup link.

There are no default credentials: the operator chooses a password through the
one-time link (valid 1 hour) and must then enrol MFA before using the console.
The link is written only to stdout or to a root-only file, never to logs.
"""

from __future__ import annotations

import os
import secrets
from datetime import timedelta
from pathlib import Path

from allauth.account.models import EmailAddress
from django.conf import settings
from django.contrib.auth import get_user_model
from django.core.exceptions import ValidationError
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from django.utils import timezone

from apps.accounts.models import OperatorSetupToken, StaffRole
from apps.accounts.validators import validate_username_format
from apps.core.audit import audit
from apps.workspaces.models import hash_token


class Command(BaseCommand):
    help = "Create an operator account (or promote an existing one) and print a one-time setup link."

    def add_arguments(self, parser):
        parser.add_argument("--username", required=True)
        parser.add_argument("--email", required=True)
        parser.add_argument("--role", default=StaffRole.OWNER, choices=[c for c, _ in StaffRole.choices if c])
        parser.add_argument("--link-file", help="Write the setup link to this file (mode 0600) instead of stdout")
        parser.add_argument("--hours", type=int, default=1)
        parser.add_argument("--base-url", default="", help="Base URL for the link (defaults to the public site)")

    @transaction.atomic
    def handle(self, *args, **o):
        User = get_user_model()
        username = o["username"].strip().lower()
        try:
            validate_username_format(username)
        except ValidationError as exc:
            raise CommandError("; ".join(exc.messages)) from exc
        user = User.objects.filter(username=username).first()
        if user is None:
            if User.objects.filter(email__iexact=o["email"]).exists():
                raise CommandError("That email belongs to another account.")
            user = User(username=username, email=o["email"].lower(), display_name=username)
            user.set_unusable_password()
            created = True
        else:
            created = False
        user.staff_role = o["role"]
        user.save()
        EmailAddress.objects.update_or_create(
            user=user, email=user.email, defaults={"verified": True, "primary": True}
        )
        token = secrets.token_urlsafe(32)
        OperatorSetupToken.objects.create(
            user=user,
            token_hash=hash_token(token),
            purpose="setup",
            expires_at=timezone.now() + timedelta(hours=max(1, min(o["hours"], 48))),
        )
        audit(None, "operator.created" if created else "operator.setup_link", target=user, metadata={"role": user.staff_role, "via": "cli"})
        base = (o["base_url"] or settings.PUBLIC_BASE_URL).rstrip("/")
        link = f"{base}/setup/{token}/"
        if o["link_file"]:
            path = Path(o["link_file"])
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w") as fh:
                fh.write(link + "\n")
            self.stdout.write(f"{'Created' if created else 'Updated'} operator {username}; setup link written to {path}")
        else:
            self.stdout.write(link)
