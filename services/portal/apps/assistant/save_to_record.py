"""“Save to record”: a person copies messages they selected in an end-to-end encrypted
conversation into a note on the record the conversation is linked to.

The server never reads chat: the SPA sends the text the person selected, already
decrypted on their device, and the person was told at that moment that the copy leaves
end-to-end encryption. Allowed only when the workspace turned ``save_to_record_enabled``
on (feature ``save_to_record``, off by default; enforced here, not only in the UI), only
onto a contact or deal the conversation is linked to, and only for roles that may add
timeline entries. The note says it was saved from chat and by whom; the audit log records
the count of messages, never their text.
"""

from __future__ import annotations

from apps.api.errors import ValidationFailed
from apps.api.schema import F, validate
from apps.core.audit import audit
from apps.crm import access, services
from apps.crm import models as m
from apps.crm.services import event_field, room_field

MAX_MESSAGES = 50
MAX_TOTAL = 18000

MESSAGE_SPEC = {
    "event_id": event_field(required=True, blank=False),
    "sender": F.string(max_length=255, required=True, blank=False),
    "sent_at": F.datetime(required=True),
    "text": F.string(max_length=4000, multiline=True, required=True, blank=False),
}
SPEC = {
    "room_id": room_field(required=True, blank=False),
    "contact_id": F.uuid(null=True, default=None),
    "opportunity_id": F.uuid(null=True, default=None),
    "messages": F.list(F.object(max_keys=4), max_items=MAX_MESSAGES, required=True),
}


def save(request, actor, body: dict) -> m.Activity:
    access.require(actor, access.Cap.ACTIVITIES_CREATE, "Your role can't add notes to records.")
    data = validate(body, SPEC)
    if bool(data["contact_id"]) == bool(data["opportunity_id"]):
        raise ValidationFailed(fields={"contact_id": ["Choose the one contact or deal to save to."]})
    if not data["messages"]:
        raise ValidationFailed(fields={"messages": ["Select at least one message."]})
    messages = []
    for i, raw in enumerate(data["messages"]):
        try:
            messages.append(validate(raw, MESSAGE_SPEC))
        except ValidationFailed as exc:
            raise ValidationFailed(fields={f"messages.{i}.{k}": v for k, v in (exc.fields or {}).items()}) from None
    messages.sort(key=lambda x: x["sent_at"])
    if sum(len(x["text"]) for x in messages) > MAX_TOTAL:
        raise ValidationFailed(fields={"messages": [f"That's too much text for one note (at most {MAX_TOTAL} characters)."]})

    if data["contact_id"]:
        target = access.resolve_one(actor, m.Contact, str(data["contact_id"]), field_name="contact_id")
        linked = access.for_actor(actor, m.ConversationLink).filter(room_id=data["room_id"], contact=target).exists()
        target_body = {"contact_id": str(target.pk)}
    else:
        target = access.resolve_one(actor, m.Opportunity, str(data["opportunity_id"]), field_name="opportunity_id")
        linked = access.for_actor(actor, m.ConversationLink).filter(room_id=data["room_id"], opportunity=target).exists()
        target_body = {"opportunity_id": str(target.pk)}
    if not linked:
        raise ValidationFailed(fields={"room_id": ["This conversation isn't linked to that record. Link it first."]})

    who = actor.user.name or actor.user.username
    lines = [f"[{x['sent_at']:%Y-%m-%d %H:%M} UTC] {x['sender']}: {x['text']}" for x in messages]
    note = (
        f"Saved from chat by {who}. These {len(messages)} message(s) were copied out of an end-to-end encrypted "
        "conversation by that person; this copy is stored in the workspace and is not end-to-end encrypted.\n\n" + "\n\n".join(lines)
    )
    activity = services.create_activity(request, actor, {
        "kind": "note", "summary": f"Saved from chat by {who}"[:300], "body": note[:20000],
        "room_id": data["room_id"], "event_id": messages[0]["event_id"], **target_body,
    })
    activity.metadata = {
        "saved_from_chat": True, "saved_by": str(actor.user.public_id), "room_id": data["room_id"],
        "event_ids": [x["event_id"] for x in messages], "message_count": len(messages),
    }
    activity.save(update_fields=["metadata", "updated_at"])
    audit(request, "assistant.save_to_record", target=activity, actor=actor.user,
          metadata={"workspace": str(actor.workspace_id), "message_count": len(messages), "target_type": target._meta.label_lower})
    return activity
