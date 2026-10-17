"""Vertical business records: real estate (properties, client preferences, deal milestones and
deadlines) and lending (applications, document checklists, encrypted documents).

Same rules as every tenant model (see ``models.py``): ``TenantModel`` base, read only through
``apps.crm.access`` (policies in ``policies_verticals.py``), every write audited.

Honesty rules baked into the data model:

* ``Property.source`` says where a listing came from. ``manual`` is the default; anything
  imported is labelled (``source_detail``). Nexus has no MLS access and never invents listings.
* Lending decisions (``LendingApplication.decision``) are only ever recorded by an authorised
  person through ``lending.record_decision``; nothing approves or rejects automatically.
* ``SecureDocument`` rows hold metadata only. The contents are encrypted at rest (AES-256-GCM,
  ``documents.py``) in a directory outside every public, static and media path, and never go
  into logs, search, notifications, analytics or the AI assistant.
"""

from __future__ import annotations

from django.conf import settings
from django.db import models
from django.db.models import Q
from django.utils import timezone

from .models import CalendarEvent, Contact, Opportunity, Pipeline, Stage, Task, TenantModel, Visibility

USER = settings.AUTH_USER_MODEL


# --- real estate ------------------------------------------------------------------------------


class Property(TenantModel):
    class Status(models.TextChoices):
        PROSPECT = "prospect", "Prospect (not listed yet)"
        COMING_SOON = "coming_soon", "Coming soon"
        ACTIVE = "active", "Active"
        UNDER_CONTRACT = "under_contract", "Under contract"
        SOLD = "sold", "Sold"
        LEASED = "leased", "Leased"
        WITHDRAWN = "withdrawn", "Withdrawn"
        OFF_MARKET = "off_market", "Off market"

    class ListingType(models.TextChoices):
        SALE = "sale", "For sale"
        RENT = "rent", "For rent"

    class PropertyType(models.TextChoices):
        HOUSE = "house", "House"
        CONDO = "condo", "Condo / apartment"
        TOWNHOUSE = "townhouse", "Townhouse"
        MULTI_FAMILY = "multi_family", "Multi-family"
        LAND = "land", "Land"
        COMMERCIAL = "commercial", "Commercial"
        OTHER = "other", "Other"

    class AreaUnit(models.TextChoices):
        SQFT = "sqft", "sq ft"
        SQM = "sqm", "m²"

    class Source(models.TextChoices):
        MANUAL = "manual", "Entered by hand"
        IMPORT = "import", "Imported (labelled)"
        INTEGRATION = "integration", "From a connected service"

    address_line1 = models.CharField(max_length=200)
    address_line2 = models.CharField(max_length=200, blank=True)
    city = models.CharField(max_length=100, blank=True)
    region = models.CharField(max_length=100, blank=True, help_text="State, province or county.")
    postal_code = models.CharField(max_length=20, blank=True)
    country = models.CharField(max_length=2, default="US")
    listing_type = models.CharField(max_length=10, choices=ListingType.choices, default=ListingType.SALE)
    property_type = models.CharField(max_length=20, choices=PropertyType.choices, default=PropertyType.HOUSE)
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.PROSPECT)
    list_price = models.DecimalField(max_digits=14, decimal_places=2, null=True, blank=True)
    currency = models.CharField(max_length=3, default="USD")
    bedrooms = models.PositiveSmallIntegerField(null=True, blank=True)
    bathrooms = models.DecimalField(max_digits=4, decimal_places=1, null=True, blank=True)
    area = models.PositiveIntegerField(null=True, blank=True)
    area_unit = models.CharField(max_length=4, choices=AreaUnit.choices, default=AreaUnit.SQFT)
    year_built = models.PositiveSmallIntegerField(null=True, blank=True)
    headline = models.CharField(max_length=200, blank=True)
    description = models.TextField(blank=True, max_length=5000, help_text="Listing details as written by the team.")
    listed_at = models.DateField(null=True, blank=True)
    notes = models.TextField(blank=True, max_length=5000, help_text="Internal notes, never published.")
    source = models.CharField(max_length=20, choices=Source.choices, default=Source.MANUAL)
    source_detail = models.CharField(max_length=200, blank=True, help_text="Label of the import or service it came from.")
    owner = models.ForeignKey(USER, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    visibility = models.CharField(max_length=10, choices=Visibility.choices, default=Visibility.TEAM)
    archived_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-updated_at"]
        verbose_name_plural = "properties"
        indexes = [
            models.Index(fields=["workspace", "status"], name="crm_prop_ws_status"),
            models.Index(fields=["workspace", "-updated_at"], name="crm_prop_ws_updated"),
            models.Index(fields=["workspace", "owner"], name="crm_prop_ws_owner"),
            models.Index(fields=["workspace", "city"], name="crm_prop_ws_city"),
        ]

    @property
    def display_name(self) -> str:
        parts = [self.address_line1, self.city]
        return ", ".join(p for p in parts if p) or "Unnamed property"

    def __str__(self) -> str:
        return self.display_name


class PropertyContact(TenantModel):
    """A person's relationship to a property (seller, buyer, landlord, tenant, interested)."""

    class Role(models.TextChoices):
        SELLER = "seller", "Seller"
        BUYER = "buyer", "Buyer"
        LANDLORD = "landlord", "Landlord"
        TENANT = "tenant", "Tenant"
        INTERESTED = "interested", "Interested buyer"
        OTHER = "other", "Other"

    property = models.ForeignKey(Property, on_delete=models.CASCADE, related_name="contact_links")
    contact = models.ForeignKey(Contact, on_delete=models.CASCADE, related_name="property_links")
    role = models.CharField(max_length=20, choices=Role.choices, default=Role.INTERESTED)

    class Meta:
        ordering = ["role", "created_at"]
        constraints = [models.UniqueConstraint(fields=["property", "contact", "role"], name="crm_propcontact_unique")]
        indexes = [models.Index(fields=["workspace", "contact"], name="crm_propcontact_contact")]


class OpportunityProperty(TenantModel):
    """A property a deal is about: the listing we sell, the home a buyer purchases, or one
    they are considering."""

    class Role(models.TextChoices):
        LISTING = "listing", "Listing (we represent the seller)"
        PURCHASE = "purchase", "Purchase"
        CONSIDERING = "considering", "Considering"
        OTHER = "other", "Other"

    opportunity = models.ForeignKey(Opportunity, on_delete=models.CASCADE, related_name="property_links")
    property = models.ForeignKey(Property, on_delete=models.CASCADE, related_name="opportunity_links")
    role = models.CharField(max_length=20, choices=Role.choices, default=Role.PURCHASE)

    class Meta:
        ordering = ["created_at"]
        constraints = [models.UniqueConstraint(fields=["opportunity", "property"], name="crm_oppprop_unique")]
        indexes = [models.Index(fields=["workspace", "property"], name="crm_oppprop_property")]


class ClientPreference(TenantModel):
    """What a buyer or tenant is looking for (one set per contact)."""

    class Timeline(models.TextChoices):
        ASAP = "asap", "As soon as possible"
        WITHIN_3_MONTHS = "within_3_months", "Within 3 months"
        WITHIN_6_MONTHS = "within_6_months", "Within 6 months"
        WITHIN_12_MONTHS = "within_12_months", "Within a year"
        FLEXIBLE = "flexible", "Flexible"

    contact = models.OneToOneField(Contact, on_delete=models.CASCADE, related_name="preferences")
    listing_type = models.CharField(max_length=10, choices=Property.ListingType.choices, default=Property.ListingType.SALE)
    budget_min = models.DecimalField(max_digits=14, decimal_places=2, null=True, blank=True)
    budget_max = models.DecimalField(max_digits=14, decimal_places=2, null=True, blank=True)
    currency = models.CharField(max_length=3, default="USD")
    areas = models.JSONField(default=list, blank=True, help_text="Neighbourhoods, towns or postcodes.")
    property_types = models.JSONField(default=list, blank=True)
    bedrooms_min = models.PositiveSmallIntegerField(null=True, blank=True)
    bathrooms_min = models.DecimalField(max_digits=4, decimal_places=1, null=True, blank=True)
    area_min = models.PositiveIntegerField(null=True, blank=True)
    must_haves = models.JSONField(default=list, blank=True)
    nice_to_haves = models.JSONField(default=list, blank=True)
    timeline = models.CharField(max_length=20, choices=Timeline.choices, blank=True)
    move_by = models.DateField(null=True, blank=True)
    notes = models.TextField(blank=True, max_length=2000)

    class Meta:
        ordering = ["-updated_at"]


# --- lending ---------------------------------------------------------------------------------


class LendingApplication(TenantModel):
    """A loan application moving through a lending pipeline (``Pipeline.kind == "lending"``).

    Sensitive: visible to owners, admins and managers (``Cap.LENDING_SENSITIVE``) and to the
    assigned broker / loan officer only. ``decision`` is recorded by authorised staff; the
    system never sets it."""

    class ProductType(models.TextChoices):
        PURCHASE = "purchase", "Purchase mortgage"
        REFINANCE = "refinance", "Refinance"
        CASH_OUT = "cash_out_refinance", "Cash-out refinance"
        HOME_EQUITY = "home_equity", "Home equity"
        CONSTRUCTION = "construction", "Construction"
        BRIDGE = "bridge", "Bridge loan"
        COMMERCIAL = "commercial", "Commercial"
        PERSONAL = "personal", "Personal loan"
        OTHER = "other", "Other"

    class Status(models.TextChoices):
        ACTIVE = "active", "Active"
        ON_HOLD = "on_hold", "On hold"
        WITHDRAWN = "withdrawn", "Withdrawn"
        COMPLETED = "completed", "Completed"

    class Decision(models.TextChoices):
        NONE = "", "No decision recorded"
        APPROVED = "approved", "Approved (recorded by staff)"
        CONDITIONAL = "conditional", "Approved with conditions (recorded by staff)"
        DECLINED = "declined", "Declined (recorded by staff)"

    reference = models.CharField(max_length=20)
    title = models.CharField(max_length=160)
    pipeline = models.ForeignKey(Pipeline, on_delete=models.RESTRICT, related_name="lending_applications")
    stage = models.ForeignKey(Stage, on_delete=models.RESTRICT, related_name="lending_applications")
    stage_entered_at = models.DateTimeField(default=timezone.now)
    position = models.FloatField(default=0)
    borrowers = models.ManyToManyField(Contact, through="ApplicationBorrower", blank=True, related_name="lending_applications")
    loan_officer = models.ForeignKey(USER, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    product_type = models.CharField(max_length=30, choices=ProductType.choices, default=ProductType.PURCHASE)
    amount_requested = models.DecimalField(max_digits=14, decimal_places=2, null=True, blank=True)
    currency = models.CharField(max_length=3, default="USD")
    status = models.CharField(max_length=12, choices=Status.choices, default=Status.ACTIVE)
    decision = models.CharField(max_length=12, choices=Decision.choices, blank=True, default="")
    decision_note = models.TextField(blank=True, max_length=2000)
    decision_by = models.ForeignKey(USER, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    decision_at = models.DateTimeField(null=True, blank=True)
    opportunity = models.ForeignKey(Opportunity, null=True, blank=True, on_delete=models.SET_NULL, related_name="lending_applications")
    property = models.ForeignKey(Property, null=True, blank=True, on_delete=models.SET_NULL, related_name="lending_applications")
    target_close_date = models.DateField(null=True, blank=True)
    source = models.CharField(max_length=60, blank=True)

    class Meta:
        ordering = ["position", "-updated_at"]
        constraints = [models.UniqueConstraint(fields=["workspace", "reference"], name="crm_lendapp_unique_ref")]
        indexes = [
            models.Index(fields=["workspace", "stage"], name="crm_lendapp_ws_stage"),
            models.Index(fields=["workspace", "loan_officer"], name="crm_lendapp_ws_officer"),
            models.Index(fields=["workspace", "-updated_at"], name="crm_lendapp_ws_updated"),
            models.Index(fields=["pipeline", "stage", "position"], name="crm_lendapp_board"),
        ]

    def __str__(self) -> str:
        return f"{self.reference} {self.title}"


class ApplicationBorrower(TenantModel):
    class Role(models.TextChoices):
        BORROWER = "borrower", "Borrower"
        CO_BORROWER = "co_borrower", "Co-borrower"
        GUARANTOR = "guarantor", "Guarantor"

    application = models.ForeignKey(LendingApplication, on_delete=models.CASCADE, related_name="borrower_links")
    contact = models.ForeignKey(Contact, on_delete=models.CASCADE, related_name="borrower_links")
    role = models.CharField(max_length=20, choices=Role.choices, default=Role.BORROWER)

    class Meta:
        ordering = ["created_at"]
        constraints = [models.UniqueConstraint(fields=["application", "contact"], name="crm_appborrower_unique")]
        indexes = [models.Index(fields=["workspace", "contact"], name="crm_appborrower_contact")]


class LendingStageHistory(TenantModel):
    application = models.ForeignKey(LendingApplication, on_delete=models.CASCADE, related_name="stage_history")
    from_stage = models.ForeignKey(Stage, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    to_stage = models.ForeignKey(Stage, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    from_name = models.CharField(max_length=80, blank=True)
    to_name = models.CharField(max_length=80, blank=True)

    class Meta:
        ordering = ["-created_at"]
        indexes = [models.Index(fields=["application", "-created_at"], name="crm_lendhist_app")]


class ApplicationNote(TenantModel):
    """Internal note on an application, never shown to the borrower."""

    class Visibility(models.TextChoices):
        STAFF = "staff", "Everyone working on this application"
        MANAGERS = "managers", "Owners, admins and managers only"
        PRIVATE = "private", "Only me (and owners, admins, managers)"

    application = models.ForeignKey(LendingApplication, on_delete=models.CASCADE, related_name="notes")
    body = models.TextField(max_length=5000)
    visibility = models.CharField(max_length=10, choices=Visibility.choices, default=Visibility.STAFF)

    class Meta:
        ordering = ["-created_at"]
        indexes = [models.Index(fields=["application", "-created_at"], name="crm_appnote_app")]


class ChecklistTemplate(TenantModel):
    """Document checklist template for a loan product (customisable per workspace)."""

    name = models.CharField(max_length=120)
    product_type = models.CharField(max_length=30, choices=LendingApplication.ProductType.choices, blank=True,
                                    help_text="Empty: any product.")
    items = models.JSONField(default=list, blank=True, help_text="[{name, required, description, due_in_days}]")
    archived = models.BooleanField(default=False)

    class Meta:
        ordering = ["product_type", "name"]
        constraints = [models.UniqueConstraint(fields=["workspace", "name"], name="crm_checklisttpl_unique_name")]


class DocumentChecklistItem(TenantModel):
    class Status(models.TextChoices):
        PENDING = "pending", "Not requested yet"
        REQUESTED = "requested", "Requested"
        RECEIVED = "received", "Received"
        ACCEPTED = "accepted", "Accepted"
        REJECTED = "rejected", "Rejected"
        WAIVED = "waived", "Waived"

    # Required items in these states are still outstanding ("missing documents").
    OUTSTANDING = (Status.PENDING, Status.REQUESTED, Status.REJECTED)

    application = models.ForeignKey(LendingApplication, on_delete=models.CASCADE, related_name="checklist")
    name = models.CharField(max_length=160)
    description = models.CharField(max_length=500, blank=True)
    required = models.BooleanField(default=True)
    status = models.CharField(max_length=12, choices=Status.choices, default=Status.PENDING)
    due_date = models.DateField(null=True, blank=True)
    requested_at = models.DateTimeField(null=True, blank=True)
    requested_by = models.ForeignKey(USER, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    received_at = models.DateTimeField(null=True, blank=True)
    reviewed_at = models.DateTimeField(null=True, blank=True)
    reviewed_by = models.ForeignKey(USER, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    internal_note = models.TextField(blank=True, max_length=2000)
    position = models.IntegerField(default=0)
    task = models.ForeignKey(Task, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")

    class Meta:
        ordering = ["position", "created_at"]
        indexes = [
            models.Index(fields=["application", "status"], name="crm_checkitem_app_status"),
            models.Index(fields=["workspace", "status", "due_date"], name="crm_checkitem_ws_status"),
        ]

    @property
    def is_outstanding(self) -> bool:
        return self.required and self.status in self.OUTSTANDING


class SecureDocument(TenantModel):
    """Metadata of an encrypted document. The ciphertext lives in
    ``settings.NEXUS_SECURE_DOCUMENTS_DIR`` (never a public, static or media path) under the
    random ``storage_name``; ``wrapped_key`` is the per-document data key encrypted with the
    workspace-independent master key ``key_id`` (see ``documents.py``)."""

    application = models.ForeignKey(LendingApplication, on_delete=models.CASCADE, related_name="documents")
    checklist_item = models.ForeignKey(DocumentChecklistItem, null=True, blank=True, on_delete=models.SET_NULL, related_name="documents")
    original_name = models.CharField(max_length=200)
    content_type = models.CharField(max_length=100)
    size = models.PositiveIntegerField(help_text="Plaintext size in bytes.")
    storage_name = models.CharField(max_length=80, unique=True)
    key_id = models.CharField(max_length=32)
    wrapped_key = models.CharField(max_length=200)

    class Meta:
        ordering = ["-created_at"]
        indexes = [models.Index(fields=["application", "-created_at"], name="crm_securedoc_app")]


class DocumentDownloadGrant(TenantModel):
    """One short-lived, single-use download permission for one user and one document. The
    signed token handed to the client names this row; the row is what makes it single-use
    and revocable."""

    document = models.ForeignKey(SecureDocument, on_delete=models.CASCADE, related_name="grants")
    user = models.ForeignKey(USER, on_delete=models.CASCADE, related_name="+")
    expires_at = models.DateTimeField()
    used_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-created_at"]
        indexes = [models.Index(fields=["workspace", "expires_at"], name="crm_docgrant_ws_expires")]


class DocumentAccessLog(TenantModel):
    """Who uploaded, downloaded or deleted which document (visible to managers). Mirrors the
    hash-chained audit log in a form the UI can list per application."""

    class Action(models.TextChoices):
        UPLOAD = "upload", "Uploaded"
        GRANT = "grant", "Download link issued"
        DOWNLOAD = "download", "Downloaded"
        DENIED = "denied", "Download refused"
        DELETE = "delete", "Deleted"

    application = models.ForeignKey(LendingApplication, on_delete=models.CASCADE, related_name="document_log")
    document = models.ForeignKey(SecureDocument, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    document_name = models.CharField(max_length=200, blank=True)
    user = models.ForeignKey(USER, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    action = models.CharField(max_length=10, choices=Action.choices)
    reason = models.CharField(max_length=60, blank=True)

    class Meta:
        ordering = ["-created_at"]
        indexes = [models.Index(fields=["application", "-created_at"], name="crm_doclog_app")]


# --- milestones and deadlines (deals and applications) --------------------------------------------


class Milestone(TenantModel):
    """An offer/negotiation milestone or a transaction deadline of a deal or a lending
    application (inspection, appraisal, financing, closing...)."""

    class Category(models.TextChoices):
        MILESTONE = "milestone", "Milestone"
        DEADLINE = "deadline", "Deadline"

    class Type(models.TextChoices):
        OFFER_SUBMITTED = "offer_submitted", "Offer submitted"
        COUNTER_OFFER = "counter_offer", "Counter-offer"
        OFFER_ACCEPTED = "offer_accepted", "Offer accepted"
        NEGOTIATION = "negotiation", "Negotiation"
        EARNEST_MONEY = "earnest_money", "Earnest money"
        INSPECTION = "inspection", "Inspection"
        APPRAISAL = "appraisal", "Appraisal"
        FINANCING = "financing", "Financing contingency"
        TITLE = "title", "Title"
        FINAL_WALKTHROUGH = "final_walkthrough", "Final walk-through"
        CLOSING = "closing", "Closing"
        APPLICATION = "application", "Application"
        DISCLOSURES = "disclosures", "Disclosures"
        CONDITIONS = "conditions", "Conditions"
        RATE_LOCK = "rate_lock", "Rate lock"
        DOCUMENTS = "documents", "Documents"
        CUSTOM = "custom", "Other"

    class Status(models.TextChoices):
        PENDING = "pending", "Pending"
        DONE = "done", "Done"
        WAIVED = "waived", "Waived"
        MISSED = "missed", "Missed"

    category = models.CharField(max_length=10, choices=Category.choices, default=Category.DEADLINE)
    milestone_type = models.CharField(max_length=20, choices=Type.choices, default=Type.CUSTOM)
    title = models.CharField(max_length=160)
    due_date = models.DateField(null=True, blank=True)
    status = models.CharField(max_length=10, choices=Status.choices, default=Status.PENDING)
    completed_at = models.DateTimeField(null=True, blank=True)
    completed_by = models.ForeignKey(USER, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    amount = models.DecimalField(max_digits=14, decimal_places=2, null=True, blank=True, help_text="E.g. the offer price.")
    currency = models.CharField(max_length=3, default="USD")
    notes = models.TextField(blank=True, max_length=2000)
    responsible = models.ForeignKey(USER, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    opportunity = models.ForeignKey(Opportunity, null=True, blank=True, on_delete=models.CASCADE, related_name="milestones")
    application = models.ForeignKey(LendingApplication, null=True, blank=True, on_delete=models.CASCADE, related_name="milestones")
    position = models.IntegerField(default=0)

    class Meta:
        ordering = ["due_date", "position", "created_at"]
        constraints = [
            models.CheckConstraint(
                condition=(Q(opportunity__isnull=False) & Q(application__isnull=True)) | (Q(opportunity__isnull=True) & Q(application__isnull=False)),
                name="crm_milestone_one_parent",
            ),
        ]
        indexes = [
            models.Index(fields=["workspace", "status", "due_date"], name="crm_milestone_ws_due"),
            models.Index(fields=["opportunity", "due_date"], name="crm_milestone_opp"),
            models.Index(fields=["application", "due_date"], name="crm_milestone_app"),
        ]

    @property
    def is_open(self) -> bool:
        return self.status == self.Status.PENDING


# Re-exported for type hints in the services.
__all__ = [
    "ApplicationBorrower", "ApplicationNote", "CalendarEvent", "ChecklistTemplate", "ClientPreference", "DocumentAccessLog",
    "DocumentChecklistItem", "DocumentDownloadGrant", "LendingApplication", "LendingStageHistory", "Milestone",
    "OpportunityProperty", "Property", "PropertyContact", "SecureDocument",
]
