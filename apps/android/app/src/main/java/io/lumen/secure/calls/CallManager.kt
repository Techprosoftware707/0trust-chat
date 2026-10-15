package io.lumen.secure.calls

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.telecom.DisconnectCause
import androidx.core.app.NotificationCompat
import androidx.core.app.Person
import androidx.core.telecom.CallAttributesCompat
import androidx.core.telecom.CallControlScope
import androidx.core.telecom.CallEndpointCompat
import androidx.core.telecom.CallsManager
import io.lumen.secure.R
import io.lumen.secure.core.calls.CallAction
import io.lumen.secure.core.calls.CallPhase
import io.lumen.secure.core.calls.CallStateUpdate
import io.lumen.secure.core.notifications.NotificationPreviewPolicy
import io.lumen.secure.data.Settings
import io.lumen.secure.log.LumenLog
import io.lumen.secure.matrix.SessionManager
import io.lumen.secure.push.Notifier
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import org.matrix.rustcomponents.sdk.CallDeclineListener
import org.matrix.rustcomponents.sdk.RoomInfo
import org.matrix.rustcomponents.sdk.RoomInfoListener
import org.matrix.rustcomponents.sdk.TaskHandle

/** Sink for native → widget actions (the CallActivity's widget host). */
fun interface CallActionSink {
    fun send(action: CallAction)
}

/**
 * System call integration with Jetpack Core-Telecom (`CallsManager`): on Android 14+ it uses the
 * platform's transactional call API, on 8–13 its own self-managed ConnectionService. It gives the
 * system (Bluetooth, car, wearables) the call, audio routing via call endpoints and mute state.
 * The call itself (MatrixRTC + media E2EE) runs in the bundled widget.
 */
class CallManager(
    private val context: Context,
    private val sessions: SessionManager,
    private val notifier: Notifier,
    private val settings: Settings,
    private val scope: CoroutineScope,
) {
    private val _ringing = MutableStateFlow<IncomingRing?>(null)
    val ringing: StateFlow<IncomingRing?> = _ringing.asStateFlow()
    private val _active = MutableStateFlow<ActiveCall?>(null)
    val active: StateFlow<ActiveCall?> = _active.asStateFlow()

    private val callsManager: CallsManager? = try {
        CallsManager(context).also {
            it.registerAppWithTelecom(CallsManager.CAPABILITY_BASELINE or CallsManager.CAPABILITY_SUPPORTS_VIDEO_CALLING)
        }
    } catch (e: Exception) {
        LumenLog.w("call", "Telecom integration unavailable", e)
        null
    }
    private var control: CallControlScope? = null
    private var telecomJob: Job? = null
    private var ringJob: Job? = null
    private val ringHandles = mutableListOf<TaskHandle>()

    @Volatile
    var actionSink: CallActionSink? = null

    val widgetBundled: Boolean get() = CallWidgetBundle.isBundled(context)

    // ---- incoming --------------------------------------------------------------------------------

    fun onIncomingRing(ring: IncomingRing) {
        if (_active.value != null || _ringing.value?.notificationEventId == ring.notificationEventId) return
        val session = sessions.session ?: return
        val text = NotificationPreviewPolicy.call(settings.current.preview, notifier.previewStrings, ring.callerName)
        if (!widgetBundled) {
            // No fake call: say where it can be answered.
            notifier.post(
                null, Notifier.ID_INCOMING_CALL,
                notifier.base(Notifier.CH_MESSAGES).setContentTitle(text.title)
                    .setContentText(context.getString(R.string.call_unavailable_incoming))
                    .setContentIntent(notifier.roomIntent(ring.roomId)).build(),
            )
            return
        }
        _ringing.value = ring
        postIncomingNotification(ring, text.title, text.body)
        addTelecomCall(ring.roomId, text.title, incoming = true, video = ring.video)
        ringJob?.cancel()
        ringJob = scope.launch {
            val room = session.client.getRoom(ring.roomId)
            if (room != null) {
                ringHandles += room.subscribeToCallDeclineEvents(ring.notificationEventId, object : CallDeclineListener {
                    override fun call(declinerUserId: String) {
                        if (declinerUserId == session.userId) stopRinging(missed = false) // declined on another device
                    }
                })
                // Local room state may lag behind the ring (push while sync was stopped), so "call
                // ended" counts only after the call was seen active here.
                var sawCall = false
                ringHandles += room.subscribeToRoomInfoUpdates(object : RoomInfoListener {
                    override fun call(roomInfo: RoomInfo) {
                        if (roomInfo.hasRoomCall) sawCall = true
                        val answeredElsewhere = session.userId in roomInfo.activeRoomCallParticipants
                        when {
                            answeredElsewhere -> stopRinging(missed = false)
                            sawCall && !roomInfo.hasRoomCall -> stopRinging(missed = true)
                        }
                    }
                })
            }
            delay((ring.expiresAtMillis - System.currentTimeMillis()).coerceIn(5_000, 90_000))
            if (_ringing.value == ring) stopRinging(missed = true)
        }
    }

    private fun postIncomingNotification(ring: IncomingRing, title: String, body: String) {
        val person = Person.Builder().setName(title).setImportant(true).build()
        val fullScreen = PendingIntent.getActivity(
            context, 1, CallActivity.incomingIntent(context, ring.roomId),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val answer = PendingIntent.getActivity(
            context, 2, CallActivity.answerIntent(context, ring.roomId, ring.video),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val decline = CallActionReceiver.pendingIntent(context, CallActionReceiver.ACTION_DECLINE)
        val n = notifier.base(Notifier.CH_CALLS)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.CallStyle.forIncomingCall(person, decline, answer))
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setFullScreenIntent(fullScreen, true)
            .setOngoing(true)
            .setAutoCancel(false)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .build()
        n.flags = n.flags or android.app.Notification.FLAG_INSISTENT
        notifier.post(null, Notifier.ID_INCOMING_CALL, n)
    }

    fun stopRinging(missed: Boolean) {
        val ring = _ringing.value ?: return
        _ringing.value = null
        ringJob?.cancel()
        ringHandles.forEach { it.cancel() }
        ringHandles.clear()
        androidx.core.app.NotificationManagerCompat.from(context).cancel(Notifier.ID_INCOMING_CALL)
        if (_active.value == null) disconnectTelecom(if (missed) DisconnectCause.MISSED else DisconnectCause.REJECTED)
        if (missed) {
            val text = NotificationPreviewPolicy.call(settings.current.preview, notifier.previewStrings, ring.callerName)
            notifier.post(
                "missed:" + ring.roomId.hashCode(), Notifier.ID_MESSAGE,
                notifier.base(Notifier.CH_MESSAGES).setContentTitle(text.title)
                    .setContentText(context.getString(R.string.call_missed))
                    .setCategory(NotificationCompat.CATEGORY_MISSED_CALL)
                    .setContentIntent(notifier.roomIntent(ring.roomId)).build(),
            )
        }
    }

    /** Decline sends the RTC decline (`org.matrix.msc4310.rtc.decline`) through the SDK. */
    fun declineRinging() {
        val ring = _ringing.value ?: return
        stopRinging(missed = false)
        val session = sessions.session ?: return
        scope.launch {
            try {
                session.client.getRoom(ring.roomId)?.declineCall(ring.notificationEventId)
            } catch (e: Exception) {
                LumenLog.w("call", "decline failed", e)
            }
        }
    }

    // ---- active call -------------------------------------------------------------------------------

    /** Called by CallActivity once the user started, joined or answered a call. */
    fun beginCall(roomId: String, title: String, video: Boolean, outgoing: Boolean) {
        val ring = _ringing.value
        if (ring != null && ring.roomId == roomId) {
            _ringing.value = null
            ringJob?.cancel()
            ringHandles.forEach { it.cancel() }
            ringHandles.clear()
            androidx.core.app.NotificationManagerCompat.from(context).cancel(Notifier.ID_INCOMING_CALL)
            scope.launch {
                try {
                    control?.answer(if (video) CallAttributesCompat.CALL_TYPE_VIDEO_CALL else CallAttributesCompat.CALL_TYPE_AUDIO_CALL)
                } catch (e: Exception) {
                    LumenLog.w("call", "telecom answer failed", e)
                }
            }
        } else {
            addTelecomCall(roomId, title, incoming = false, video = video)
        }
        _active.value = ActiveCall(roomId, title, video, outgoing, telecom = callsManager != null)
        CallService.start(context, video)
    }

    fun onWidgetState(update: CallStateUpdate) {
        _active.update { it?.copy(phase = update.phase, e2ee = update.e2ee, muted = update.muted, videoOn = update.video) }
        when (update.phase) {
            CallPhase.CONNECTED -> scope.launch {
                try {
                    control?.setActive()
                } catch (e: Exception) {
                    LumenLog.w("call", "telecom setActive failed", e)
                }
            }
            CallPhase.ENDED -> endCall(local = true)
            else -> Unit
        }
        CallService.refresh(context)
    }

    fun sendAction(action: CallAction) {
        actionSink?.send(action)
    }

    fun selectRoute(route: AudioRoute) {
        scope.launch {
            try {
                control?.requestEndpointChange(route.endpoint)
            } catch (e: Exception) {
                LumenLog.w("call", "route change failed", e)
            }
        }
    }

    /** Ends the native side of the call (the widget leaves the MatrixRTC session itself). */
    fun endCall(local: Boolean) {
        if (_active.value == null) return
        if (local) actionSink?.send(CallAction.HANGUP)
        _active.value = null
        disconnectTelecom(if (local) DisconnectCause.LOCAL else DisconnectCause.REMOTE)
        CallService.stop(context)
    }

    // ---- Telecom ---------------------------------------------------------------------------------------

    private fun addTelecomCall(roomId: String, title: String, incoming: Boolean, video: Boolean) {
        val cm = callsManager ?: return
        telecomJob?.cancel()
        telecomJob = scope.launch {
            try {
                val attrs = CallAttributesCompat(
                    displayName = title,
                    address = Uri.fromParts("lumen", roomId.hashCode().toUInt().toString(16), null),
                    direction = if (incoming) CallAttributesCompat.DIRECTION_INCOMING else CallAttributesCompat.DIRECTION_OUTGOING,
                    callType = if (video) CallAttributesCompat.CALL_TYPE_VIDEO_CALL else CallAttributesCompat.CALL_TYPE_AUDIO_CALL,
                    callCapabilities = CallAttributesCompat.SUPPORTS_SET_INACTIVE,
                )
                cm.addCall(
                    attrs,
                    onAnswer = { _ ->
                        // Answered from a system surface (car, watch): open the call screen.
                        _ringing.value?.let { r -> context.startActivity(CallActivity.answerIntent(context, r.roomId, r.video).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
                    },
                    onDisconnect = { _ ->
                        control = null
                        if (_ringing.value != null) declineRinging() else endCall(local = true)
                    },
                    onSetActive = { },
                    onSetInactive = { },
                ) {
                    control = this
                    launch { availableEndpoints.collect { list -> _active.update { it?.copy(routes = list.map(::AudioRoute)) } } }
                    launch { currentCallEndpoint.collect { e -> _active.update { it?.copy(currentRoute = AudioRoute(e)) } } }
                    launch {
                        isMuted.collect { muted ->
                            val call = _active.value ?: return@collect
                            if (call.muted != muted) sendAction(if (muted) CallAction.MUTE else CallAction.UNMUTE)
                        }
                    }
                }
            } catch (e: Exception) {
                LumenLog.w("call", "Telecom addCall failed; continuing without system integration", e)
                control = null
            }
        }
    }

    private fun disconnectTelecom(cause: Int) {
        val c = control ?: run {
            telecomJob?.cancel()
            return
        }
        control = null
        scope.launch {
            try {
                c.disconnect(DisconnectCause(cause))
            } catch (e: Exception) {
                LumenLog.w("call", "telecom disconnect failed", e)
            }
            telecomJob?.cancel()
        }
    }

    fun endpointLabel(route: AudioRoute): Int = when (route.type) {
        CallEndpointCompat.TYPE_EARPIECE -> R.string.call_route_earpiece
        CallEndpointCompat.TYPE_SPEAKER -> R.string.call_route_speaker
        CallEndpointCompat.TYPE_BLUETOOTH -> R.string.call_route_bluetooth
        CallEndpointCompat.TYPE_WIRED_HEADSET -> R.string.call_route_wired
        else -> R.string.call_route_other
    }

    val canUseFullScreenIntent: Boolean
        get() = Build.VERSION.SDK_INT < 34 ||
            context.getSystemService(android.app.NotificationManager::class.java).canUseFullScreenIntent()
}
