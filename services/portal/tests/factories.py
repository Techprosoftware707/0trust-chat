from __future__ import annotations

import itertools

from allauth.account.models import EmailAddress
from allauth.mfa.totp.internal.auth import TOTP, generate_totp_secret
from django.test import Client

from apps.accounts.models import User
from apps.billing.services import seed_plans

_seq = itertools.count(1)
PASSWORD = "correct horse battery staple 42"


def make_user(username=None, *, email=None, staff_role="", mfa=False, password=PASSWORD, **extra) -> User:
    n = next(_seq)
    username = username or f"user{n}"
    user = User(username=username, email=email or f"{username}@example.org", staff_role=staff_role, **extra)
    user.set_password(password)
    user.save()
    EmailAddress.objects.create(user=user, email=user.email, verified=True, primary=True)
    if mfa:
        TOTP.activate(user, generate_totp_secret())
    return user


def ensure_plans():
    seed_plans()


def ops_client(user=None) -> Client:
    c = Client(HTTP_X_LUMEN_GATEWAY="test-gateway")
    if user is not None:
        c.force_login(user)
    return c


def mark_recent_auth(client: Client) -> None:
    """Satisfy allauth's step-up (re-authentication) requirement."""
    import time

    session = client.session
    session["account_authentication_methods"] = [{"method": "password", "at": time.time(), "username": "x"}]
    session.save()
