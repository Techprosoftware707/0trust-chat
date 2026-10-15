package io.lumen.secure.push

import io.lumen.secure.calls.IncomingRing
import io.lumen.secure.core.notifications.NotificationPreview
import io.lumen.secure.core.notifications.NotificationPreviewPolicy
import io.lumen.secure.core.notifications.NotificationText
import io.lumen.secure.core.notifications.PreviewStrings
import org.matrix.rustcomponents.sdk.MessageLikeEventContent
import org.matrix.rustcomponents.sdk.MessageType
import org.matrix.rustcomponents.sdk.NotificationEvent
import org.matrix.rustcomponents.sdk.NotificationItem
import org.matrix.rustcomponents.sdk.RtcCallIntent
import org.matrix.rustcomponents.sdk.RtcNotificationType
import org.matrix.rustcomponents.sdk.TimelineEventContent

/** What a decrypted [NotificationItem] becomes. */
sealed interface NotificationAction {
    data class Message(val text: NotificationText, val noisy: Boolean) : NotificationAction
    data class Ring(val ring: IncomingRing) : NotificationAction
    data object Nothing : NotificationAction
}

object NotificationRenderer {
    fun render(
        item: NotificationItem,
        roomId: String,
        eventId: String,
        ownUserId: String,
        policy: NotificationPreview,
        strings: PreviewStrings,
        nowMillis: Long,
    ): NotificationAction {
        val sender = item.senderInfo.displayName
        val room = item.roomInfo.displayName
        val direct = item.roomInfo.isDirect
        return when (val ev = item.event) {
            is NotificationEvent.Invite -> NotificationAction.Message(NotificationPreviewPolicy.invite(policy, strings, sender), true)
            is NotificationEvent.Timeline -> {
                val e = ev.event
                if (e.senderId() == ownUserId) return NotificationAction.Nothing
                val content = try {
                    e.content()
                } catch (_: Exception) {
                    return NotificationAction.Message(NotificationPreviewPolicy.message(policy, strings, sender, room, direct, null), true)
                }
                val msg = (content as? TimelineEventContent.MessageLike)?.content ?: return NotificationAction.Nothing
                when (msg) {
                    is MessageLikeEventContent.RoomMessage -> NotificationAction.Message(
                        NotificationPreviewPolicy.message(policy, strings, sender, room, direct, body(msg.messageType)),
                        item.isNoisy != false,
                    )
                    is MessageLikeEventContent.RtcNotification ->
                        if (msg.notificationType == RtcNotificationType.RING && msg.expirationTs.toLong() > nowMillis) {
                            NotificationAction.Ring(
                                IncomingRing(
                                    roomId = roomId,
                                    notificationEventId = eventId,
                                    callerName = sender,
                                    roomName = room,
                                    isDirect = direct,
                                    video = msg.callIntent == RtcCallIntent.VIDEO,
                                    expiresAtMillis = msg.expirationTs.toLong(),
                                ),
                            )
                        } else {
                            NotificationAction.Message(NotificationPreviewPolicy.call(policy, strings, sender), true)
                        }
                    MessageLikeEventContent.RoomEncrypted ->
                        NotificationAction.Message(NotificationPreviewPolicy.message(policy, strings, sender, room, direct, null), true)
                    is MessageLikeEventContent.Poll, MessageLikeEventContent.Sticker ->
                        NotificationAction.Message(NotificationPreviewPolicy.message(policy, strings, sender, room, direct, null), true)
                    else -> NotificationAction.Nothing
                }
            }
        }
    }

    private fun body(t: MessageType): String? = when (t) {
        is MessageType.Text -> t.content.body
        is MessageType.Notice -> t.content.body
        is MessageType.Emote -> t.content.body
        else -> null // media: the policy falls back to "New message"
    }
}
