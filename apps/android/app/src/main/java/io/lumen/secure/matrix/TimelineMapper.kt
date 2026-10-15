package io.lumen.secure.matrix

import io.lumen.secure.core.messaging.DeliveryStates
import io.lumen.secure.core.messaging.SendStateInput
import org.matrix.rustcomponents.sdk.EmbeddedEventDetails
import org.matrix.rustcomponents.sdk.EventOrTransactionId
import org.matrix.rustcomponents.sdk.EventSendState
import org.matrix.rustcomponents.sdk.EventTimelineItem
import org.matrix.rustcomponents.sdk.MembershipChange
import org.matrix.rustcomponents.sdk.MessageType
import org.matrix.rustcomponents.sdk.MsgLikeKind
import org.matrix.rustcomponents.sdk.OtherState
import org.matrix.rustcomponents.sdk.ProfileDetails
import org.matrix.rustcomponents.sdk.ShieldState
import org.matrix.rustcomponents.sdk.TimelineItem
import org.matrix.rustcomponents.sdk.TimelineItemContent
import org.matrix.rustcomponents.sdk.VirtualTimelineItem

/** SDK timeline items → UI rows. Delivery state comes only from the SDK's send state. */
object TimelineMapper {

    fun map(item: TimelineItem, ownUserId: String, strings: TimelineStrings): TimelineRow? {
        val key = item.uniqueId().id
        item.asEvent()?.let { return event(key, it, ownUserId, strings) }
        return when (val v = item.asVirtual()) {
            is VirtualTimelineItem.DateDivider -> TimelineRow.DateDivider(key, v.ts.toLong())
            VirtualTimelineItem.ReadMarker -> TimelineRow.ReadMarker(key)
            VirtualTimelineItem.TimelineStart -> TimelineRow.Start(key)
            null -> null
        }
    }

    /** The SDK's send state, reduced for [DeliveryStates]. */
    fun sendState(isRemote: Boolean, local: EventSendState?): SendStateInput = when (local) {
        null -> if (isRemote) SendStateInput.Remote else SendStateInput.NotSentYet
        is EventSendState.NotSentYet -> SendStateInput.NotSentYet
        is EventSendState.SendingFailed -> SendStateInput.Failed(local.isRecoverable)
        is EventSendState.Sent -> SendStateInput.Sent(local.eventId)
    }

    private fun event(key: String, ev: EventTimelineItem, ownUserId: String, strings: TimelineStrings): TimelineRow.Event? {
        val content = content(ev.content, strings) ?: return null
        val name = senderName(ev.senderProfile) ?: ev.sender
        val shield = try {
            ev.lazyProvider.getShields(false)
        } catch (_: Exception) {
            ShieldState.None
        }
        val reply = (ev.content as? TimelineItemContent.MsgLike)?.content?.inReplyTo?.let { r ->
            when (val d = r.event()) {
                is EmbeddedEventDetails.Ready -> ReplyPreview(r.eventId(), senderName(d.senderProfile) ?: d.sender, content(d.content, strings)?.let(::shortText))
                else -> ReplyPreview(r.eventId(), null, null)
            }
        }
        val edited = ((ev.content as? TimelineItemContent.MsgLike)?.content?.kind as? MsgLikeKind.Message)?.content?.isEdited == true
        return TimelineRow.Event(
            key = key,
            id = ev.eventOrTransactionId,
            eventId = (ev.eventOrTransactionId as? EventOrTransactionId.EventId)?.eventId,
            senderId = ev.sender,
            senderName = name,
            isOwn = ev.isOwn,
            timestamp = ev.timestamp.toLong(),
            content = content,
            reactions = ev.reactions.map { r -> ReactionUi(r.key, r.senders.size, r.senders.any { it.senderId == ownUserId }) },
            replyTo = reply,
            delivery = DeliveryStates.map(ev.isOwn, sendState(ev.isRemote, ev.localSendState), ev.readReceipts.keys, ownUserId),
            edited = edited,
            editable = ev.isEditable,
            canReply = ev.canBeRepliedTo,
            shield = when (shield) {
                is ShieldState.Red -> ShieldUi.ALERT
                is ShieldState.Grey -> ShieldUi.WARNING
                ShieldState.None -> ShieldUi.NONE
            },
            shieldReason = when (shield) {
                is ShieldState.Red -> shield.code.name
                is ShieldState.Grey -> shield.code.name
                ShieldState.None -> null
            },
        )
    }

    fun senderName(p: ProfileDetails): String? = (p as? ProfileDetails.Ready)?.displayName?.takeIf { it.isNotBlank() }

    fun content(c: TimelineItemContent, s: TimelineStrings): RowContent? = when (c) {
        is TimelineItemContent.MsgLike -> when (val k = c.content.kind) {
            is MsgLikeKind.Message -> message(k.content.msgType, k.content.body)
            is MsgLikeKind.Sticker -> RowContent.Image(k.source, null, k.body, null, k.info.mimetype, k.info.width?.toLong(), k.info.height?.toLong())
            is MsgLikeKind.Poll -> RowContent.Unsupported(s.poll(k.question))
            MsgLikeKind.Redacted -> RowContent.Redacted
            is MsgLikeKind.UnableToDecrypt -> RowContent.UnableToDecrypt
            is MsgLikeKind.Other -> null
            is MsgLikeKind.LiveLocation -> RowContent.Unsupported(s.unsupported)
        }
        TimelineItemContent.CallInvite -> RowContent.Call(active = false)
        is TimelineItemContent.RtcNotification -> RowContent.Call(active = c.activeMembers.isNotEmpty())
        is TimelineItemContent.RoomMembership -> {
            val who = c.userDisplayName ?: c.userId
            when (c.change) {
                MembershipChange.JOINED, MembershipChange.INVITATION_ACCEPTED -> RowContent.StateText(s.joined(who))
                MembershipChange.LEFT, MembershipChange.KICKED, MembershipChange.BANNED, MembershipChange.KICKED_AND_BANNED -> RowContent.StateText(s.left(who))
                MembershipChange.INVITED -> RowContent.StateText(s.invited(who))
                null, MembershipChange.NONE, MembershipChange.NOT_IMPLEMENTED, MembershipChange.ERROR -> null
                else -> RowContent.StateText(s.membershipChanged(who))
            }
        }
        is TimelineItemContent.ProfileChange -> c.displayName?.let { RowContent.StateText(s.nameChanged(it)) }
        is TimelineItemContent.State -> when (val o = c.content) {
            is OtherState.RoomName -> o.name?.let { RowContent.StateText(s.roomNamed(it)) }
            is OtherState.RoomTopic -> RowContent.StateText(s.topicChanged)
            OtherState.RoomEncryption -> RowContent.StateText(s.encryptionEnabled)
            is OtherState.RoomCreate -> RowContent.StateText(s.roomCreated)
            else -> null
        }
        is TimelineItemContent.FailedToParseMessageLike, is TimelineItemContent.FailedToParseState -> null
    }

    private fun message(t: MessageType, body: String): RowContent = when (t) {
        is MessageType.Text -> RowContent.Text(t.content.body)
        is MessageType.Notice -> RowContent.Notice(t.content.body)
        is MessageType.Emote -> RowContent.Emote(t.content.body)
        is MessageType.Image -> RowContent.Image(
            t.content.source, t.content.info?.thumbnailSource, t.content.filename, t.content.caption,
            t.content.info?.mimetype, t.content.info?.width?.toLong(), t.content.info?.height?.toLong(),
        )
        is MessageType.File -> RowContent.File(t.content.source, t.content.filename, t.content.caption, t.content.info?.mimetype, t.content.info?.size?.toLong(), FileKind.FILE)
        is MessageType.Video -> RowContent.File(t.content.source, t.content.filename, t.content.caption, t.content.info?.mimetype, t.content.info?.size?.toLong(), FileKind.VIDEO)
        is MessageType.Audio -> RowContent.File(t.content.source, t.content.filename, t.content.caption, t.content.info?.mimetype, t.content.info?.size?.toLong(), FileKind.AUDIO)
        is MessageType.Location -> RowContent.Text(body)
        is MessageType.Gallery -> RowContent.Text(body)
        is MessageType.Other -> RowContent.Text(t.body)
    }

    /** One-line preview for the room list. */
    fun previewText(c: TimelineItemContent, s: TimelineStrings): String? = content(c, s)?.let { rc ->
        when (rc) {
            is RowContent.Image -> rc.caption ?: s.image
            is RowContent.File -> rc.caption ?: when (rc.kind) {
                FileKind.FILE -> s.file
                FileKind.VIDEO -> s.video
                FileKind.AUDIO -> s.audio
            }
            RowContent.Redacted -> s.deleted
            RowContent.UnableToDecrypt -> s.unableToDecrypt
            is RowContent.Call -> s.callStarted
            else -> shortText(rc)
        }
    }

    private fun shortText(rc: RowContent): String? = when (rc) {
        is RowContent.StateText -> rc.text
        is RowContent.Unsupported -> rc.text
        else -> rc.searchableText
    }?.replace('\n', ' ')?.take(200)
}
