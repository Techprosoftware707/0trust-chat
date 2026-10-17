"""Models of the Claude MCP connector.

* ``McpGrant`` - one connection: a person authorised an MCP client (Claude) to act for them
  in one workspace with some scopes. Created on the consent screen; its tokens live in
  allauth's ``Token`` table (hashed). Revoking deletes the tokens and the grant.
* ``RotatedRefreshToken`` - SHA-256 hashes of refresh tokens that were already rotated. A
  second use of one is a replay (OAuth 2.1 / RFC 9700 refresh token reuse detection): the
  whole connection's tokens are revoked and the request gets ``invalid_grant``.
"""

from __future__ import annotations

from allauth.idp.oidc.models import Client
from django.conf import settings
from django.db import models

from apps.crm.models import TenantModel


class McpGrant(TenantModel):
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="+")
    client = models.ForeignKey(Client, on_delete=models.CASCADE, related_name="+")
    scopes = models.JSONField(default=list, blank=True)
    last_token_at = models.DateTimeField(null=True, blank=True)
    last_used_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-created_at"]
        constraints = [models.UniqueConstraint(fields=["user", "client"], name="mcp_grant_unique_user_client")]
        indexes = [models.Index(fields=["workspace", "user"], name="mcp_grant_ws_user")]


class RotatedRefreshToken(models.Model):
    hash = models.CharField(max_length=64, unique=True)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="+")
    client_id = models.CharField(max_length=100)
    rotated_at = models.DateTimeField(auto_now_add=True)
    expires_at = models.DateTimeField(db_index=True)
