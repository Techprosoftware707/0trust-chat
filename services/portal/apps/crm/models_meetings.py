"""Meeting notes and action items.

Notes are written explicitly by a person (they are not chat or call content: calls and
messages stay end-to-end encrypted, and there is no recording or transcription). An action
item is a *proposal* (from a teammate or, later, the AI assistant) until a person confirms it,
which creates a real ``Task`` ("review suggested next steps").
"""

from __future__ import annotations

from django.conf import settings
from django.db import models

from .models import CalendarEvent, Contact, Opportunity, Task, TenantModel

USER = settings.AUTH_USER_MODEL


class MeetingNote(TenantModel):
    class Visibility(models.TextChoices):
        TEAM = "team", "Shared with the team"
        ATTENDEES = "attendees", "Meeting attendees (and managers)"
        PRIVATE = "private", "Only me (and managers)"

    event = models.ForeignKey(CalendarEvent, null=True, blank=True, on_delete=models.CASCADE, related_name="notes")
    contact = models.ForeignKey(Contact, null=True, blank=True, on_delete=models.SET_NULL, related_name="meeting_notes")
    opportunity = models.ForeignKey(Opportunity, null=True, blank=True, on_delete=models.SET_NULL, related_name="meeting_notes")
    # The Matrix room the meeting happened in (ID only; the call itself is end-to-end encrypted).
    room_id = models.CharField(max_length=255, blank=True)
    title = models.CharField(max_length=200)
    body = models.TextField(blank=True, max_length=20000)
    visibility = models.CharField(max_length=10, choices=Visibility.choices, default=Visibility.TEAM)

    class Meta:
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["workspace", "-created_at"], name="crm_mnote_ws_created"),
            models.Index(fields=["event", "-created_at"], name="crm_mnote_event"),
        ]


class ActionItem(TenantModel):
    class Status(models.TextChoices):
        PROPOSED = "proposed", "Proposed"
        CONFIRMED = "confirmed", "Confirmed (task created)"
        DISMISSED = "dismissed", "Dismissed"

    class Source(models.TextChoices):
        MANUAL = "manual", "A teammate"
        AI_SUGGESTION = "ai_suggestion", "AI suggestion"

    note = models.ForeignKey(MeetingNote, null=True, blank=True, on_delete=models.CASCADE, related_name="action_items")
    event = models.ForeignKey(CalendarEvent, null=True, blank=True, on_delete=models.CASCADE, related_name="action_items")
    contact = models.ForeignKey(Contact, null=True, blank=True, on_delete=models.SET_NULL, related_name="action_items")
    opportunity = models.ForeignKey(Opportunity, null=True, blank=True, on_delete=models.SET_NULL, related_name="action_items")
    title = models.CharField(max_length=200)
    description = models.TextField(blank=True, max_length=2000)
    suggested_assignee = models.ForeignKey(USER, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    suggested_due_at = models.DateTimeField(null=True, blank=True)
    status = models.CharField(max_length=10, choices=Status.choices, default=Status.PROPOSED)
    source = models.CharField(max_length=20, choices=Source.choices, default=Source.MANUAL)
    decided_by = models.ForeignKey(USER, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    decided_at = models.DateTimeField(null=True, blank=True)
    task = models.ForeignKey(Task, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")

    class Meta:
        ordering = ["status", "-created_at"]
        indexes = [
            models.Index(fields=["workspace", "status", "-created_at"], name="crm_aitem_ws_status"),
            models.Index(fields=["event"], name="crm_aitem_event"),
            models.Index(fields=["note"], name="crm_aitem_note"),
        ]
