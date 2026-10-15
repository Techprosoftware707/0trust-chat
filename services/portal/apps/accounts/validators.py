"""Username rules.

The portal username becomes the Matrix localpart (``@username:server``), which
can never change or be reused once the homeserver has seen it. Rules are a
strict subset of the Matrix localpart grammar.
"""

from __future__ import annotations

import re

from django.core.exceptions import ValidationError

USERNAME_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{1,30}[a-z0-9]$")

RESERVED = {
    "admin", "administrator", "root", "system", "support", "security", "abuse",
    "postmaster", "hostmaster", "webmaster", "noreply", "no-reply", "help",
    "billing", "ops", "operator", "staff", "moderator", "mod", "synapse",
    "matrix", "lumen", "lumen-ops", "lumen-bot", "server", "notices",
    "everyone", "here", "null", "undefined", "api", "www", "app", "status",
}


def validate_username_format(value: str) -> None:
    if value != value.lower():
        raise ValidationError("Use lowercase letters only.", code="username_case")
    if not USERNAME_RE.match(value):
        raise ValidationError(
            "3–32 characters: lowercase letters, digits, '.', '_' or '-', starting and ending with a letter or digit.",
            code="username_format",
        )
    if ".." in value or "__" in value or "--" in value:
        raise ValidationError("Avoid repeated punctuation.", code="username_format")


def validate_username_available(value: str) -> None:
    from .models import RetiredUsername

    if value in RESERVED or value.startswith("_"):
        raise ValidationError("This username is reserved.", code="username_reserved")
    if RetiredUsername.objects.filter(username=value).exists():
        raise ValidationError("This username was used before and cannot be reused.", code="username_retired")


USERNAME_VALIDATORS = [validate_username_format, validate_username_available]
