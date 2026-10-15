package io.lumen.secure.matrix

import android.content.Context
import android.os.Build
import androidx.core.content.edit
import io.lumen.secure.BuildConfig
import io.lumen.secure.core.auth.PendingSso
import io.lumen.secure.core.auth.SsoRedirect
import io.lumen.secure.core.config.DiscoveredServer
import io.lumen.secure.core.deeplink.DeepLinkRoute
import io.lumen.secure.core.deeplink.DeepLinkRouter
import io.lumen.secure.core.security.StoredSession
import io.lumen.secure.log.LumenLog
import io.lumen.secure.net.DevicesApi
import io.lumen.secure.security.SessionStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import uniffi.matrix_sdk_common.BackgroundTaskFailureReason
import uniffi.matrix_sdk.BackupDownloadStrategy
import org.matrix.rustcomponents.sdk.Client
import org.matrix.rustcomponents.sdk.ClientBuilder
import org.matrix.rustcomponents.sdk.ClientDelegate
import org.matrix.rustcomponents.sdk.ClientSessionDelegate
import org.matrix.rustcomponents.sdk.Session
import org.matrix.rustcomponents.sdk.SlidingSyncVersion
import org.matrix.rustcomponents.sdk.SlidingSyncVersionBuilder
import org.matrix.rustcomponents.sdk.SqliteStoreBuilder
import org.matrix.rustcomponents.sdk.SsoHandler
import java.io.File
import java.security.SecureRandom

sealed interface AuthState {
    data object Restoring : AuthState
    data class SignedOut(val reason: SignOutReason? = null) : AuthState
    data class SignedIn(val session: MatrixSession) : AuthState
}

enum class SignOutReason { USER, REMOTE, STORE_UNREADABLE }

sealed interface SsoFinishResult {
    data object Success : SsoFinishResult

    /** Not a callback for a pending attempt (stray, replayed or expired): nothing happened. */
    data object Ignored : SsoFinishResult

    data class Failed(val error: Throwable) : SsoFinishResult
}

/**
 * Owns the account: building the Rust client on the Keystore-protected stores, SSO and password
 * sign-in, restoring, and signing out (server logout, then wiping stores and Keystore entries).
 */
class SessionManager(
    private val context: Context,
    private val sessionStore: SessionStore,
    private val serverInfo: ServerInfoStore,
    private val appScope: CoroutineScope,
) {
    private val _state = MutableStateFlow<AuthState>(AuthState.Restoring)
    val state: StateFlow<AuthState> = _state.asStateFlow()
    val session: MatrixSession? get() = (state.value as? AuthState.SignedIn)?.session

    private val mutex = Mutex()
    private val authPrefs = context.getSharedPreferences("lumen_auth", Context.MODE_PRIVATE)
    private val scheme = BuildConfig.APPLICATION_ID

    /** In-memory half of a pending SSO attempt (the persisted half survives process death). */
    private var pendingClient: Pair<Client, SsoHandler>? = null

    /** Called by sign-in/out so other components (push, notifications) can react. */
    var onSignedIn: ((MatrixSession) -> Unit)? = null
    var onSignedOut: ((SignOutReason) -> Unit)? = null

    private val sessionsDataDir get() = File(context.noBackupFilesDir, "sessions")
    private val sessionsCacheDir get() = File(context.cacheDir, "sessions")

    // ---- restore ------------------------------------------------------------------------------

    /** Restores the stored session (idempotent). Returns the session or null when signed out. */
    suspend fun restore(): MatrixSession? = mutex.withLock {
        (state.value as? AuthState.SignedIn)?.let { return it.session }
        val stored = withContext(Dispatchers.IO) { sessionStore.load() }
        if (stored == null) {
            if (hasLeftoverStores()) wipeLocal() // a store without a usable key cannot be opened
            _state.value = AuthState.SignedOut()
            return null
        }
        val (s, key) = stored
        return try {
            val client = buildClient(s.homeserverUrl, s.storeDir, key)
            client.restoreSession(
                Session(
                    accessToken = s.accessToken,
                    refreshToken = s.refreshToken,
                    userId = s.userId,
                    deviceId = s.deviceId,
                    homeserverUrl = s.homeserverUrl,
                    oauthData = s.oauthData,
                    slidingSyncVersion = SlidingSyncVersion.entries.firstOrNull { it.name == s.slidingSyncVersion } ?: SlidingSyncVersion.NATIVE,
                ),
            )
            activate(client, s.storeDir)
        } catch (e: Exception) {
            // Keep the stores: a network or transient error must not destroy keys. The UI offers
            // "Try again" and "Sign out".
            LumenLog.e("session", "restore failed", e)
            _state.value = AuthState.SignedOut(SignOutReason.STORE_UNREADABLE)
            null
        }
    }

    private fun activate(client: Client, storeDir: String): MatrixSession {
        val s = MatrixSession(client, client.userId(), client.deviceId(), client.homeserver(), storeDir, appScope)
        client.setDelegate(
            object : ClientDelegate {
                override fun didReceiveAuthError(isSoftLogout: Boolean) {
                    LumenLog.w("session", "auth error from server (soft=$isSoftLogout)")
                    if (!isSoftLogout) appScope.launch { signOut(serverSide = false, reason = SignOutReason.REMOTE) }
                }

                override fun onBackgroundTaskErrorReport(taskName: String, error: BackgroundTaskFailureReason) {
                    LumenLog.w("session", "background task error")
                }
            },
        )
        _state.value = AuthState.SignedIn(s)
        onSignedIn?.invoke(s)
        return s
    }

    // ---- SSO ------------------------------------------------------------------------------------

    fun pendingSso(): PendingSso? {
        val nonce = authPrefs.getString(K_NONCE, null) ?: return null
        val p = PendingSso(
            nonce = nonce,
            homeserverUrl = authPrefs.getString(K_HS, null) ?: return null,
            serverName = authPrefs.getString(K_SERVER_NAME, null),
            idpId = authPrefs.getString(K_IDP, null),
            createdAtMillis = authPrefs.getLong(K_CREATED, 0),
        )
        return p.takeUnless { it.isExpired(System.currentTimeMillis()) }
    }

    /** Prepares a sign-in and returns the URL to open in Custom Tabs. */
    suspend fun startSso(server: DiscoveredServer): String = mutex.withLock {
        abandonPendingLocked()
        val storeDir = newStoreDir()
        val key = withContext(Dispatchers.IO) { sessionStore.newDbKey(storeDir) }
        val client = buildClient(server.homeserverUrl, storeDir, key)
        val nonce = SsoRedirect.newNonce()
        val idp = server.ssoIdpId
        val handler = client.startSsoLogin(SsoRedirect.redirectUrl(scheme, nonce), idp)
        pendingClient = client to handler
        authPrefs.edit(commit = true) {
            putString(K_NONCE, nonce)
            putString(K_HS, server.homeserverUrl)
            putString(K_SERVER_NAME, server.serverName)
            putString(K_IDP, idp)
            putLong(K_CREATED, System.currentTimeMillis())
            putString(K_STORE, storeDir)
        }
        serverInfo.save(ServerInfo(server.serverName, server.homeserverUrl, server.lumen))
        handler.url()
    }

    /** Handles `io.lumen.secure:/sso-callback?n=…&loginToken=…`; anything else is ignored. */
    suspend fun finishSso(callbackUrl: String): SsoFinishResult = mutex.withLock {
        val pending = pendingSso() ?: return SsoFinishResult.Ignored
        val route = DeepLinkRouter.route(callbackUrl, pending.nonce, appScheme = scheme)
        if (route !is DeepLinkRoute.SsoCallback) return SsoFinishResult.Ignored
        val storeDir = authPrefs.getString(K_STORE, null) ?: return SsoFinishResult.Ignored
        // Single use: whatever happens next, this nonce is consumed.
        authPrefs.edit(commit = true) { remove(K_NONCE) }
        try {
            val (client, handler) = pendingClient ?: run {
                // The process was restarted while the browser was open: rebuild on the same store.
                val key = sessionStore.dbKey(storeDir) ?: throw IllegalStateException("store key missing")
                val c = buildClient(pending.homeserverUrl, storeDir, key)
                c to c.startSsoLogin(SsoRedirect.redirectUrl(scheme, pending.nonce), pending.idpId)
            }
            pendingClient = null
            handler.finish(route.callbackUrl)
            handler.close()
            persistNewSession(client, storeDir, pending.serverName)
            activate(client, storeDir)
            clearPendingPrefs()
            nameThisDevice(client)
            SsoFinishResult.Success
        } catch (e: Exception) {
            LumenLog.w("session", "SSO completion failed", e)
            pendingClient?.first?.close()
            pendingClient = null
            discardStore(storeDir)
            clearPendingPrefs()
            SsoFinishResult.Failed(e)
        }
    }

    suspend fun abandonPendingSso() = mutex.withLock { abandonPendingLocked() }

    private fun abandonPendingLocked() {
        pendingClient?.let { (c, h) -> h.close(); c.close() }
        pendingClient = null
        authPrefs.getString(K_STORE, null)?.let { discardStore(it) }
        clearPendingPrefs()
    }

    private fun clearPendingPrefs() = authPrefs.edit(commit = true) { clear() }

    // ---- password (only when a server offers it, integration.md §2) ----------------------------

    suspend fun passwordLogin(server: DiscoveredServer, username: String, password: String) = mutex.withLock {
        val storeDir = newStoreDir()
        val key = withContext(Dispatchers.IO) { sessionStore.newDbKey(storeDir) }
        val client = buildClient(server.homeserverUrl, storeDir, key)
        try {
            client.login(username.trim(), password, deviceDisplayName(), null)
            serverInfo.save(ServerInfo(server.serverName, server.homeserverUrl, server.lumen))
            persistNewSession(client, storeDir, server.serverName)
            activate(client, storeDir)
        } catch (e: Exception) {
            client.close()
            discardStore(storeDir)
            throw e
        }
    }

    // ---- sign-out -------------------------------------------------------------------------------

    /**
     * Server logout (invalidates the token and deletes the device, integration.md §3), then deletes
     * the local stores, the sealed session and the Keystore key. Returns false when the server
     * could not be told (the local data is deleted anyway).
     */
    suspend fun signOut(serverSide: Boolean = true, reason: SignOutReason = SignOutReason.USER): Boolean = mutex.withLock {
        val s = session
        var serverOk = true
        if (s != null) {
            if (serverSide) {
                serverOk = try {
                    s.client.logout()
                    true
                } catch (e: Exception) {
                    LumenLog.w("session", "server logout failed", e)
                    false
                }
            }
            try {
                s.close()
            } catch (e: Exception) {
                LumenLog.w("session", "close failed", e)
            }
        }
        wipeLocal()
        _state.value = AuthState.SignedOut(reason)
        onSignedOut?.invoke(reason)
        serverOk
    }

    private fun wipeLocal() {
        pendingClient = null
        sessionsDataDir.deleteRecursively()
        sessionsCacheDir.deleteRecursively()
        File(context.cacheDir, "opened").deleteRecursively()
        File(context.cacheDir, "uploads").deleteRecursively()
        sessionStore.wipe()
        serverInfo.clear()
        clearPendingPrefs()
    }

    private fun hasLeftoverStores() = sessionsDataDir.listFiles()?.isNotEmpty() == true

    // ---- helpers ----------------------------------------------------------------------------------

    private suspend fun buildClient(homeserverUrl: String, storeDir: String, key: ByteArray): Client {
        RustPlatform.ensureInitialised()
        val data = File(sessionsDataDir, storeDir).apply { mkdirs() }
        val cache = File(sessionsCacheDir, storeDir).apply { mkdirs() }
        return ClientBuilder()
            .homeserverUrl(homeserverUrl)
            .sqliteStore(SqliteStoreBuilder(data.absolutePath, cache.absolutePath).key(key))
            .slidingSyncVersionBuilder(SlidingSyncVersionBuilder.DISCOVER_NATIVE)
            .autoEnableCrossSigning(true)
            .autoEnableBackups(true)
            .backupDownloadStrategy(BackupDownloadStrategy.AFTER_DECRYPTION_FAILURE)
            .userAgent("Lumen-Android/${BuildConfig.VERSION_NAME}")
            .setSessionDelegate(sessionDelegate(storeDir))
            .build()
    }

    /** Token refreshes are persisted (sealed) as they happen. */
    private fun sessionDelegate(storeDir: String) = object : ClientSessionDelegate {
        override fun retrieveSessionFromKeychain(userId: String): Session {
            val (s, _) = sessionStore.load() ?: throw IllegalStateException("no session")
            return Session(s.accessToken, s.refreshToken, s.userId, s.deviceId, s.homeserverUrl, s.oauthData,
                SlidingSyncVersion.entries.firstOrNull { it.name == s.slidingSyncVersion } ?: SlidingSyncVersion.NATIVE)
        }

        override fun saveSessionInKeychain(session: Session) {
            val serverName = sessionStore.load()?.first?.serverName
            sessionStore.saveSession(session.toStored(storeDir, serverName))
        }
    }

    private fun persistNewSession(client: Client, storeDir: String, serverName: String?) {
        sessionStore.saveSession(client.session().toStored(storeDir, serverName))
    }

    private fun Session.toStored(storeDir: String, serverName: String?) = StoredSession(
        userId = userId, deviceId = deviceId, accessToken = accessToken, refreshToken = refreshToken,
        homeserverUrl = homeserverUrl, oauthData = oauthData, slidingSyncVersion = slidingSyncVersion.name,
        storeDir = storeDir, serverName = serverName,
    )

    private fun nameThisDevice(client: Client) {
        appScope.launch(Dispatchers.IO) {
            try {
                val token = client.session().accessToken
                DevicesApi(client.homeserver().trimEnd('/')) { token }.rename(client.deviceId(), deviceDisplayName())
            } catch (e: Exception) {
                LumenLog.w("session", "could not name device", e)
            }
        }
    }

    private fun discardStore(storeDir: String) {
        File(sessionsDataDir, storeDir).deleteRecursively()
        File(sessionsCacheDir, storeDir).deleteRecursively()
        try {
            sessionStore.removeDbKey(storeDir)
        } catch (e: Exception) {
            LumenLog.w("session", "could not remove store key", e)
        }
    }

    private fun newStoreDir(): String {
        val b = ByteArray(12).also { SecureRandom().nextBytes(it) }
        return b.joinToString("") { "%02x".format(it) }
    }

    companion object {
        private const val K_NONCE = "sso_nonce"
        private const val K_HS = "sso_hs"
        private const val K_SERVER_NAME = "sso_server_name"
        private const val K_IDP = "sso_idp"
        private const val K_CREATED = "sso_created"
        private const val K_STORE = "sso_store"

        /** "Lumen on Pixel 9" (integration.md §3). */
        fun deviceDisplayName(): String = "Lumen on ${Build.MODEL.take(40)}"
    }
}
