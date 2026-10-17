"""Signal handlers of the CRM app (connected in ``CrmConfig.ready``)."""

from __future__ import annotations

from django.db import transaction
from django.db.models.signals import post_delete
from django.dispatch import receiver

from .models import CalendarEvent
from .models_meetings import MeetingNote
from .models_verticals import SecureDocument


@receiver(post_delete, sender=SecureDocument, dispatch_uid="crm.securedocument.remove_ciphertext")
def _remove_ciphertext(sender, instance: SecureDocument, **kwargs):
    """However a document row goes (its own delete, its application's, a demo reset), its
    ciphertext file goes too, once the deletion is committed."""
    from .documents import remove_sealed

    name = instance.storage_name
    transaction.on_commit(lambda: remove_sealed(name), robust=True)


def _remove_timeline_entries(related_type: str, instance) -> None:
    from .services import timeline_entries_for

    timeline_entries_for(related_type, instance.pk).filter(workspace_id=instance.workspace_id).delete()


@receiver(post_delete, sender=CalendarEvent, dispatch_uid="crm.calendarevent.remove_timeline_entries")
def _remove_event_entries(sender, instance: CalendarEvent, **kwargs):
    """A deleted meeting takes its "Meeting scheduled" entry off the record's timeline."""
    _remove_timeline_entries("crm.calendarevent", instance)


@receiver(post_delete, sender=MeetingNote, dispatch_uid="crm.meetingnote.remove_timeline_entries")
def _remove_note_entries(sender, instance: MeetingNote, **kwargs):
    """Deleted meeting notes (on their own or with their meeting) leave the timeline too."""
    _remove_timeline_entries("crm.meetingnote", instance)
