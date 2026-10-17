"""Business records of a workspace (organisation): contacts, pipelines, opportunities,
tasks, the activity timeline, calendar events, conversation links and external mappings.

Rules every model here (and every model other teams add) follows:

* tenant-owned: ``workspace`` is a NOT NULL, indexed foreign key; rows are only ever read
  through ``apps.crm.access`` (``for_actor``), never with a bare ``objects.all()``;
* UUID primary keys (not enumerable), ``created_by``, ``created_at``, ``updated_at``;
* ``is_demo`` marks rows created by ``manage.py nexus_demo_seed`` (and only those);
* no native chat content: conversations are referenced by Matrix room and event IDs only
  (end-to-end encrypted messages stay unreadable to the server: ARCHITECTURE.md);
* external IDs (Gmail, GoHighLevel, Slack, ...) never replace internal IDs: they live in
  ``ExternalRecordMapping``.

Vertical records (properties, lending applications, document checklists) come from the
verticals team. They subclass ``TenantModel``, register an access policy, and are linked to
contacts/opportunities/tasks/activities/events through the generic ``related_type`` /
``related_id`` reference or ``RecordLink`` (see ARCHITECTURE.md, "Related records").
"""

from __future__ import annotations

import uuid

from django.conf import settings
from django.db import models
from django.db.models import Q
from django.db.models.functions import Lower
from django.utils import timezone

from apps.workspaces.models import Workspace


class TenantModel(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    workspace = models.ForeignKey(Workspace, on_delete=models.CASCADE, related_name="+", db_index=True)
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    created_at = models.DateTimeField(default=timezone.now)
    updated_at = models.DateTimeField(auto_now=True)
    is_demo = models.BooleanField(default=False, help_text="Created by the synthetic demo seeder.")

    class Meta:
        abstract = True

    @classmethod
    def type_label(cls) -> str:
        """Stable type name used in API references, e.g. ``crm.contact``."""
        return cls._meta.label_lower


class Visibility(models.TextChoices):
    TEAM = "team", "Shared with the team"
    PRIVATE = "private", "Private (owner, assignees, collaborators and managers)"


class Priority(models.TextChoices):
    LOW = "low", "Low"
    NORMAL = "normal", "Normal"
    HIGH = "high", "High"
    URGENT = "urgent", "Urgent"


class BusinessProfile(models.TextChoices):
    GENERAL = "general", "General business"
    REAL_ESTATE = "real_estate", "Real estate"
    LENDING = "lending", "Lending"


class OrgSettings(models.Model):
    """Business settings of one workspace. A workspace without a row (or with no
    profiles) is a plain chat workspace: no business features are enabled."""

    workspace = models.OneToOneField(Workspace, primary_key=True, on_delete=models.CASCADE, related_name="crm_settings")
    business_profiles = models.JSONField(default=list, blank=True, help_text="Subset of general, real_estate, lending.")
    default_currency = models.CharField(max_length=3, default="USD")
    # User-controlled declassification ("Save to record" copies selected, already decrypted
    # chat text into a CRM note from the SPA). Off by default; owner/admin decide.
    save_to_record_enabled = models.BooleanField(default=False)
    is_demo = models.BooleanField(default=False, help_text="Synthetic demo workspace (nexus_demo_seed).")
    updated_at = models.DateTimeField(auto_now=True)
    updated_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")

    def __str__(self) -> str:
        return f"Business settings of {self.workspace_id}"


class Tag(TenantModel):
    COLORS = ["slate", "blue", "teal", "green", "amber", "red", "violet", "pink"]

    name = models.CharField(max_length=50)
    color = models.CharField(max_length=12, default="slate")

    class Meta:
        ordering = ["name"]
        constraints = [models.UniqueConstraint(Lower("name"), "workspace", name="crm_tag_unique_name")]

    def __str__(self) -> str:
        return self.name


class FieldDefinition(TenantModel):
    """A custom field of contacts or opportunities, validated on every write."""

    class Entity(models.TextChoices):
        CONTACT = "contact", "Contact"
        OPPORTUNITY = "opportunity", "Opportunity"

    class Type(models.TextChoices):
        TEXT = "text", "Text"
        LONG_TEXT = "long_text", "Long text"
        NUMBER = "number", "Number"
        DECIMAL = "decimal", "Decimal"
        CURRENCY = "currency", "Amount"
        BOOLEAN = "boolean", "Yes / no"
        DATE = "date", "Date"
        SELECT = "select", "One of a list"
        MULTISELECT = "multiselect", "Several of a list"
        EMAIL = "email", "Email"
        PHONE = "phone", "Phone"
        URL = "url", "Link"

    entity = models.CharField(max_length=20, choices=Entity.choices)
    key = models.SlugField(max_length=40)
    label = models.CharField(max_length=80)
    field_type = models.CharField(max_length=20, choices=Type.choices)
    options = models.JSONField(default=list, blank=True, help_text="For select/multiselect: [{value, label}].")
    required = models.BooleanField(default=False)
    sensitive = models.BooleanField(default=False, help_text="Reads are audited; hidden from team members and read-only people.")
    profile = models.CharField(max_length=20, choices=BusinessProfile.choices, blank=True)
    position = models.IntegerField(default=0)
    archived = models.BooleanField(default=False)

    class Meta:
        ordering = ["entity", "position", "label"]
        constraints = [models.UniqueConstraint(fields=["workspace", "entity", "key"], name="crm_fielddef_unique_key")]


class Contact(TenantModel):
    class Kind(models.TextChoices):
        LEAD = "lead", "Lead"
        PROSPECT = "prospect", "Prospect"
        CLIENT = "client", "Client"
        PAST_CLIENT = "past_client", "Past client"
        PARTNER = "partner", "Partner"

    class Role(models.TextChoices):
        BUYER = "buyer", "Buyer"
        SELLER = "seller", "Seller"
        LANDLORD = "landlord", "Landlord"
        TENANT = "tenant", "Tenant"
        INVESTOR = "investor", "Investor"
        BORROWER = "borrower", "Borrower"
        CO_BORROWER = "co_borrower", "Co-borrower"
        REFERRAL_PARTNER = "referral_partner", "Referral partner"
        VENDOR = "vendor", "Vendor"
        OTHER = "other", "Other"

    kind = models.CharField(max_length=20, choices=Kind.choices, default=Kind.LEAD)
    roles = models.JSONField(default=list, blank=True)
    first_name = models.CharField(max_length=80, blank=True)
    last_name = models.CharField(max_length=80, blank=True)
    company = models.CharField(max_length=120, blank=True)
    job_title = models.CharField(max_length=120, blank=True)
    email = models.EmailField(blank=True)
    phone = models.CharField(max_length=40, blank=True)
    owner = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    assignees = models.ManyToManyField(settings.AUTH_USER_MODEL, blank=True, related_name="+")
    visibility = models.CharField(max_length=10, choices=Visibility.choices, default=Visibility.TEAM)
    source = models.CharField(max_length=60, blank=True)
    campaign = models.CharField(max_length=120, blank=True)
    follow_up_at = models.DateTimeField(null=True, blank=True)
    priority = models.CharField(max_length=10, choices=Priority.choices, default=Priority.NORMAL)
    tags = models.ManyToManyField(Tag, blank=True, related_name="contacts")
    custom_fields = models.JSONField(default=dict, blank=True)
    last_activity_at = models.DateTimeField(null=True, blank=True)
    archived_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-updated_at"]
        indexes = [
            models.Index(fields=["workspace", "owner"], name="crm_contact_ws_owner"),
            models.Index(fields=["workspace", "follow_up_at"], name="crm_contact_ws_followup"),
            models.Index(fields=["workspace", "-updated_at"], name="crm_contact_ws_updated"),
            models.Index(fields=["workspace", "kind"], name="crm_contact_ws_kind"),
            models.Index(fields=["workspace", "email"], name="crm_contact_ws_email"),
        ]

    @property
    def display_name(self) -> str:
        name = f"{self.first_name} {self.last_name}".strip()
        return name or self.company or self.email or "Unnamed contact"

    def __str__(self) -> str:
        return self.display_name


class Pipeline(TenantModel):
    class Kind(models.TextChoices):
        GENERAL = "general", "General"
        REAL_ESTATE = "real_estate", "Real estate"
        LENDING = "lending", "Lending"

    name = models.CharField(max_length=80)
    kind = models.CharField(max_length=20, choices=Kind.choices, default=Kind.GENERAL)
    position = models.IntegerField(default=0)
    is_default = models.BooleanField(default=False)
    currency = models.CharField(max_length=3, default="USD")
    archived = models.BooleanField(default=False)

    class Meta:
        ordering = ["position", "name"]

    def __str__(self) -> str:
        return self.name


class Stage(TenantModel):
    pipeline = models.ForeignKey(Pipeline, on_delete=models.CASCADE, related_name="stages")
    name = models.CharField(max_length=80)
    position = models.IntegerField(default=0)
    is_won = models.BooleanField(default=False)
    is_lost = models.BooleanField(default=False)
    probability = models.PositiveSmallIntegerField(null=True, blank=True, help_text="0-100, optional.")

    class Meta:
        ordering = ["pipeline", "position", "created_at"]
        constraints = [
            models.CheckConstraint(condition=~(Q(is_won=True) & Q(is_lost=True)), name="crm_stage_not_won_and_lost"),
        ]

    def __str__(self) -> str:
        return self.name


class Opportunity(TenantModel):
    class Status(models.TextChoices):
        OPEN = "open", "Open"
        WON = "won", "Won"
        LOST = "lost", "Lost"

    name = models.CharField(max_length=160)
    pipeline = models.ForeignKey(Pipeline, on_delete=models.PROTECT, related_name="opportunities")
    stage = models.ForeignKey(Stage, on_delete=models.PROTECT, related_name="opportunities")
    contacts = models.ManyToManyField(Contact, through="OpportunityContact", blank=True, related_name="opportunities")
    value = models.DecimalField(max_digits=14, decimal_places=2, null=True, blank=True)
    currency = models.CharField(max_length=3, default="USD")
    owner = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    collaborators = models.ManyToManyField(settings.AUTH_USER_MODEL, blank=True, related_name="+")
    visibility = models.CharField(max_length=10, choices=Visibility.choices, default=Visibility.TEAM)
    priority = models.CharField(max_length=10, choices=Priority.choices, default=Priority.NORMAL)
    status = models.CharField(max_length=10, choices=Status.choices, default=Status.OPEN)
    expected_close_date = models.DateField(null=True, blank=True)
    closed_at = models.DateTimeField(null=True, blank=True)
    stage_entered_at = models.DateTimeField(default=timezone.now)
    position = models.FloatField(default=0, help_text="Order within the stage (kanban).")
    source = models.CharField(max_length=60, blank=True)
    custom_fields = models.JSONField(default=dict, blank=True)

    class Meta:
        ordering = ["position", "-updated_at"]
        verbose_name_plural = "opportunities"
        indexes = [
            models.Index(fields=["workspace", "stage"], name="crm_opp_ws_stage"),
            models.Index(fields=["workspace", "owner"], name="crm_opp_ws_owner"),
            models.Index(fields=["workspace", "-updated_at"], name="crm_opp_ws_updated"),
            models.Index(fields=["workspace", "expected_close_date"], name="crm_opp_ws_close"),
            models.Index(fields=["pipeline", "stage", "position"], name="crm_opp_board"),
        ]

    def __str__(self) -> str:
        return self.name


class OpportunityContact(models.Model):
    class Role(models.TextChoices):
        PRIMARY = "primary", "Primary contact"
        BUYER = "buyer", "Buyer"
        SELLER = "seller", "Seller"
        BORROWER = "borrower", "Borrower"
        CO_BORROWER = "co_borrower", "Co-borrower"
        OTHER = "other", "Other"

    opportunity = models.ForeignKey(Opportunity, on_delete=models.CASCADE, related_name="contact_links")
    contact = models.ForeignKey(Contact, on_delete=models.CASCADE, related_name="opportunity_links")
    role = models.CharField(max_length=20, choices=Role.choices, default=Role.PRIMARY)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["opportunity", "contact"], name="crm_oppcontact_unique")]


class StageHistory(TenantModel):
    opportunity = models.ForeignKey(Opportunity, on_delete=models.CASCADE, related_name="stage_history")
    from_stage = models.ForeignKey(Stage, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    to_stage = models.ForeignKey(Stage, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    # Names at the time of the change, so history stays readable after stages are renamed.
    from_name = models.CharField(max_length=80, blank=True)
    to_name = models.CharField(max_length=80, blank=True)

    class Meta:
        ordering = ["-created_at"]
        indexes = [models.Index(fields=["opportunity", "-created_at"], name="crm_stagehist_opp")]


class RelatedRef(models.Model):
    """Optional generic reference to any registered tenant record (``crm.contact``,
    ``realestate.property``, ...), resolved and authorized through ``apps.crm.access``."""

    related_type = models.CharField(max_length=60, blank=True)
    related_id = models.UUIDField(null=True, blank=True)

    class Meta:
        abstract = True


class Task(TenantModel, RelatedRef):
    class Status(models.TextChoices):
        OPEN = "open", "Open"
        IN_PROGRESS = "in_progress", "In progress"
        DONE = "done", "Done"
        CANCELED = "canceled", "Canceled"

    class Source(models.TextChoices):
        MANUAL = "manual", "Manual"
        AI_SUGGESTION_CONFIRMED = "ai_suggestion_confirmed", "AI suggestion (confirmed by a person)"
        AUTOMATION = "automation", "Automation"
        INTEGRATION = "integration", "Integration"

    title = models.CharField(max_length=200)
    description = models.TextField(blank=True, max_length=5000)
    assignee = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    due_at = models.DateTimeField(null=True, blank=True)
    priority = models.CharField(max_length=10, choices=Priority.choices, default=Priority.NORMAL)
    status = models.CharField(max_length=12, choices=Status.choices, default=Status.OPEN)
    completed_at = models.DateTimeField(null=True, blank=True)
    completed_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    contact = models.ForeignKey(Contact, null=True, blank=True, on_delete=models.SET_NULL, related_name="tasks")
    opportunity = models.ForeignKey(Opportunity, null=True, blank=True, on_delete=models.SET_NULL, related_name="tasks")
    source = models.CharField(max_length=30, choices=Source.choices, default=Source.MANUAL)
    visibility = models.CharField(max_length=10, choices=Visibility.choices, default=Visibility.TEAM)

    class Meta:
        ordering = ["due_at", "-created_at"]
        indexes = [
            models.Index(fields=["workspace", "assignee", "status", "due_at"], name="crm_task_ws_assignee"),
            models.Index(fields=["workspace", "due_at"], name="crm_task_ws_due"),
            models.Index(fields=["workspace", "-updated_at"], name="crm_task_ws_updated"),
        ]

    @property
    def is_open(self) -> bool:
        return self.status in {self.Status.OPEN, self.Status.IN_PROGRESS}


class Activity(TenantModel, RelatedRef):
    """One entry of a record's timeline."""

    class Kind(models.TextChoices):
        NOTE = "note", "Note"
        CALL = "call", "Call"
        MEETING = "meeting", "Meeting"
        EMAIL = "email", "Email"
        MESSAGE_LINK = "message_link", "Linked chat message"
        STAGE_CHANGE = "stage_change", "Stage change"
        TASK_EVENT = "task_event", "Task update"
        INTEGRATION_EVENT = "integration_event", "Integration event"

    class Source(models.TextChoices):
        NATIVE = "native", "Nexus"
        GMAIL = "gmail", "Gmail"
        GOHIGHLEVEL = "gohighlevel", "GoHighLevel"
        SLACK = "slack", "Slack"
        SYSTEM = "system", "System"

    kind = models.CharField(max_length=20, choices=Kind.choices)
    source = models.CharField(max_length=20, choices=Source.choices, default=Source.NATIVE)
    actor = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    occurred_at = models.DateTimeField(default=timezone.now)
    summary = models.CharField(max_length=300)
    body = models.TextField(blank=True, max_length=20000)
    # Provider reference (message ID, thread ID...). Never an internal ID.
    external_ref = models.CharField(max_length=255, blank=True)
    # message_link: the Matrix event this entry points to. Metadata only: the server cannot
    # read end-to-end encrypted messages and never stores their content here.
    room_id = models.CharField(max_length=255, blank=True)
    event_id = models.CharField(max_length=255, blank=True)
    # True for content that came from outside (email, integrations): show it as such and
    # treat it as data, never as instructions (AI assistant / MCP).
    untrusted = models.BooleanField(default=False)
    metadata = models.JSONField(default=dict, blank=True)
    contact = models.ForeignKey(Contact, null=True, blank=True, on_delete=models.CASCADE, related_name="activities")
    opportunity = models.ForeignKey(Opportunity, null=True, blank=True, on_delete=models.CASCADE, related_name="activities")
    task = models.ForeignKey(Task, null=True, blank=True, on_delete=models.SET_NULL, related_name="activities")

    class Meta:
        ordering = ["-occurred_at", "-created_at"]
        verbose_name_plural = "activities"
        indexes = [
            models.Index(fields=["workspace", "-occurred_at"], name="crm_act_ws_occurred"),
            models.Index(fields=["contact", "-occurred_at"], name="crm_act_contact"),
            models.Index(fields=["opportunity", "-occurred_at"], name="crm_act_opp"),
            models.Index(fields=["workspace", "-updated_at"], name="crm_act_ws_updated"),
        ]


class CalendarEvent(TenantModel, RelatedRef):
    class Status(models.TextChoices):
        SCHEDULED = "scheduled", "Scheduled"
        CANCELED = "canceled", "Canceled"
        COMPLETED = "completed", "Completed"

    class Kind(models.TextChoices):
        MEETING = "meeting", "Meeting"
        VIEWING = "viewing", "Viewing"
        CALL = "call", "Call"
        CLOSING = "closing", "Closing"
        APPOINTMENT = "appointment", "Appointment"
        OTHER = "other", "Other"

    kind = models.CharField(max_length=20, choices=Kind.choices, default=Kind.MEETING)
    title = models.CharField(max_length=200)
    description = models.TextField(blank=True, max_length=5000)
    start_at = models.DateTimeField()
    end_at = models.DateTimeField()
    all_day = models.BooleanField(default=False)
    location = models.CharField(max_length=200, blank=True)
    organizer = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    attendee_users = models.ManyToManyField(settings.AUTH_USER_MODEL, blank=True, related_name="+")
    attendee_contacts = models.ManyToManyField(Contact, blank=True, related_name="events")
    # The Matrix room whose (end-to-end encrypted) call is the meeting link.
    matrix_room_id = models.CharField(max_length=255, blank=True)
    contact = models.ForeignKey(Contact, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    opportunity = models.ForeignKey(Opportunity, null=True, blank=True, on_delete=models.SET_NULL, related_name="events")
    status = models.CharField(max_length=12, choices=Status.choices, default=Status.SCHEDULED)
    visibility = models.CharField(max_length=10, choices=Visibility.choices, default=Visibility.TEAM)

    class Meta:
        ordering = ["start_at"]
        indexes = [
            models.Index(fields=["workspace", "start_at"], name="crm_event_ws_start"),
            models.Index(fields=["workspace", "organizer", "start_at"], name="crm_event_ws_organizer"),
            models.Index(fields=["workspace", "-updated_at"], name="crm_event_ws_updated"),
        ]
        constraints = [models.CheckConstraint(condition=Q(end_at__gte=models.F("start_at")), name="crm_event_end_after_start")]


class ConversationLink(TenantModel):
    """Links a Matrix room (optionally one event) to a contact or opportunity. Stores
    identifiers only; the conversation itself stays end-to-end encrypted."""

    room_id = models.CharField(max_length=255)
    event_id = models.CharField(max_length=255, blank=True)
    contact = models.ForeignKey(Contact, null=True, blank=True, on_delete=models.CASCADE, related_name="conversation_links")
    opportunity = models.ForeignKey(Opportunity, null=True, blank=True, on_delete=models.CASCADE, related_name="conversation_links")

    class Meta:
        ordering = ["-created_at"]
        indexes = [models.Index(fields=["workspace", "room_id"], name="crm_convlink_ws_room")]
        constraints = [
            models.CheckConstraint(condition=Q(contact__isnull=False) | Q(opportunity__isnull=False), name="crm_convlink_has_target"),
            models.UniqueConstraint(fields=["workspace", "room_id", "contact"], condition=Q(contact__isnull=False), name="crm_convlink_unique_contact"),
            models.UniqueConstraint(fields=["workspace", "room_id", "opportunity"], condition=Q(opportunity__isnull=False), name="crm_convlink_unique_opp"),
        ]


class ExternalRecordMapping(TenantModel):
    """Maps an external system's record to an internal one. External IDs are only ever
    stored here, separate from internal (UUID) IDs."""

    provider = models.SlugField(max_length=40)
    external_id = models.CharField(max_length=255)
    object_type = models.CharField(max_length=60, help_text="Internal type label, e.g. crm.contact.")
    object_id = models.UUIDField()
    external_url = models.URLField(blank=True, max_length=500)
    last_synced_at = models.DateTimeField(null=True, blank=True)
    sync_state = models.JSONField(default=dict, blank=True, help_text="Provider cursors/etags; never secrets.")

    class Meta:
        ordering = ["provider", "external_id"]
        constraints = [models.UniqueConstraint(fields=["workspace", "provider", "external_id"], name="crm_extmap_unique")]
        indexes = [models.Index(fields=["workspace", "object_type", "object_id"], name="crm_extmap_object")]


class RecordLink(TenantModel):
    """A typed edge between two tenant records of any registered type (for vertical
    records: contact <-> property, opportunity <-> lending application, ...)."""

    from_type = models.CharField(max_length=60)
    from_id = models.UUIDField()
    to_type = models.CharField(max_length=60)
    to_id = models.UUIDField()
    relation = models.SlugField(max_length=40, default="related")

    class Meta:
        ordering = ["-created_at"]
        constraints = [
            models.UniqueConstraint(fields=["workspace", "from_type", "from_id", "to_type", "to_id", "relation"], name="crm_recordlink_unique"),
        ]
        indexes = [
            models.Index(fields=["workspace", "from_type", "from_id"], name="crm_recordlink_from"),
            models.Index(fields=["workspace", "to_type", "to_id"], name="crm_recordlink_to"),
        ]


# Vertical records (real estate, lending, secure documents) and meeting notes / action items
# live in their own modules of this app; importing them here registers them with Django.
from .models_meetings import ActionItem, MeetingNote  # noqa: E402,F401
from .models_verticals import (  # noqa: E402,F401
    ApplicationBorrower,
    ApplicationNote,
    ChecklistTemplate,
    ClientPreference,
    DocumentAccessLog,
    DocumentChecklistItem,
    DocumentDownloadGrant,
    LendingApplication,
    LendingStageHistory,
    Milestone,
    OpportunityProperty,
    Property,
    PropertyContact,
    SecureDocument,
)
