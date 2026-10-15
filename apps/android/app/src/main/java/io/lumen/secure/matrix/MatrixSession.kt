package io.lumen.secure.matrix

import io.lumen.secure.log.LumenLog
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.matrix.rustcomponents.sdk.Client
import org.matrix.rustcomponents.sdk.RoomListService
import org.matrix.rustcomponents.sdk.SyncService
import org.matrix.rustcomponents.sdk.SyncServiceState
import org.matrix.rustcomponents.sdk.SyncServiceStateObserver
import org.matrix.rustcomponents.sdk.TaskHandle

/** Connection state shown as a banner (offline / reconnecting), from the SDK's SyncService. */
enum class ConnectionState { CONNECTING, CONNECTED, RECONNECTING, OFFLINE, STOPPED }

/** One signed-in account: the Rust client, its sync service and room list service. */
class MatrixSession(
    val client: Client,
    val userId: String,
    val deviceId: String,
    val homeserverUrl: String,
    val storeDir: String,
    parent: CoroutineScope,
) {
    val scope = CoroutineScope(parent.coroutineContext + SupervisorJob(parent.coroutineContext[Job]))
    private val syncMutex = Mutex()
    private var syncService: SyncService? = null
    private var syncStateHandle: TaskHandle? = null
    private var wantSync = false

    private val _connection = MutableStateFlow(ConnectionState.STOPPED)
    val connection: StateFlow<ConnectionState> = _connection.asStateFlow()

    /** Lazily built; the notification client and the room list both need it. */
    suspend fun syncService(): SyncService = syncMutex.withLock {
        syncService ?: client.syncService().withOfflineMode().finish().also { svc ->
            syncService = svc
            syncStateHandle = svc.state(
                object : SyncServiceStateObserver {
                    override fun onUpdate(state: SyncServiceState) = onSyncState(state)
                },
            )
        }
    }

    suspend fun roomListService(): RoomListService = syncService().roomListService()

    suspend fun startSync() {
        wantSync = true
        if (_connection.value == ConnectionState.STOPPED) _connection.value = ConnectionState.CONNECTING
        try {
            syncService().start()
        } catch (e: Exception) {
            LumenLog.w("sync", "start failed", e)
            _connection.value = ConnectionState.RECONNECTING
        }
    }

    suspend fun stopSync() {
        wantSync = false
        try {
            syncMutex.withLock { syncService }?.stop()
        } catch (e: Exception) {
            LumenLog.w("sync", "stop failed", e)
        }
    }

    private fun onSyncState(state: SyncServiceState) {
        _connection.value = when (state) {
            SyncServiceState.RUNNING -> ConnectionState.CONNECTED
            SyncServiceState.OFFLINE -> ConnectionState.OFFLINE
            SyncServiceState.ERROR -> ConnectionState.RECONNECTING
            SyncServiceState.IDLE, SyncServiceState.TERMINATED ->
                if (wantSync) ConnectionState.RECONNECTING else ConnectionState.STOPPED
        }
        // The sync service stops itself on errors; restart with a short back-off while wanted.
        if (wantSync && (state == SyncServiceState.ERROR || state == SyncServiceState.TERMINATED)) {
            scope.launch {
                delay(RESTART_DELAY_MS)
                if (wantSync) {
                    try {
                        syncService().start()
                    } catch (e: Exception) {
                        LumenLog.w("sync", "restart failed", e)
                    }
                }
            }
        }
    }

    suspend fun close() {
        stopSync()
        syncStateHandle?.cancel()
        scope.cancel()
        syncMutex.withLock {
            syncService?.close()
            syncService = null
        }
        client.close()
    }

    private companion object {
        const val RESTART_DELAY_MS = 3_000L
    }
}
