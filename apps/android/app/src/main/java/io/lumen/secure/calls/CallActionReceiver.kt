package io.lumen.secure.calls

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import io.lumen.secure.LumenApplication

/** Decline and hang-up buttons of the call notifications (not exported; explicit intents only). */
class CallActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val calls = LumenApplication.graph(context).calls
        when (intent.action) {
            ACTION_DECLINE -> calls.declineRinging()
            ACTION_HANGUP -> calls.endCall(local = true)
        }
    }

    companion object {
        const val ACTION_DECLINE = "io.lumen.secure.call.DECLINE"
        const val ACTION_HANGUP = "io.lumen.secure.call.HANGUP"

        fun pendingIntent(context: Context, action: String): PendingIntent = PendingIntent.getBroadcast(
            context, action.hashCode(),
            Intent(context, CallActionReceiver::class.java).setAction(action),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
    }
}
