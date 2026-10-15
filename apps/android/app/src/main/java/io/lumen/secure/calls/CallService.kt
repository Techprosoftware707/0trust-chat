package io.lumen.secure.calls

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.Person
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleService
import io.lumen.secure.LumenApplication
import io.lumen.secure.R
import io.lumen.secure.core.calls.CallEncryptionLabel
import io.lumen.secure.core.calls.label
import io.lumen.secure.push.Notifier

/**
 * Keeps an ongoing call alive in the background with a CallStyle notification. Foreground-service
 * types (Android 14+): `phoneCall` always, `microphone` when RECORD_AUDIO is granted and `camera`
 * for video calls when CAMERA is granted.
 */
class CallService : LifecycleService() {

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        super.onStartCommand(intent, flags, startId)
        val video = intent?.getBooleanExtra(EXTRA_VIDEO, false) ?: false
        val call = LumenApplication.graph(this).calls.active.value
        if (call == null && intent?.action != ACTION_REFRESH) {
            stopSelf()
            return START_NOT_STICKY
        }
        var types = 0
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            types = ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL
            if (granted(android.Manifest.permission.RECORD_AUDIO) && Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
            }
            if (video && granted(android.Manifest.permission.CAMERA) && Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA
            }
        }
        ServiceCompat.startForeground(this, Notifier.ID_ONGOING_CALL, notification(), types)
        return START_NOT_STICKY
    }

    private fun granted(p: String) = ContextCompat.checkSelfPermission(this, p) == PackageManager.PERMISSION_GRANTED

    private fun notification(): android.app.Notification {
        val graph = LumenApplication.graph(this)
        val call = graph.calls.active.value
        val title = call?.title ?: getString(R.string.call_ongoing)
        val person = Person.Builder().setName(title).build()
        val hangUp = CallActionReceiver.pendingIntent(this, CallActionReceiver.ACTION_HANGUP)
        val open = PendingIntent.getActivity(
            this, 3, CallActivity.resumeIntent(this),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val status = when (call?.e2ee?.label()) {
            CallEncryptionLabel.END_TO_END_ENCRYPTED -> getString(R.string.call_e2ee_encrypted)
            CallEncryptionLabel.WAITING_FOR_KEYS -> getString(R.string.call_e2ee_waiting)
            CallEncryptionLabel.NOT_ENCRYPTED -> getString(R.string.call_e2ee_not_encrypted)
            CallEncryptionLabel.DECRYPTION_ERROR -> getString(R.string.call_e2ee_error)
            else -> getString(R.string.call_e2ee_unknown)
        }
        return graph.notifier.base(Notifier.CH_ONGOING_CALL)
            .setContentTitle(title)
            .setContentText(status)
            .setStyle(NotificationCompat.CallStyle.forOngoingCall(person, hangUp))
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setOngoing(true)
            .setAutoCancel(false)
            .setContentIntent(open)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .build()
    }

    companion object {
        private const val EXTRA_VIDEO = "video"
        private const val ACTION_REFRESH = "io.lumen.secure.call.REFRESH"

        fun start(context: Context, video: Boolean) {
            ContextCompat.startForegroundService(context, Intent(context, CallService::class.java).putExtra(EXTRA_VIDEO, video))
        }

        fun refresh(context: Context) {
            val call = LumenApplication.graph(context).calls.active.value ?: return
            try {
                ContextCompat.startForegroundService(
                    context,
                    Intent(context, CallService::class.java).setAction(ACTION_REFRESH).putExtra(EXTRA_VIDEO, call.video),
                )
            } catch (_: Exception) {
                // Not allowed from the background on some versions; the notification refreshes on the next start.
            }
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, CallService::class.java))
        }
    }
}
