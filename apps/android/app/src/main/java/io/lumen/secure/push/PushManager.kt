package io.lumen.secure.push

import android.content.Context
import androidx.core.content.edit
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.messaging.FirebaseMessaging
import io.lumen.secure.BuildConfig
import io.lumen.secure.R
import io.lumen.secure.core.push.PusherPolicy
import io.lumen.secure.log.LumenLog
import io.lumen.secure.matrix.MatrixSession
import io.lumen.secure.matrix.ServerInfoStore
import io.lumen.secure.matrix.SessionManager
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import org.matrix.rustcomponents.sdk.HttpPusherData
import org.matrix.rustcomponents.sdk.PushFormat
import org.matrix.rustcomponents.sdk.PusherIdentifiers
import org.matrix.rustcomponents.sdk.PusherKind
import java.util.Locale
import kotlin.coroutines.resume

enum class PushStatus {
    /** This build has no FCM identifiers: notifications only while the app runs. */
    NOT_IN_BUILD,

    /** The server advertises no push gateway: notifications only while the app runs. */
    NO_GATEWAY,
    REGISTERING,
    REGISTERED,
    FAILED,
}

/**
 * Firebase Cloud Messaging is optional at build time (gradle properties lumen.fcm.*). Firebase is
 * initialised manually from those public identifiers (no google-services.json), and a pusher is
 * registered only when the server advertises `push_gateway_url` (integration.md §7).
 */
class PushManager(
    private val context: Context,
    private val sessionManager: SessionManager,
    private val serverInfo: ServerInfoStore,
    private val scope: CoroutineScope,
) {
    private val prefs = context.getSharedPreferences("lumen_push", Context.MODE_PRIVATE)
    private val _status = MutableStateFlow(if (BuildConfig.FCM_CONFIGURED) PushStatus.NO_GATEWAY else PushStatus.NOT_IN_BUILD)
    val status: StateFlow<PushStatus> = _status.asStateFlow()

    /** Whether push can deliver while the app is not running (Settings wording depends on it). */
    val pushAvailable: Boolean get() = _status.value == PushStatus.REGISTERED

    fun initFirebaseIfConfigured() {
        if (!BuildConfig.FCM_CONFIGURED) return
        try {
            if (FirebaseApp.getApps(context).isEmpty()) {
                FirebaseApp.initializeApp(
                    context,
                    FirebaseOptions.Builder()
                        .setProjectId(BuildConfig.FCM_PROJECT_ID)
                        .setApplicationId(BuildConfig.FCM_APP_ID)
                        .setApiKey(BuildConfig.FCM_API_KEY)
                        .setGcmSenderId(BuildConfig.FCM_SENDER_ID)
                        .build(),
                )
            }
        } catch (e: Exception) {
            LumenLog.e("push", "Firebase initialisation failed", e)
        }
    }

    fun onSignedIn(session: MatrixSession) {
        scope.launch { register(session) }
    }

    fun onNewToken(token: String) {
        prefs.edit { putString(K_TOKEN, token) }
        sessionManager.session?.let { s -> scope.launch { register(s) } }
    }

    suspend fun register(session: MatrixSession) {
        if (!BuildConfig.FCM_CONFIGURED) {
            _status.value = PushStatus.NOT_IN_BUILD
            return
        }
        val gateway = serverInfo.load()?.lumen?.pushGatewayUrl
        if (gateway == null) {
            _status.value = PushStatus.NO_GATEWAY
            return
        }
        _status.value = PushStatus.REGISTERING
        val token = prefs.getString(K_TOKEN, null) ?: fetchToken()?.also { t -> prefs.edit { putString(K_TOKEN, t) } }
        val spec = PusherPolicy.spec(true, BuildConfig.PUSHER_APP_ID, gateway, token)
        if (spec == null) {
            _status.value = PushStatus.FAILED
            return
        }
        try {
            session.client.setPusher(
                PusherIdentifiers(pushkey = spec.pushKey, appId = spec.appId),
                PusherKind.Http(HttpPusherData(url = spec.gatewayUrl, format = PushFormat.EVENT_ID_ONLY, defaultPayload = null)),
                context.getString(R.string.app_name),
                SessionManager.deviceDisplayName(),
                null,
                Locale.getDefault().toLanguageTag(),
                false,
            )
            _status.value = PushStatus.REGISTERED
        } catch (e: Exception) {
            LumenLog.w("push", "pusher registration failed", e)
            _status.value = PushStatus.FAILED
        }
    }

    fun onSignedOut() {
        // The server deleted the pusher with the device (logout). Drop the local token too.
        prefs.edit { clear() }
        if (BuildConfig.FCM_CONFIGURED && FirebaseApp.getApps(context).isNotEmpty()) {
            try {
                @Suppress("DEPRECATION")
                FirebaseMessaging.getInstance().deleteToken()
            } catch (e: Exception) {
                LumenLog.w("push", "token deletion failed", e)
            }
        }
        _status.value = if (BuildConfig.FCM_CONFIGURED) PushStatus.NO_GATEWAY else PushStatus.NOT_IN_BUILD
    }

    private suspend fun fetchToken(): String? {
        if (FirebaseApp.getApps(context).isEmpty()) return null
        return suspendCancellableCoroutine { cont ->
            @Suppress("DEPRECATION")
            FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
                cont.resume(if (task.isSuccessful) task.result else null)
            }
        }
    }

    private companion object {
        const val K_TOKEN = "fcm_token"
    }
}
