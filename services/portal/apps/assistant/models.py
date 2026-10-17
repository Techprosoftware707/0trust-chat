"""Models of the AI assistant (shared by the in-app assistant and the Claude MCP connector).

* ``AISettings`` - one row per workspace: is the in-app assistant on, may members connect
  Claude (MCP), may AI context include lending-sensitive data, how long (if at all)
  conversation content is kept. Owners/admins change it.
* ``PendingAction`` - a write the AI prepared and a person has not confirmed yet. Short
  lived, single use, bound to the user, the workspace, the channel and a hash of the exact
  payload. Confirming executes the payload through ``apps.crm.services`` as that person.
* ``AIInteraction`` - the audit log of AI use: who, which workspace, which provider/client,
  which tools ran and which record IDs they touched, when. Conversation content is stored
  only when the workspace turned retention on, and is purged when it expires.

No model here stores native chat content: the server cannot read end-to-end encrypted
messages and the assistant never receives them.
"""

from __future__ import annotations

from django.conf import settings
from django.db import models
from django.utils import timezone

from apps.crm.models import TenantModel
from apps.workspaces.models import Workspace


class AISettings(models.Model):
    workspace = models.OneToOneField(Workspace, primary_key=True, on_delete=models.CASCADE, related_name="ai_settings")
    assistant_enabled = models.BooleanField(default=True, help_text="The in-app AI assistant is available to members.")
    mcp_enabled = models.BooleanField(
        default=False, help_text="Members may connect Claude (or another MCP client) to this workspace. Off by default."
    )
    sensitive_data_enabled = models.BooleanField(
        default=False,
        help_text="Lending-sensitive fields may be included in AI context for people whose role may see them. Off by default.",
    )
    content_retention_days = models.PositiveSmallIntegerField(
        default=0, help_text="Keep prompts and answers this many days in the AI audit log (0 = never store content)."
    )
    updated_at = models.DateTimeField(auto_now=True)
    updated_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")

    def __str__(self) -> str:
        return f"AI settings of {self.workspace_id}"


class Channel(models.TextChoices):
    ASSISTANT = "assistant", "In-app assistant"
    MCP = "mcp", "MCP connector"


class PendingAction(TenantModel):
    class Status(models.TextChoices):
        PENDING = "pending", "Waiting for confirmation"
        CONFIRMED = "confirmed", "Confirmed and done"
        CANCELED = "canceled", "Canceled"
        FAILED = "failed", "Failed"

    channel = models.CharField(max_length=12, choices=Channel.choices)
    client_id = models.CharField(max_length=100, blank=True, help_text="OAuth client of an MCP connection.")
    action = models.CharField(max_length=60, help_text="Executor name, e.g. create_task.")
    payload = models.JSONField(help_text="The validated input that confirming executes.")
    payload_hash = models.CharField(max_length=64)
    preview = models.JSONField(default=dict, help_text="What the person was shown (no secrets).")
    status = models.CharField(max_length=12, choices=Status.choices, default=Status.PENDING)
    expires_at = models.DateTimeField()
    decided_at = models.DateTimeField(null=True, blank=True)
    result = models.JSONField(default=dict, blank=True, help_text="References of the records written.")
    error_code = models.CharField(max_length=40, blank=True)

    class Meta:
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["workspace", "created_by", "status"], name="ai_pending_ws_user"),
            models.Index(fields=["expires_at"], name="ai_pending_expires"),
        ]

    @property
    def is_open(self) -> bool:
        return self.status == self.Status.PENDING and self.expires_at > timezone.now()


class AIInteraction(TenantModel):
    class Status(models.TextChoices):
        OK = "ok", "Answered"
        ERROR = "error", "Failed"
        REFUSED = "refused", "Refused"
        RATE_LIMITED = "rate_limited", "Rate limited"

    channel = models.CharField(max_length=12, choices=Channel.choices)
    provider = models.CharField(max_length=40, help_text="dev, anthropic, ... or mcp for connector calls.")
    model = models.CharField(max_length=120, blank=True)
    client_id = models.CharField(max_length=100, blank=True)
    tool_names = models.JSONField(default=list, blank=True)
    record_refs = models.JSONField(default=list, blank=True, help_text='[{"type": "crm.contact", "id": "..."}]')
    pending_action_ids = models.JSONField(default=list, blank=True)
    status = models.CharField(max_length=14, choices=Status.choices, default=Status.OK)
    error_code = models.CharField(max_length=60, blank=True)
    started_at = models.DateTimeField(default=timezone.now)
    finished_at = models.DateTimeField(null=True, blank=True)
    # Only with AISettings.content_retention_days > 0: the prompt and the answer text.
    content = models.JSONField(null=True, blank=True)
    content_expires_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-started_at"]
        indexes = [
            models.Index(fields=["workspace", "-started_at"], name="ai_inter_ws_started"),
            models.Index(fields=["workspace", "created_by", "-started_at"], name="ai_inter_ws_user"),
            models.Index(fields=["content_expires_at"], name="ai_inter_content_exp"),
        ]
