"""Helpers for the Nexus API tests: tokens, business workspaces, JSON requests."""

from __future__ import annotations

import json
import secrets
from datetime import timedelta

from allauth.idp.oidc.adapter import get_adapter
from allauth.idp.oidc.models import Client as OidcClient
from allauth.idp.oidc.models import Token
from django.test import Client
from django.utils import timezone

from apps.accounts.models import User
from apps.api.oauth import ensure_nexus_web_client
from apps.billing.models import Plan
from apps.billing.services import assign_manual_plan, ensure_subscription
from apps.crm.models import OrgSettings
from apps.crm.services import create_default_pipeline
from apps.workspaces.models import Membership, Role, Workspace

from .factories import ensure_plans

_seq = iter(range(1, 10**9))


def make_user(username=None, *, email=None, **extra) -> User:
    """A user without a usable password (no Argon2 hashing: API tests use tokens)."""
    username = username or f"nx{next(_seq)}"
    user = User(username=username, email=email or f"{username}@example.org", **extra)
    user.set_unusable_password()
    user.save()
    return user


ALL_SCOPES = ("workspace:read", "workspace:write")


def issue_token(user, *, scopes=ALL_SCOPES, client_id="nexus-web", expires_in=300, resources=None) -> str:
    """Creates an access token exactly as allauth stores them (hashed) and returns its value."""
    if client_id == "nexus-web":
        ensure_nexus_web_client()
    elif not OidcClient.objects.filter(id=client_id).exists():
        OidcClient.objects.create(id=client_id, name=client_id, type=OidcClient.Type.CONFIDENTIAL)
    value = secrets.token_urlsafe(64)
    t = Token(type=Token.Type.ACCESS_TOKEN, hash=get_adapter().hash_token(value), client_id=client_id, user=user,
              expires_at=timezone.now() + timedelta(seconds=expires_in))
    t.set_scopes(list(scopes))
    if resources:
        t.set_resources(resources)
    t.save()
    return value


class Api:
    """A JSON API client bound to one bearer token."""

    def __init__(self, token: str | None, **extra):
        self.token = token
        self.client = Client(**extra)

    def _headers(self, extra=None):
        h = {}
        if self.token:
            h["HTTP_AUTHORIZATION"] = f"Bearer {self.token}"
        h.update(extra or {})
        return h

    def get(self, path, params=None, **extra):
        return self.client.get(path, params or {}, **self._headers(extra))

    def post(self, path, data=None, **extra):
        return self.client.post(path, json.dumps(data if data is not None else {}), content_type="application/json", **self._headers(extra))

    def patch(self, path, data=None, **extra):
        return self.client.patch(path, json.dumps(data if data is not None else {}), content_type="application/json", **self._headers(extra))

    def delete(self, path, **extra):
        return self.client.delete(path, **self._headers(extra))


def api_for(user, **kw) -> Api:
    return Api(issue_token(user, **kw))


def business_workspace(owner, name="Org", *, profiles=("general",), plan="business", slug=None) -> Workspace:
    ensure_plans()
    ws = Workspace.objects.create(name=name, slug=slug or f"{name.lower().replace(' ', '-')}-{secrets.token_hex(3)}", created_by=owner)
    Membership.objects.create(workspace=ws, user=owner, role=Role.OWNER)
    ensure_subscription(ws)
    if plan:
        assign_manual_plan(ws, Plan.objects.get(code=plan))
    OrgSettings.objects.create(workspace=ws, business_profiles=list(profiles))
    for profile in profiles:
        create_default_pipeline(ws, {"general": "general", "real_estate": "real_estate", "lending": "lending"}[profile], user=owner)
    return ws


def member(ws, role, username=None):
    u = make_user(username)
    Membership.objects.create(workspace=ws, user=u, role=role)
    return u


def base(ws) -> str:
    return f"/api/v1/workspaces/{ws.pk}/crm"


def body(response):
    return json.loads(response.content) if response.content else None
