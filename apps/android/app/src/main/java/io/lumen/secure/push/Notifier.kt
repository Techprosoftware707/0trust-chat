package io.lumen.secure.push

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import io.lumen.secure.R
import io.lumen.secure.core.notifications.NotificationPreview
import io.lumen.secure.core.notifications.NotificationPreviewPolicy
import io.lumen.secure.core.notifications.NotificationText
import io.lumen.secure.core.notifications.PreviewStrings
import io.lumen.secure.ui.MainActivity

/** Notification channels and message notifications (integration.md §7: preview hidden by default). */
class Notifier(private val context: Context) {
    private val nm = NotificationManagerCompat.from(context)
    private val shownEvents = object : LinkedHashMap<String, Boolean>(64, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Boolean>?) = size > 200
    }

    /** The room the user is looking at; its messages are not notified. */
    @Volatile
    var visibleRoomId: String? = null

    val previewStrings: PreviewStrings
        get() = PreviewStrings(
            appName = context.getString(R.string.app_name),
            newMessage = context.getString(R.string.notification_new_message),
            newMessageInRoom = { context.getString(R.string.notification_new_message_in, it) },
            incomingCall = context.getString(R.string.notification_incoming_call),
            incomingCallFrom = { context.getString(R.string.notification_incoming_call_from, it) },
            invite = context.getString(R.string.notification_invite),
        )

    fun createChannels() {
        val mgr = context.getSystemService(NotificationManager::class.java)
        val messages = NotificationChannel(CH_MESSAGES, context.getString(R.string.channel_messages), NotificationManager.IMPORTANCE_HIGH).apply {
            description = context.getString(R.string.channel_messages_desc)
            lockscreenVisibility = NotificationCompat.VISIBILITY_PRIVATE
        }
        val calls = NotificationChannel(CH_CALLS, context.getString(R.string.channel_calls), NotificationManager.IMPORTANCE_HIGH).apply {
            description = context.getString(R.string.channel_calls_desc)
            setSound(
                RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE),
                AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build(),
            )
            enableVibration(true)
            vibrationPattern = longArrayOf(0, 800, 600, 800)
            lockscreenVisibility = NotificationCompat.VISIBILITY_PRIVATE
        }
        val ongoing = NotificationChannel(CH_ONGOING_CALL, context.getString(R.string.channel_ongoing_call), NotificationManager.IMPORTANCE_DEFAULT).apply {
            setSound(null, null)
            enableVibration(false)
        }
        val sync = NotificationChannel(CH_SYNC, context.getString(R.string.channel_sync), NotificationManager.IMPORTANCE_MIN).apply {
            description = context.getString(R.string.channel_sync_desc)
            setShowBadge(false)
        }
        mgr.createNotificationChannels(listOf(messages, calls, ongoing, sync))
    }

    fun canPost(): Boolean = Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
        ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    fun roomIntent(roomId: String): PendingIntent {
        val i = Intent(context, MainActivity::class.java)
            .setAction(MainActivity.ACTION_OPEN_ROOM)
            .putExtra(MainActivity.EXTRA_ROOM_ID, roomId)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        return PendingIntent.getActivity(context, roomId.hashCode(), i, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    fun openAppIntent(): PendingIntent = PendingIntent.getActivity(
        context, 0,
        Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    /**
     * Shows one message notification. [text] is already rendered by [NotificationPreviewPolicy];
     * the lock-screen (public) version is always the hidden variant.
     */
    fun showMessage(roomId: String, eventId: String, text: NotificationText, noisy: Boolean) {
        if (!canPost() || roomId == visibleRoomId) return
        synchronized(shownEvents) {
            if (shownEvents.put(eventId, true) != null) return
        }
        val hidden = NotificationPreviewPolicy.message(NotificationPreview.HIDDEN, previewStrings, null, null, true, null)
        val public = base(CH_MESSAGES).setContentTitle(hidden.title).setContentText(hidden.body).build()
        val n = base(CH_MESSAGES)
            .setContentTitle(text.title)
            .setContentText(text.body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text.body))
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPublicVersion(public)
            .setContentIntent(roomIntent(roomId))
            .setOnlyAlertOnce(!noisy)
            .setGroup(GROUP_MESSAGES)
            .build()
        post(roomTag(roomId), ID_MESSAGE, n)
    }

    fun clearRoom(roomId: String) = nm.cancel(roomTag(roomId), ID_MESSAGE)

    fun clearAll() = nm.cancelAll()

    fun base(channel: String): NotificationCompat.Builder = NotificationCompat.Builder(context, channel)
        .setSmallIcon(R.drawable.ic_stat_lumen)
        .setColor(ContextCompat.getColor(context, R.color.lumen_accent_light))
        .setAutoCancel(true)

    @Suppress("MissingPermission") // checked by canPost()
    fun post(tag: String?, id: Int, n: android.app.Notification) {
        if (!canPost()) return
        nm.notify(tag, id, n)
    }

    private fun roomTag(roomId: String) = "room:" + roomId.hashCode()

    companion object {
        const val CH_MESSAGES = "messages"
        const val CH_CALLS = "calls"
        const val CH_ONGOING_CALL = "ongoing_call"
        const val CH_SYNC = "sync"
        const val GROUP_MESSAGES = "io.lumen.secure.MESSAGES"
        const val ID_MESSAGE = 1
        const val ID_SYNC_SERVICE = 10
        const val ID_PUSH_WORK = 11
        const val ID_INCOMING_CALL = 20
        const val ID_ONGOING_CALL = 21
    }
}
