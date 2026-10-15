package io.lumen.secure.calls

import android.Manifest
import android.app.PictureInPictureParams
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.os.Build
import android.os.Bundle
import android.util.Rational
import android.view.WindowManager
import androidx.activity.OnBackPressedCallback
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import io.lumen.secure.LumenApplication
import io.lumen.secure.core.calls.CallPhase
import io.lumen.secure.core.calls.CallStateUpdate
import io.lumen.secure.core.calls.CallWidgetUrl
import io.lumen.secure.ui.theme.LumenTheme
import kotlinx.coroutines.launch
import java.util.Locale

/**
 * The call screen. Incoming calls show a native ring screen (also over the lock screen via the
 * full-screen intent); active calls host the bundled widget (CallWidgetHost). Without a bundled
 * widget it says "Calls unavailable in this build" and nothing else happens.
 */
class CallActivity : FragmentActivity() {

    enum class Stage { UNAVAILABLE, INCOMING, PERMISSIONS_DENIED, CONNECTING, ACTIVE, FAILED, ENDED }

    private val graph by lazy { LumenApplication.graph(this) }
    private var host by mutableStateOf<CallWidgetHost?>(null)
    private var stage by mutableStateOf(Stage.CONNECTING)
    private var failure by mutableStateOf<CallWidgetHost.Failure?>(null)
    private var pip by mutableStateOf(false)
    private var roomId: String? = null
    private var video = false
    private var pendingJoin: (() -> Unit)? = null

    private val permissionRequest = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { result ->
        val audio = result[Manifest.permission.RECORD_AUDIO] ?: granted(Manifest.permission.RECORD_AUDIO)
        if (!audio) {
            stage = Stage.PERMISSIONS_DENIED
            graph.calls.declineRinging()
        } else {
            pendingJoin?.invoke()
        }
        pendingJoin = null
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        if (graph.settings.current.secureScreen) window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
        } else {
            @Suppress("DEPRECATION")
            window.addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON)
        }
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                when (stage) {
                    Stage.ACTIVE, Stage.CONNECTING -> if (!enterPipIfVideo()) moveTaskToBack(true)
                    else -> finish()
                }
            }
        })
        setContent {
            LumenTheme(darkOverride = true) {
                CallScreen(
                    stage = stage,
                    failure = failure,
                    pip = pip,
                    calls = graph.calls,
                    webView = host?.webView,
                    onAnswer = { withVideo -> answer(withVideo) },
                    onDecline = {
                        graph.calls.declineRinging()
                        finish()
                    },
                    onHangUp = {
                        graph.calls.endCall(local = true)
                        finish()
                    },
                    onClose = { finish() },
                    onPip = { enterPipIfVideo() },
                )
            }
        }
        handle(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handle(intent)
    }

    private fun handle(intent: Intent) {
        val mode = intent.getStringExtra(EXTRA_MODE) ?: MODE_RESUME
        if (mode == MODE_RESUME) {
            if (graph.calls.active.value == null && host == null) finish()
            return
        }
        val rid = intent.getStringExtra(EXTRA_ROOM_ID)?.takeIf { io.lumen.secure.core.matrix.MatrixIds.isRoomId(it) } ?: return finish()
        if (host != null && rid == roomId) return
        roomId = rid
        video = intent.getBooleanExtra(EXTRA_VIDEO, false)
        if (!graph.calls.widgetBundled) {
            stage = Stage.UNAVAILABLE
            return
        }
        when (mode) {
            MODE_INCOMING -> stage = if (graph.calls.ringing.value?.roomId == rid) Stage.INCOMING else Stage.ENDED
            MODE_ANSWER -> answer(video)
            MODE_START -> withPermissions { join(answering = false) }
        }
    }

    private fun answer(withVideo: Boolean) {
        video = withVideo
        withPermissions { join(answering = true) }
    }

    private fun withPermissions(then: () -> Unit) {
        val needed = buildList {
            add(Manifest.permission.RECORD_AUDIO)
            if (video) add(Manifest.permission.CAMERA)
        }.filterNot(::granted)
        if (needed.isEmpty()) {
            then()
        } else {
            pendingJoin = then
            permissionRequest.launch(needed.toTypedArray())
        }
    }

    private fun join(answering: Boolean) {
        val rid = roomId ?: return
        val session = graph.sessions.session ?: return finish()
        stage = Stage.CONNECTING
        lifecycleScope.launch {
            val room = session.client.getRoom(rid) ?: return@launch fail(CallWidgetHost.Failure.ROOM_NOT_FOUND)
            val info = room.roomInfo()
            val title = info.displayName ?: getString(io.lumen.secure.R.string.call_ongoing)
            val existing = room.hasActiveRoomCall()
            val intent = if (answering || existing) CallWidgetUrl.Intent.JOIN_EXISTING else CallWidgetUrl.Intent.START_CALL
            // integration.md §5/§6: ring for DMs, a notification for groups; nothing when joining.
            val notify = when {
                intent == CallWidgetUrl.Intent.JOIN_EXISTING -> CallWidgetUrl.Notify.NONE
                info.isDirect -> CallWidgetUrl.Notify.RING
                else -> CallWidgetUrl.Notify.NOTIFICATION
            }
            val h = CallWidgetHost(this@CallActivity, session, rid, widgetListener)
            host = h
            graph.calls.actionSink = CallActionSink { h.sendAction(it) }
            graph.calls.beginCall(rid, title, video, outgoing = !answering)
            stage = Stage.ACTIVE
            val dark = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
            h.start(intent, video, notify, dark, Locale.getDefault().toLanguageTag())
            updatePipParams()
        }
    }

    private val widgetListener = object : CallWidgetHost.Listener {
        override fun onCallState(update: CallStateUpdate) {
            graph.calls.onWidgetState(update)
            if (update.phase == CallPhase.ENDED) {
                stage = Stage.ENDED
                finish()
            }
            updatePipParams()
        }

        override fun onFatal(reason: CallWidgetHost.Failure) = fail(reason)

        override fun isCallScreenVisible(): Boolean = lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)
    }

    private fun fail(reason: CallWidgetHost.Failure) {
        failure = reason
        stage = Stage.FAILED
        graph.calls.endCall(local = false)
    }

    private fun granted(p: String) = ContextCompat.checkSelfPermission(this, p) == PackageManager.PERMISSION_GRANTED

    private fun enterPipIfVideo(): Boolean {
        if (!video || stage != Stage.ACTIVE) return false
        if (!packageManager.hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)) return false
        return try {
            enterPictureInPictureMode(pipParams())
        } catch (_: IllegalStateException) {
            false
        }
    }

    private fun pipParams(): PictureInPictureParams = PictureInPictureParams.Builder()
        .setAspectRatio(Rational(9, 16))
        .apply {
            val r = android.graphics.Rect()
            if (host?.webView?.getGlobalVisibleRect(r) == true) setSourceRectHint(r)
        }
        .apply { if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) setAutoEnterEnabled(video && stage == Stage.ACTIVE) }
        .build()

    private fun updatePipParams() {
        if (packageManager.hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)) {
            try {
                setPictureInPictureParams(pipParams())
            } catch (_: IllegalStateException) {
            }
        }
    }

    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) enterPipIfVideo()
    }

    override fun onPictureInPictureModeChanged(isInPictureInPictureMode: Boolean, newConfig: Configuration) {
        super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)
        pip = isInPictureInPictureMode
    }

    override fun onDestroy() {
        if (isFinishing) {
            // The WebView (and with it the MatrixRTC session) ends with this screen. The widget's
            // delayed leave event removes the membership if it could not leave cleanly.
            if (host != null) graph.calls.endCall(local = true)
            graph.calls.actionSink = null
            host?.destroy()
            host = null
        }
        super.onDestroy()
    }

    companion object {
        private const val EXTRA_ROOM_ID = "room_id"
        private const val EXTRA_VIDEO = "video"
        private const val EXTRA_MODE = "mode"
        private const val MODE_START = "start"
        private const val MODE_INCOMING = "incoming"
        private const val MODE_ANSWER = "answer"
        private const val MODE_RESUME = "resume"

        fun startIntent(context: Context, roomId: String, video: Boolean): Intent =
            Intent(context, CallActivity::class.java).putExtra(EXTRA_ROOM_ID, roomId).putExtra(EXTRA_VIDEO, video).putExtra(EXTRA_MODE, MODE_START)

        fun incomingIntent(context: Context, roomId: String): Intent =
            Intent(context, CallActivity::class.java).putExtra(EXTRA_ROOM_ID, roomId).putExtra(EXTRA_MODE, MODE_INCOMING)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

        fun answerIntent(context: Context, roomId: String, video: Boolean): Intent =
            Intent(context, CallActivity::class.java).putExtra(EXTRA_ROOM_ID, roomId).putExtra(EXTRA_VIDEO, video)
                .putExtra(EXTRA_MODE, MODE_ANSWER).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

        fun resumeIntent(context: Context): Intent =
            Intent(context, CallActivity::class.java).putExtra(EXTRA_MODE, MODE_RESUME).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }
}
