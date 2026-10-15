package io.lumen.secure

import android.app.Application
import android.webkit.CookieManager
import android.webkit.WebStorage
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import io.lumen.secure.calls.CallManager
import io.lumen.secure.core.security.SecretVault
import io.lumen.secure.data.Settings
import io.lumen.secure.log.LumenLog
import io.lumen.secure.matrix.AuthState
import io.lumen.secure.matrix.EncryptionController
import io.lumen.secure.matrix.MatrixSession
import io.lumen.secure.matrix.RoomListController
import io.lumen.secure.matrix.ServerInfoStore
import io.lumen.secure.matrix.SessionManager
import io.lumen.secure.matrix.TimelineStrings
import io.lumen.secure.push.NotificationAction
import io.lumen.secure.push.NotificationRenderer
import io.lumen.secure.push.Notifier
import io.lumen.secure.push.PushManager
import io.lumen.secure.security.AppLockManager
import io.lumen.secure.security.FileBlobStorage
import io.lumen.secure.security.KeystoreKeyWrapper
import io.lumen.secure.security.SessionStore
import io.lumen.secure.sync.KeepConnectedService
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.matrix.rustcomponents.sdk.NotificationClient
import org.matrix.rustcomponents.sdk.NotificationItem
import org.matrix.rustcomponents.sdk.NotificationProcessSetup
import org.matrix.rustcomponents.sdk.SyncNotificationListener
import java.io.File

/** Process-wide objects (manual dependency injection). */
class AppGraph(private val app: Application) {
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    val settings = Settings(app)
    val keyWrapper = KeystoreKeyWrapper(app, "lumen_vault_v1")
    private val sessionStore = SessionStore(SecretVault(keyWrapper, FileBlobStorage(File(app.noBackupFilesDir, "vault"))))
    val serverInfo = ServerInfoStore(app)
    val sessions = SessionManager(app, sessionStore, serverInfo, scope)
    val notifier = Notifier(app)
    val push = PushManager(app, sessions, serverInfo, scope)
    val calls = CallManager(app, sessions, notifier, settings, scope)
    val appLock = AppLockManager(settings)
    val auth = io.lumen.secure.auth.AuthController(sessions, scope)
    val callSupport = io.lumen.secure.calls.CallSupport()

    private val _roomList = MutableStateFlow<RoomListController?>(null)
    val roomList: StateFlow<RoomListController?> = _roomList.asStateFlow()
    private val _encryption = MutableStateFlow<EncryptionController?>(null)
    val encryption: StateFlow<EncryptionController?> = _encryption.asStateFlow()

    private val ncMutex = Mutex()
    private var notificationClient: Pair<MatrixSession, NotificationClient>? = null
    @Volatile
    private var inForeground = false
    @Volatile
    private var backgroundSync = false

    val timelineStrings: TimelineStrings by lazy {
        TimelineStrings(
            unnamedRoom = app.getString(R.string.room_unnamed),
            deleted = app.getString(R.string.timeline_deleted),
            unableToDecrypt = app.getString(R.string.timeline_utd),
            image = app.getString(R.string.timeline_image),
            file = app.getString(R.string.timeline_file),
            video = app.getString(R.string.timeline_video),
            audio = app.getString(R.string.timeline_audio),
            sticker = app.getString(R.string.timeline_sticker),
            poll = { app.getString(R.string.timeline_poll, it) },
            unsupported = app.getString(R.string.timeline_unsupported),
            callStarted = app.getString(R.string.timeline_call),
            joined = { app.getString(R.string.timeline_joined, it) },
            left = { app.getString(R.string.timeline_left, it) },
            invited = { app.getString(R.string.timeline_invited, it) },
            membershipChanged = { app.getString(R.string.timeline_membership, it) },
            nameChanged = { app.getString(R.string.timeline_name_changed, it) },
            roomNamed = { app.getString(R.string.timeline_room_named, it) },
            topicChanged = app.getString(R.string.timeline_topic_changed),
            encryptionEnabled = app.getString(R.string.timeline_encryption_enabled),
            roomCreated = app.getString(R.string.timeline_room_created),
        )
    }

    fun init() {
        notifier.createChannels()
        push.initFirebaseIfConfigured()
        appLock.init()
        sessions.onSignedIn = ::onSignedIn
        sessions.onSignedOut = { onSignedOut() }
        ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onStart(owner: LifecycleOwner) {
                inForeground = true
                appLock.onForeground()
                sessions.session?.let { s -> scope.launch { s.startSync() } }
            }

            override fun onStop(owner: LifecycleOwner) {
                inForeground = false
                appLock.onBackground()
                val s = sessions.session ?: return
                if (!backgroundSync && calls.active.value == null && calls.ringing.value == null) scope.launch { s.stopSync() }
            }
        })
        scope.launch { sessions.restore() }
        // Ringing or in a call: keep syncing (decline/answered-elsewhere/ended updates arrive
        // through sync) even in the background; afterwards fall back to the normal policy.
        scope.launch {
            combine(calls.ringing, calls.active) { r, a -> r != null || a != null }
                .distinctUntilChanged()
                .collect { busy ->
                    val s = sessions.session ?: return@collect
                    if (busy) s.startSync() else if (!inForeground && !backgroundSync) s.stopSync()
                }
        }
        File(app.cacheDir, "opened").deleteRecursively()
    }

    private fun onSignedIn(session: MatrixSession) {
        _roomList.value = RoomListController(session, timelineStrings).also { it.start() }
        _encryption.value = EncryptionController(session).also { it.start() }
        push.onSignedIn(session)
        scope.launch {
            try {
                session.client.registerNotificationHandler(object : SyncNotificationListener {
                    override fun onNotification(notification: NotificationItem, roomId: String) {
                        // Sync-delivered notifications: while the app runs, or with "Stay connected".
                        val eventId = eventIdOf(notification.rawEvent) ?: return
                        if (inForeground && notifier.visibleRoomId == roomId) return
                        handleNotificationItem(notification, roomId, eventId)
                    }
                })
            } catch (e: Exception) {
                LumenLog.w("notify", "sync notification handler unavailable", e)
            }
            if (inForeground || backgroundSync) session.startSync()
        }
        if (settings.current.keepConnected) {
            try {
                KeepConnectedService.start(app)
            } catch (e: Exception) {
                LumenLog.w("sync", "stay-connected service could not start", e)
            }
        }
    }

    private fun onSignedOut() {
        _roomList.value?.stop()
        _roomList.value = null
        _encryption.value?.stop()
        _encryption.value = null
        notificationClient = null
        notifier.clearAll()
        push.onSignedOut()
        KeepConnectedService.stop(app)
        settings.reset()
        appLock.init()
        // The call widget's WebView storage (it never held the access token) is cleared too.
        scope.launch(Dispatchers.Main) {
            try {
                WebStorage.getInstance().deleteAllData()
                CookieManager.getInstance().removeAllCookies(null)
            } catch (e: Exception) {
                LumenLog.w("session", "WebView storage could not be cleared", e)
            }
        }
    }

    suspend fun notificationClient(session: MatrixSession): NotificationClient = ncMutex.withLock {
        notificationClient?.takeIf { it.first === session }?.second
            ?: session.client.notificationClient(NotificationProcessSetup.SingleProcess(session.syncService()))
                .also { notificationClient = session to it }
    }

    fun handleNotificationItem(item: NotificationItem, roomId: String, eventId: String) {
        val session = sessions.session ?: return
        when (
            val action = NotificationRenderer.render(
                item, roomId, eventId, session.userId, settings.current.preview, notifier.previewStrings, System.currentTimeMillis(),
            )
        ) {
            is NotificationAction.Message -> notifier.showMessage(roomId, eventId, action.text, action.noisy)
            is NotificationAction.Ring -> calls.onIncomingRing(action.ring)
            NotificationAction.Nothing -> Unit
        }
    }

    fun setBackgroundSync(enabled: Boolean) {
        backgroundSync = enabled
        val s = sessions.session ?: return
        scope.launch { if (enabled) s.startSync() else if (!inForeground) s.stopSync() }
    }

    val isSignedIn: Boolean get() = sessions.state.value is AuthState.SignedIn

    private fun eventIdOf(raw: String): String? = try {
        ((Json.parseToJsonElement(raw) as? JsonObject)?.get("event_id") as? JsonPrimitive)?.content
    } catch (_: Exception) {
        null
    }
}
