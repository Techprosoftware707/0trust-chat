from __future__ import annotations

import logging

from allauth.account.adapter import DefaultAccountAdapter
from allauth.mfa.adapter import DefaultMFAAdapter
from django.conf import settings
from django.contrib import messages
from django.shortcuts import redirect
from django.urls import reverse

from apps.core import runtime

from .models import AccountStatus

log = logging.getLogger(__name__)

INVITE_SESSION_KEY = "lumen_invite_token"


class AccountAdapter(DefaultAccountAdapter):
    def is_open_for_signup(self, request) -> bool:
        if settings.SURFACE == "ops":
            return False
        try:
            if runtime.get("maintenance_mode"):
                return False
            mode = runtime.registration_mode()
        except Exception:
            mode = settings.REGISTRATION_MODE
        if mode == "open":
            return True
        if mode == "invite":
            from apps.workspaces.models import Invitation

            token = request.session.get(INVITE_SESSION_KEY)
            return bool(token) and Invitation.objects.valid_for_token(token) is not None
        return False

    def clean_username(self, username: str, shallow: bool = False) -> str:
        return super().clean_username(username.lower(), shallow=shallow)

    def save_user(self, request, user, form, commit=True):
        user = super().save_user(request, user, form, commit=False)
        user.display_name = (form.cleaned_data.get("display_name") or "").strip()[:80]
        if commit:
            user.save()
        return user

    def pre_login(self, request, user, **kwargs):
        if getattr(user, "status", AccountStatus.ACTIVE) in {AccountStatus.SUSPENDED, AccountStatus.DELETED}:
            from apps.core.audit import security_event

            security_event(request, "login_failed", user=user, detail={"reason": "account_" + user.status})
            messages.error(request, "This account is not active. Contact support if you think this is a mistake.")
            return redirect(reverse("account_login"))
        if settings.SURFACE == "ops" and not getattr(user, "is_operator", False):
            from apps.core.audit import security_event

            security_event(request, "ops_access_denied", user=user, detail={"reason": "not_operator"})
            messages.error(request, "This console is restricted to operators.")
            return redirect(reverse("account_login"))
        return super().pre_login(request, user, **kwargs)

    def send_mail(self, template_prefix, email, context):
        if not settings.EMAIL_ENABLED:
            # Callers are guarded so this should not happen; never claim success.
            log.warning("Email not sent (SMTP not configured): template=%s", template_prefix)
            return
        super().send_mail(template_prefix, email, context)

    def get_login_redirect_url(self, request):
        if settings.SURFACE == "ops":
            return reverse("ops:dashboard")
        return reverse("portal:dashboard")


class MFAAdapter(DefaultMFAAdapter):
    def get_totp_label(self, user) -> str:
        return f"{user.username}@{settings.MATRIX_SERVER_NAME}"

    def get_totp_issuer(self) -> str:
        return settings.BRAND["name"]
