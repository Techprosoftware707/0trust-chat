package io.lumen.secure.core.notifications

/** User setting for notification previews (integration.md §7). Hidden is the default. */
enum class NotificationPreview(val key: String) {
    HIDDEN("hidden"),
    SENDER("sender"),
    SENDER_AND_TEXT("sender_text"),
    ;

    companion object {
        val DEFAULT = HIDDEN
        fun fromKey(key: String?): NotificationPreview = entries.firstOrNull { it.key == key } ?: DEFAULT
    }
}

/** Localised fixed strings, supplied by the app. */
data class PreviewStrings(
    val appName: String,
    val newMessage: String,
    val newMessageInRoom: (roomName: String) -> String,
    val incomingCall: String,
    val incomingCallFrom: (caller: String) -> String,
    val invite: String,
)

data class NotificationText(val title: String, val body: String)

/** What a decrypted event becomes in a notification, by the preview policy. */
object NotificationPreviewPolicy {
    private const val MAX_BODY = 240

    fun message(
        policy: NotificationPreview,
        strings: PreviewStrings,
        senderName: String?,
        roomName: String?,
        isDirect: Boolean,
        body: String?,
    ): NotificationText = when (policy) {
        NotificationPreview.HIDDEN -> NotificationText(strings.appName, strings.newMessage)
        NotificationPreview.SENDER -> NotificationText(
            title = senderLabel(senderName, roomName, isDirect) ?: strings.appName,
            body = strings.newMessage,
        )
        NotificationPreview.SENDER_AND_TEXT -> NotificationText(
            title = senderLabel(senderName, roomName, isDirect) ?: strings.appName,
            body = body?.let(::clean)?.ifEmpty { null } ?: strings.newMessage,
        )
    }

    fun call(policy: NotificationPreview, strings: PreviewStrings, callerName: String?): NotificationText =
        if (policy == NotificationPreview.HIDDEN || callerName.isNullOrBlank()) {
            NotificationText(strings.appName, strings.incomingCall)
        } else {
            NotificationText(clean(callerName), strings.incomingCallFrom(clean(callerName)))
        }

    fun invite(policy: NotificationPreview, strings: PreviewStrings, inviterName: String?): NotificationText =
        if (policy == NotificationPreview.HIDDEN || inviterName.isNullOrBlank()) {
            NotificationText(strings.appName, strings.invite)
        } else {
            NotificationText(clean(inviterName), strings.invite)
        }

    private fun senderLabel(sender: String?, room: String?, isDirect: Boolean): String? {
        val s = sender?.let(::clean)?.ifEmpty { null } ?: return null
        val r = room?.let(::clean)?.ifEmpty { null }
        return if (isDirect || r == null || r == s) s else "$s · $r"
    }

    private fun clean(s: String): String {
        val oneLine = s.filter { !it.isISOControl() || it == '\n' }.replace('\n', ' ').trim()
        return if (oneLine.length > MAX_BODY) oneLine.take(MAX_BODY - 1) + "…" else oneLine
    }
}
