package io.lumen.secure.push

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import io.lumen.secure.LumenApplication
import io.lumen.secure.core.push.PushPayload

/**
 * FCM entry point. The payload is `event_id_only` (room ID, event ID, counts): nothing to show by
 * itself. The event is fetched and decrypted locally in [PushWorker].
 */
class LumenMessagingService : FirebaseMessagingService() {
    @Deprecated("FCM 25 delivers tokens through onRegistered; kept for older FCM paths")
    override fun onNewToken(token: String) {
        LumenApplication.graph(this).push.onNewToken(token)
    }

    override fun onRegistered(token: String) {
        LumenApplication.graph(this).push.onNewToken(token)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val data = message.data
        PushPayload.unreadOnly(data)?.let { unread ->
            if (unread == 0) LumenApplication.graph(this).notifier.clearAll()
            return
        }
        val event = PushPayload.parse(data) ?: return
        PushWorker.enqueue(this, event.roomId, event.eventId)
    }
}
