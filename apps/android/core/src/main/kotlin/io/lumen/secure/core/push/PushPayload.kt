package io.lumen.secure.core.push

import io.lumen.secure.core.config.UrlPolicy
import io.lumen.secure.core.matrix.MatrixIds

/**
 * An `event_id_only` push from Sygnal via FCM (integration.md §7): Google sees only these
 * fields. The app fetches and decrypts the event itself.
 */
data class PushEvent(val roomId: String, val eventId: String, val unread: Int?)

object PushPayload {
    /** Returns null for payloads without a valid room and event ID (e.g. badge-only updates). */
    fun parse(data: Map<String, String>): PushEvent? {
        val roomId = data["room_id"]?.trim()?.takeIf(MatrixIds::isRoomId) ?: return null
        val eventId = data["event_id"]?.trim()?.takeIf(MatrixIds::isEventId) ?: return null
        val unread = data["unread"]?.trim()?.toIntOrNull()?.takeIf { it >= 0 }
        return PushEvent(roomId, eventId, unread)
    }

    /** `unread` alone (no event): the server says everything was read elsewhere. */
    fun unreadOnly(data: Map<String, String>): Int? =
        if (data["event_id"] == null) data["unread"]?.trim()?.toIntOrNull()?.takeIf { it >= 0 } else null
}

/** The pusher the app registers (integration.md §7, `POST /pushers/set`). */
data class PusherSpec(
    val appId: String,
    val pushKey: String,
    val gatewayUrl: String,
    val format: String = "event_id_only",
)

object PusherPolicy {
    /**
     * A pusher is registered only when the build carries FCM identifiers, the server advertises a
     * valid `push_gateway_url`, and FCM issued a token. Otherwise the app says "Notifications only
     * while the app runs".
     */
    fun spec(fcmConfigured: Boolean, appId: String, gatewayUrl: String?, fcmToken: String?): PusherSpec? {
        if (!fcmConfigured) return null
        val url = UrlPolicy.validateLinkUrl(gatewayUrl, debug = false) ?: return null
        val token = fcmToken?.trim()?.takeIf { it.isNotEmpty() && it.length <= 4096 && it.none(Char::isWhitespace) } ?: return null
        require(Regex("^[A-Za-z0-9._-]{1,64}$").matches(appId)) { "invalid pusher app_id" }
        return PusherSpec(appId = appId, pushKey = token, gatewayUrl = url)
    }
}
