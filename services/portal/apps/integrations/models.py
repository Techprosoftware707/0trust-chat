"""Integrations: connections to Gmail, GoHighLevel and Slack, their encrypted credentials,
OAuth flows in progress, webhook deliveries, and the synced items of the unified inbox.

Rules (docs/nexus/INTEGRATIONS.md):

* every business row is a ``TenantModel`` read only through ``apps.crm.access`` policies
  (``apps/integrations/policies.py``);
* credentials live in ``IntegrationCredential`` only, AES-GCM encrypted (``crypto.py``), and
  are never serialized, logged or returned;
* everything that came from a provider (subjects, snippets, names, Slack text, GoHighLevel
  data) is untrusted external data: it is shown as external and never treated as
  instructions;
* external IDs are unique per connection and mirrored in ``crm.ExternalRecordMapping``
  (provider + scoped external ID -> internal row) for idempotency and dedup;
* email bodies and attachments are never stored: they are fetched on demand.
"""

from __future__ import annotations

import uuid

from django.conf import settings
from django.db import models
from django.db.models import Q
from django.utils import timezone

from apps.crm.models import Priority, TenantModel
from apps.workspaces.models import Workspace


class Provider(models.TextChoices):
    GMAIL = "gmail", "Gmail"
    GOHIGHLEVEL = "gohighlevel", "GoHighLevel"
    SLACK = "slack", "Slack"


class IntegrationConnection(TenantModel):
    """One connected external account. Gmail is personal (the owner's mailbox, visible only to
    them); GoHighLevel and Slack are workspace-wide and owned by an owner/admin."""

    class Status(models.TextChoices):
        CONNECTED = "connected", "Connected"
        NEEDS_REAUTH = "needs_reauth", "Needs to be reconnected"
        ERROR = "error", "Error"
        DISCONNECTED = "disconnected", "Disconnected"

    class Scope(models.TextChoices):
        PERSONAL = "personal", "Personal (only the owner sees synced items)"
        WORKSPACE = "workspace", "Workspace (shared with the team)"

    class AuthMethod(models.TextChoices):
        OAUTH = "oauth", "OAuth"
        PRIVATE_TOKEN = "private_token", "Private integration token"

    provider = models.CharField(max_length=20, choices=Provider.choices)
    scope = models.CharField(max_length=10, choices=Scope.choices)
    owner = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    # The connected account at the provider: Gmail address, GoHighLevel location ID, Slack team ID.
    account_id = models.CharField(max_length=255)
    account_label = models.CharField(max_length=255, blank=True)
    granted_scopes = models.JSONField(default=list, blank=True)
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.CONNECTED)
    auth_method = models.CharField(max_length=20, choices=AuthMethod.choices, default=AuthMethod.OAUTH)
    is_mock = models.BooleanField(default=False, help_text="Connected to a local mock provider (development).")
    connected_at = models.DateTimeField(default=timezone.now)
    disconnected_at = models.DateTimeField(null=True, blank=True)
    last_sync_at = models.DateTimeField(null=True, blank=True)
    next_sync_at = models.DateTimeField(null=True, blank=True)
    sync_requested_at = models.DateTimeField(null=True, blank=True)
    sync_lease_until = models.DateTimeField(null=True, blank=True, help_text="A sync is running until then (one at a time).")
    # Safe error description only: a stable code and a short message we wrote ourselves.
    last_error_code = models.CharField(max_length=60, blank=True)
    last_error_message = models.CharField(max_length=300, blank=True)
    last_error_at = models.DateTimeField(null=True, blank=True)
    failure_count = models.PositiveIntegerField(default=0)
    last_webhook_at = models.DateTimeField(null=True, blank=True)
    settings = models.JSONField(default=dict, blank=True, help_text="Provider options (selected channels, ...). Never secrets.")
    sync_state = models.JSONField(default=dict, blank=True, help_text="Provider cursors. Never secrets.")

    class Meta:
        ordering = ["provider", "account_label"]
        indexes = [
            models.Index(fields=["workspace", "provider"], name="intg_conn_ws_provider"),
            models.Index(fields=["status", "next_sync_at"], name="intg_conn_due"),
            models.Index(fields=["provider", "account_id"], name="intg_conn_account"),
        ]
        constraints = [
            models.UniqueConstraint(fields=["workspace", "provider", "account_id"], condition=~Q(status="disconnected"),
                                    name="intg_conn_unique_active_account"),
        ]

    def __str__(self) -> str:
        return f"{self.get_provider_display()} {self.account_label or self.account_id}"

    @property
    def is_active(self) -> bool:
        return self.status != self.Status.DISCONNECTED


class IntegrationCredential(models.Model):
    """Encrypted tokens of one connection (AES-GCM, ``crypto.py``). Not a tenant API model:
    nothing reads it except ``tokens.py``."""

    connection = models.OneToOneField(IntegrationConnection, primary_key=True, on_delete=models.CASCADE, related_name="credential")
    access_token = models.BinaryField()
    refresh_token = models.BinaryField(null=True, blank=True)
    access_expires_at = models.DateTimeField(null=True, blank=True)
    refresh_expires_at = models.DateTimeField(null=True, blank=True)
    key_id = models.CharField(max_length=16)
    version = models.PositiveIntegerField(default=1, help_text="Incremented on every refresh (optimistic check).")
    updated_at = models.DateTimeField(auto_now=True)

    def __repr__(self) -> str:  # never show token material
        return f"<IntegrationCredential connection={self.connection_id} v{self.version}>"

    __str__ = __repr__


class OAuthState(models.Model):
    """An OAuth authorization in progress. The ``state`` parameter is a signed token naming
    this row's nonce; the row is single-use, expires quickly and is bound to the browser
    session that started it (``binding_hash``)."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    nonce_hash = models.CharField(max_length=64, unique=True)
    provider = models.CharField(max_length=20, choices=Provider.choices)
    workspace = models.ForeignKey(Workspace, on_delete=models.CASCADE, related_name="+")
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="+")
    binding_hash = models.CharField(max_length=64, blank=True)
    pkce_verifier = models.BinaryField(null=True, blank=True)
    reconnect = models.ForeignKey(IntegrationConnection, null=True, blank=True, on_delete=models.CASCADE, related_name="+")
    created_at = models.DateTimeField(default=timezone.now)
    expires_at = models.DateTimeField()
    began_at = models.DateTimeField(null=True, blank=True)
    used_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        indexes = [models.Index(fields=["expires_at"], name="intg_oauthstate_expiry")]


class WebhookEvent(models.Model):
    """Idempotency record of a provider webhook delivery. The payload is not stored; only its
    identity, type and the outcome."""

    class Outcome(models.TextChoices):
        PROCESSED = "processed", "Processed"
        IGNORED = "ignored", "Ignored"
        FAILED = "failed", "Failed"

    provider = models.CharField(max_length=20, choices=Provider.choices)
    event_id = models.CharField(max_length=200)
    event_type = models.CharField(max_length=80, blank=True)
    workspace = models.ForeignKey(Workspace, null=True, blank=True, on_delete=models.CASCADE, related_name="+")
    connection = models.ForeignKey(IntegrationConnection, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    received_at = models.DateTimeField(default=timezone.now, db_index=True)
    outcome = models.CharField(max_length=10, choices=Outcome.choices, default=Outcome.PROCESSED)
    detail = models.CharField(max_length=200, blank=True)
    duplicates = models.PositiveIntegerField(default=0)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["provider", "event_id"], name="intg_webhook_unique_event")]


class InboxItem(TenantModel):
    """One item of the unified inbox that came from a provider: a Gmail thread, a Slack
    message, a GoHighLevel conversation or a missed call. Native chat never appears here
    (it is merged in the browser, end-to-end encrypted)."""

    class Kind(models.TextChoices):
        EMAIL_THREAD = "email_thread", "Email thread"
        SLACK_MESSAGE = "slack_message", "Slack message"
        GHL_CONVERSATION = "ghl_conversation", "GoHighLevel conversation"
        MISSED_CALL = "missed_call", "Missed call"

    class Visibility(models.TextChoices):
        PERSONAL = "personal", "Only the connection owner"
        WORKSPACE = "workspace", "Everyone with access to workspace records"

    class Status(models.TextChoices):
        OPEN = "open", "Open"
        DONE = "done", "Done"

    connection = models.ForeignKey(IntegrationConnection, on_delete=models.CASCADE, related_name="inbox_items")
    source = models.CharField(max_length=20, choices=Provider.choices)
    kind = models.CharField(max_length=20, choices=Kind.choices)
    external_id = models.CharField(max_length=255)
    visibility = models.CharField(max_length=10, choices=Visibility.choices)
    owner = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    # Untrusted provider content (shown as external, never as instructions).
    title = models.CharField(max_length=300, blank=True)
    snippet = models.TextField(blank=True, max_length=4000)
    participants = models.JSONField(default=list, blank=True)
    occurred_at = models.DateTimeField(default=timezone.now)
    external_url = models.URLField(blank=True, max_length=500)
    group_key = models.CharField(max_length=200, blank=True)
    group_label = models.CharField(max_length=200, blank=True)
    # Workspace state of the item (ours, not the provider's).
    priority = models.CharField(max_length=10, choices=Priority.choices, default=Priority.NORMAL)
    assignee = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    labels = models.JSONField(default=list, blank=True)
    status = models.CharField(max_length=10, choices=Status.choices, default=Status.OPEN)
    provider_unread = models.BooleanField(default=False)
    message_count = models.PositiveIntegerField(default=1)
    has_attachments = models.BooleanField(default=False)
    data = models.JSONField(default=dict, blank=True, help_text="Provider metadata (untrusted).")

    class Meta:
        ordering = ["-occurred_at", "-created_at"]
        indexes = [
            models.Index(fields=["workspace", "-occurred_at"], name="intg_inbox_ws_time"),
            models.Index(fields=["workspace", "source", "-occurred_at"], name="intg_inbox_ws_source"),
            models.Index(fields=["workspace", "assignee"], name="intg_inbox_ws_assignee"),
            models.Index(fields=["workspace", "group_key"], name="intg_inbox_ws_group"),
        ]
        constraints = [models.UniqueConstraint(fields=["connection", "external_id"], name="intg_inbox_unique_external")]


class InboxReadState(models.Model):
    """Per-person read state of an inbox item."""

    item = models.ForeignKey(InboxItem, on_delete=models.CASCADE, related_name="read_states")
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="+")
    read_at = models.DateTimeField(default=timezone.now)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["item", "user"], name="intg_readstate_unique")]


class InboxMute(TenantModel):
    """A person muted a group of notifications (a Slack channel, a sender, a chat room ID)."""

    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="+")
    group_key = models.CharField(max_length=200)
    label = models.CharField(max_length=200, blank=True)

    class Meta:
        ordering = ["label", "group_key"]
        constraints = [models.UniqueConstraint(fields=["workspace", "user", "group_key"], name="intg_mute_unique")]


class InboxLink(TenantModel):
    """An inbox item linked by a person to a record (contact, deal, task, property,
    application...). Linking an email thread or message also adds an external, untrusted
    entry to the record's timeline (``activity``); unlinking removes it."""

    item = models.ForeignKey(InboxItem, on_delete=models.CASCADE, related_name="links")
    target_type = models.CharField(max_length=60)
    target_id = models.UUIDField()
    activity = models.ForeignKey("crm.Activity", null=True, blank=True, on_delete=models.SET_NULL, related_name="+")

    class Meta:
        ordering = ["-created_at"]
        indexes = [models.Index(fields=["workspace", "target_type", "target_id"], name="intg_link_target")]
        constraints = [models.UniqueConstraint(fields=["item", "target_type", "target_id"], name="intg_link_unique")]


class EmailMessage(TenantModel):
    """Metadata of one Gmail message (headers, snippet, attachment list). The body and the
    attachments themselves are never stored."""

    item = models.ForeignKey(InboxItem, on_delete=models.CASCADE, related_name="email_messages")
    external_id = models.CharField(max_length=255)
    from_name = models.CharField(max_length=200, blank=True)
    from_address = models.CharField(max_length=254, blank=True)
    reply_to = models.CharField(max_length=254, blank=True)
    to = models.JSONField(default=list, blank=True)
    cc = models.JSONField(default=list, blank=True)
    subject = models.CharField(max_length=300, blank=True)
    sent_at = models.DateTimeField(default=timezone.now)
    snippet = models.TextField(blank=True, max_length=2000)
    label_ids = models.JSONField(default=list, blank=True)
    rfc_message_id = models.CharField(max_length=500, blank=True)
    references = models.TextField(blank=True, max_length=4000)
    attachments = models.JSONField(default=list, blank=True)

    class Meta:
        ordering = ["sent_at"]
        constraints = [models.UniqueConstraint(fields=["item", "external_id"], name="intg_email_unique_message")]


class EmailDraft(TenantModel):
    """A reply draft created in the person's Gmail. The text is kept only while it is a
    draft (so what was reviewed is exactly what is sent) and cleared afterwards."""

    class Status(models.TextChoices):
        DRAFT = "draft", "Draft"
        SENT = "sent", "Sent"
        FAILED = "failed", "Sending failed"
        DISCARDED = "discarded", "Discarded"

    item = models.ForeignKey(InboxItem, on_delete=models.CASCADE, related_name="drafts")
    connection = models.ForeignKey(IntegrationConnection, on_delete=models.CASCADE, related_name="+")
    external_draft_id = models.CharField(max_length=255, blank=True)
    to = models.JSONField(default=list, blank=True)
    cc = models.JSONField(default=list, blank=True)
    subject = models.CharField(max_length=300, blank=True)
    body = models.TextField(blank=True, max_length=50000)
    in_reply_to = models.CharField(max_length=500, blank=True)
    references = models.TextField(blank=True, max_length=4000)
    status = models.CharField(max_length=10, choices=Status.choices, default=Status.DRAFT)
    sent_message_id = models.CharField(max_length=255, blank=True)
    sent_at = models.DateTimeField(null=True, blank=True)
    last_error_code = models.CharField(max_length=60, blank=True)

    class Meta:
        ordering = ["-created_at"]


class ExternalRecord(TenantModel):
    """Read-only mirror of a GoHighLevel record (opportunity, pipeline, contact, tag, custom
    field), shown as external. Mapping to internal records is ``crm.ExternalRecordMapping``."""

    class Kind(models.TextChoices):
        CONTACT = "contact", "Contact"
        OPPORTUNITY = "opportunity", "Opportunity"
        PIPELINE = "pipeline", "Pipeline"
        TAG = "tag", "Tag"
        CUSTOM_FIELD = "custom_field", "Custom field"

    connection = models.ForeignKey(IntegrationConnection, on_delete=models.CASCADE, related_name="external_records")
    kind = models.CharField(max_length=20, choices=Kind.choices)
    external_id = models.CharField(max_length=255)
    title = models.CharField(max_length=300, blank=True)
    data = models.JSONField(default=dict, blank=True)
    external_updated_at = models.DateTimeField(null=True, blank=True)
    fetched_at = models.DateTimeField(default=timezone.now)

    class Meta:
        ordering = ["kind", "title"]
        indexes = [models.Index(fields=["workspace", "kind"], name="intg_extrec_ws_kind")]
        constraints = [models.UniqueConstraint(fields=["connection", "kind", "external_id"], name="intg_extrec_unique")]


class PendingAction(TenantModel):
    """A consequential external action waiting for the person's explicit confirmation (send
    an email, post to Slack, change a GoHighLevel record, start a workflow). The server
    issues a single-use confirmation token (stored hashed) bound to this person and action;
    the action runs only when the same person confirms with that token before it expires."""

    class Kind(models.TextChoices):
        GMAIL_SEND = "gmail.send_draft", "Send an email"
        SLACK_POST = "slack.post_message", "Post to Slack"
        GHL_CREATE_CONTACT = "ghl.create_contact", "Create a GoHighLevel contact"
        GHL_UPDATE_CONTACT = "ghl.update_contact", "Update a GoHighLevel contact"
        GHL_ADD_TO_WORKFLOW = "ghl.add_to_workflow", "Add a contact to a GoHighLevel workflow"

    class Status(models.TextChoices):
        PENDING = "pending", "Waiting for confirmation"
        EXECUTED = "executed", "Done"
        FAILED = "failed", "Failed"
        CANCELED = "canceled", "Canceled"

    connection = models.ForeignKey(IntegrationConnection, on_delete=models.CASCADE, related_name="+")
    kind = models.CharField(max_length=30, choices=Kind.choices)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="+")
    payload = models.JSONField(default=dict, blank=True)
    preview = models.JSONField(default=dict, blank=True)
    token_hash = models.CharField(max_length=64)
    expires_at = models.DateTimeField()
    used_at = models.DateTimeField(null=True, blank=True)
    status = models.CharField(max_length=10, choices=Status.choices, default=Status.PENDING)
    result = models.JSONField(default=dict, blank=True)
    error_code = models.CharField(max_length=60, blank=True)
    error_message = models.CharField(max_length=300, blank=True)

    class Meta:
        ordering = ["-created_at"]
        indexes = [models.Index(fields=["workspace", "user", "status"], name="intg_action_ws_user")]
