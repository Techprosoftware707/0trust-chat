"""Record security events from authentication signals."""

from __future__ import annotations

from allauth.account import signals as account_signals
from allauth.mfa import signals as mfa_signals
from django.contrib.auth import get_user_model
from django.contrib.auth.signals import user_logged_out, user_login_failed
from django.dispatch import receiver

from apps.core.audit import audit, security_event


@receiver(account_signals.user_logged_in)
def on_login(sender, request, user, **kwargs):
    security_event(request, "login_success", user=user)


@receiver(user_logged_out)
def on_logout(sender, request, user, **kwargs):
    if user is not None and request is not None:
        security_event(request, "logout", user=user)


@receiver(user_login_failed)
def on_login_failed(sender, credentials, request=None, **kwargs):
    identifier = (credentials or {}).get("username") or (credentials or {}).get("email") or ""
    User = get_user_model()
    user = None
    if identifier:
        user = User.objects.filter(username=identifier.lower()).first() or User.objects.filter(email__iexact=identifier).first()
    security_event(request, "login_failed", user=user, detail={"known_account": user is not None})


@receiver(account_signals.user_signed_up)
def on_signup(sender, request, user, **kwargs):
    audit(request, "account.signup", target=user, actor=user)


@receiver(account_signals.password_changed)
def on_password_changed(sender, request, user, **kwargs):
    security_event(request, "password_changed", user=user)


@receiver(account_signals.password_reset)
def on_password_reset(sender, request, user, **kwargs):
    security_event(request, "password_reset", user=user)


@receiver(account_signals.email_changed)
def on_email_changed(sender, request, user, **kwargs):
    security_event(request, "email_changed", user=user)


@receiver(mfa_signals.authenticator_added)
def on_mfa_added(sender, request, user, authenticator, **kwargs):
    security_event(request, "mfa_enabled", user=user, detail={"type": authenticator.type})


@receiver(mfa_signals.authenticator_removed)
def on_mfa_removed(sender, request, user, authenticator, **kwargs):
    security_event(request, "mfa_disabled", user=user, detail={"type": authenticator.type})


@receiver(mfa_signals.authentication_failed)
def on_mfa_failed(sender, request, user, **kwargs):
    security_event(request, "mfa_failed", user=user)
