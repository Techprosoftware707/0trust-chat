package io.lumen.secure.sync

import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleService
import androidx.lifecycle.lifecycleScope
import io.lumen.secure.LumenApplication
import io.lumen.secure.R
import io.lumen.secure.push.Notifier
import kotlinx.coroutines.launch

/**
 * Opt-in "Stay connected" for builds or servers without push (integration.md §7): keeps the
 * sync connection open with the persistent notification Android requires.
 *
 * Foreground-service type `specialUse` (Android 14+), not `dataSync`: since Android 15 a
 * `dataSync` service is stopped after 6 hours per day, which cannot keep a messaging connection
 * open; `specialUse` with a declared subtype is the type Play policy provides for this case and
 * needs a declaration in the Play Console (docs/apps/release-android.md).
 */
class KeepConnectedService : LifecycleService() {

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        super.onStartCommand(intent, flags, startId)
        val graph = LumenApplication.graph(this)
        if (!graph.settings.current.keepConnected) {
            stopSelf()
            return START_NOT_STICKY
        }
        val n = graph.notifier.base(Notifier.CH_SYNC)
            .setContentTitle(getString(R.string.keep_connected_notification))
            .setOngoing(true)
            .setAutoCancel(false)
            .setContentIntent(graph.notifier.openAppIntent())
            .build()
        val type = if (Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE else 0
        ServiceCompat.startForeground(this, Notifier.ID_SYNC_SERVICE, n, type)
        lifecycleScope.launch {
            graph.sessions.restore()?.let { graph.setBackgroundSync(true) }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        LumenApplication.graph(this).setBackgroundSync(false)
        super.onDestroy()
    }

    companion object {
        fun start(context: Context) {
            ContextCompat.startForegroundService(context, Intent(context, KeepConnectedService::class.java))
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, KeepConnectedService::class.java))
        }
    }
}
