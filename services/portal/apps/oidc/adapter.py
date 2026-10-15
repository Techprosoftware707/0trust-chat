from __future__ import annotations

from allauth.idp.oidc.adapter import DefaultOIDCAdapter
from django.conf import settings
from django.contrib.auth import get_user_model
from django.core.exceptions import ValidationError


class LumenOIDCAdapter(DefaultOIDCAdapter):
    """OIDC provider adapter used by the homeserver's SSO login.

    * ``iss`` is the public portal origin regardless of how the request
      arrived.
    * ``sub`` is the user's random ``public_id`` (stable, not enumerable).
    * ``preferred_username`` is the immutable Matrix localpart.
    """

    def get_issuer(self) -> str:
        return settings.PUBLIC_BASE_URL.rstrip("/")

    def get_user_sub(self, client, user) -> str:
        return str(user.public_id)

    def get_user_by_sub(self, client, sub: str):
        User = get_user_model()
        try:
            return User.objects.get(public_id=sub)
        except (User.DoesNotExist, ValueError, ValidationError):
            return None

    def get_claims(self, purpose, user, client, scopes, email=None, **kwargs):
        claims = super().get_claims(purpose, user, client, scopes, email=email, **kwargs)
        if "profile" in scopes:
            claims["preferred_username"] = user.username
            claims["name"] = user.display_name or user.username
        return claims
