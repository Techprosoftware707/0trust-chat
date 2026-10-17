"""Signal handlers of the CRM app (connected in ``CrmConfig.ready``)."""

from __future__ import annotations

from django.db import transaction
from django.db.models.signals import post_delete
from django.dispatch import receiver

from .models_verticals import SecureDocument


@receiver(post_delete, sender=SecureDocument, dispatch_uid="crm.securedocument.remove_ciphertext")
def _remove_ciphertext(sender, instance: SecureDocument, **kwargs):
    """However a document row goes (its own delete, its application's, a demo reset), its
    ciphertext file goes too, once the deletion is committed."""
    from .documents import remove_sealed

    name = instance.storage_name
    transaction.on_commit(lambda: remove_sealed(name), robust=True)
