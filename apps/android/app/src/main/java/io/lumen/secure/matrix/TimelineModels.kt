package io.lumen.secure.matrix

import io.lumen.secure.core.messaging.DeliveryState
import org.matrix.rustcomponents.sdk.EventOrTransactionId
import org.matrix.rustcomponents.sdk.MediaSource

/** Localised strings the Matrix layer needs (previews, state events), built from resources. */
data class TimelineStrings(
    val unnamedRoom: String,
    val deleted: String,
    val unableToDecrypt: String,
    val image: String,
    val file: String,
    val video: String,
    val audio: String,
    val sticker: String,
    val poll: (String) -> String,
    val unsupported: String,
    val callStarted: String,
    val joined: (String) -> String,
    val left: (String) -> String,
    val invited: (String) -> String,
    val membershipChanged: (String) -> String,
    val nameChanged: (String) -> String,
    val roomNamed: (String) -> String,
    val topicChanged: String,
    val encryptionEnabled: String,
    val roomCreated: String,
)

sealed interface RowContent {
    data class Text(val body: String) : RowContent
    data class Notice(val body: String) : RowContent
    data class Emote(val body: String) : RowContent
    data class Image(val source: MediaSource, val thumbnail: MediaSource?, val filename: String, val caption: String?, val mimeType: String?, val width: Long?, val height: Long?) : RowContent
    data class File(val source: MediaSource, val filename: String, val caption: String?, val mimeType: String?, val size: Long?, val kind: FileKind) : RowContent
    data object Redacted : RowContent
    data object UnableToDecrypt : RowContent
    data class Call(val active: Boolean) : RowContent
    data class StateText(val text: String) : RowContent
    data class Unsupported(val text: String) : RowContent

    /** Text used for search, previews and copy (null for media without caption). */
    val searchableText: String?
        get() = when (this) {
            is Text -> body
            is Notice -> body
            is Emote -> body
            is Image -> caption ?: filename
            is File -> caption ?: filename
            else -> null
        }
}

enum class FileKind { FILE, VIDEO, AUDIO }

data class ReactionUi(val key: String, val count: Int, val mine: Boolean)

data class ReplyPreview(val eventId: String, val senderName: String?, val text: String?)

enum class ShieldUi { NONE, WARNING, ALERT }

sealed interface TimelineRow {
    val key: String

    data class DateDivider(override val key: String, val millis: Long) : TimelineRow
    data class ReadMarker(override val key: String) : TimelineRow
    data class Start(override val key: String) : TimelineRow
    data class Event(
        override val key: String,
        val id: EventOrTransactionId,
        val eventId: String?,
        val senderId: String,
        val senderName: String,
        val isOwn: Boolean,
        val timestamp: Long,
        val content: RowContent,
        val reactions: List<ReactionUi>,
        val replyTo: ReplyPreview?,
        val delivery: DeliveryState,
        val edited: Boolean,
        val editable: Boolean,
        val canReply: Boolean,
        val shield: ShieldUi,
        val shieldReason: String?,
    ) : TimelineRow
}
