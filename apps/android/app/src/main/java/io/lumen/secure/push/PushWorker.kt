package io.lumen.secure.push

import android.content.Context
import android.content.pm.ServiceInfo
import android.os.Build
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.ForegroundInfo
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import io.lumen.secure.LumenApplication
import io.lumen.secure.R
import io.lumen.secure.log.LumenLog
import org.matrix.rustcomponents.sdk.NotificationStatus

/**
 * Short, expedited work after a push: restore the session, fetch the event with the SDK's
 * NotificationClient (decrypting it on the device) and post the notification.
 */
class PushWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        val roomId = inputData.getString(K_ROOM) ?: return Result.success()
        val eventId = inputData.getString(K_EVENT) ?: return Result.success()
        val graph = LumenApplication.graph(applicationContext)
        val session = graph.sessions.restore() ?: return Result.success()
        return try {
            val status = graph.notificationClient(session).getNotification(roomId, eventId)
            if (status is NotificationStatus.Event) graph.handleNotificationItem(status.item, roomId, eventId)
            Result.success()
        } catch (e: Exception) {
            LumenLog.w("push", "notification fetch failed", e)
            if (runAttemptCount < 2) Result.retry() else Result.success()
        }
    }

    override suspend fun getForegroundInfo(): ForegroundInfo {
        val n = LumenApplication.graph(applicationContext).notifier.base(Notifier.CH_SYNC)
            .setContentTitle(applicationContext.getString(R.string.notification_checking_messages))
            .setOngoing(true)
            .build()
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ForegroundInfo(Notifier.ID_PUSH_WORK, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            ForegroundInfo(Notifier.ID_PUSH_WORK, n)
        }
    }

    companion object {
        private const val K_ROOM = "room_id"
        private const val K_EVENT = "event_id"

        fun enqueue(context: Context, roomId: String, eventId: String) {
            val req = OneTimeWorkRequestBuilder<PushWorker>()
                .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
                .setInputData(workDataOf(K_ROOM to roomId, K_EVENT to eventId))
                .build()
            WorkManager.getInstance(context).enqueueUniqueWork("push-" + eventId.hashCode(), ExistingWorkPolicy.KEEP, req)
        }
    }
}
