package io.lumen.secure.calls

import android.content.Context
import androidx.core.telecom.CallEndpointCompat
import io.lumen.secure.core.calls.CallE2ee
import io.lumen.secure.core.calls.CallPhase

/** An incoming ring (`org.matrix.msc4075.rtc.notification`, notification_type `ring`). */
data class IncomingRing(
    val roomId: String,
    val notificationEventId: String,
    val callerName: String?,
    val roomName: String?,
    val isDirect: Boolean,
    val video: Boolean,
    val expiresAtMillis: Long,
)

data class AudioRoute(val endpoint: CallEndpointCompat) {
    val type: Int get() = endpoint.type
    val name: String get() = endpoint.name.toString()
}

data class ActiveCall(
    val roomId: String,
    val title: String,
    val video: Boolean,
    val outgoing: Boolean,
    /** Null until the widget reported its first state. */
    val phase: CallPhase? = null,
    /** Reported by the widget; the native layer never derives or claims encryption itself. */
    val e2ee: CallE2ee = CallE2ee.UNKNOWN,
    val muted: Boolean = false,
    val videoOn: Boolean = false,
    val routes: List<AudioRoute> = emptyList(),
    val currentRoute: AudioRoute? = null,
    val telecom: Boolean = false,
)

object CallWidgetBundle {
    /** The call widget is bundled only when services/chat/dist-widget existed at build time. */
    fun isBundled(context: Context): Boolean = try {
        context.assets.list("call-widget")?.contains("index.html") == true
    } catch (_: Exception) {
        false
    }
}
