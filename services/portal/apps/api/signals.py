"""Workspace API tokens end with the portal session that created them.

Signing out of the portal, changing or resetting the password, or being suspended ends
every token issued to the first-party SPA client, so a stolen refresh token cannot outlive
the session it came from. (Bearer validation also rejects inactive and suspended users.)
"""

from __future__ import annotations

from allauth.account.signals import password_changed, password_reset
from django.conf import settings
from django.contrib.auth.signals import user_logged_out
from django.dispatch import receiver


def revoke_first_party_tokens(user) -> int:
    from allauth.idp.oidc.models import Token

    if user is None or not getattr(user, "pk", None):
        return 0
    deleted, _ = Token.objects.filter(user=user, client_id__in=settings.NEXUS_API_CLIENT_IDS).delete()
    return deleted


@receiver(user_logged_out)
def _on_logout(sender, request, user, **kwargs):
    revoke_first_party_tokens(user)


@receiver(password_changed)
@receiver(password_reset)
def _on_password(sender, request, user, **kwargs):
    revoke_first_party_tokens(user)
