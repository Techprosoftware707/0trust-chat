package io.lumen.secure.matrix

import android.content.Context
import io.lumen.secure.BuildConfig
import org.matrix.rustcomponents.sdk.Client
import org.matrix.rustcomponents.sdk.ClientBuilder
import org.matrix.rustcomponents.sdk.ClientSessionDelegate
import org.matrix.rustcomponents.sdk.SlidingSyncVersionBuilder
import org.matrix.rustcomponents.sdk.SqliteStoreBuilder
import uniffi.matrix_sdk.BackupDownloadStrategy
import java.io.File

/**
 * Builds the Rust SDK client the one way the app does (sign-in, restore, and the SDK TLS tests):
 * encrypted SQLite stores, native sliding sync, cross-signing and backups on.
 *
 * With [discoverSlidingSync] the SDK asks the server for its versions while building, so this is
 * the app's first HTTPS request through the SDK's own TLS stack (rustls with Android's certificate
 * verification), not through the platform HTTP client that discovery uses.
 */
object MatrixClients {
    suspend fun build(
        context: Context,
        homeserverUrl: String,
        dataDir: File,
        cacheDir: File,
        storeKey: ByteArray,
        discoverSlidingSync: Boolean,
        sessionDelegate: ClientSessionDelegate,
    ): Client {
        RustPlatform.ensureInitialised(context)
        dataDir.mkdirs()
        cacheDir.mkdirs()
        return ClientBuilder()
            .homeserverUrl(homeserverUrl)
            .sqliteStore(SqliteStoreBuilder(dataDir.absolutePath, cacheDir.absolutePath).key(storeKey))
            .slidingSyncVersionBuilder(if (discoverSlidingSync) SlidingSyncVersionBuilder.DISCOVER_NATIVE else SlidingSyncVersionBuilder.NATIVE)
            .autoEnableCrossSigning(true)
            .autoEnableBackups(true)
            .backupDownloadStrategy(BackupDownloadStrategy.AFTER_DECRYPTION_FAILURE)
            .userAgent("Lumen-Android/${BuildConfig.VERSION_NAME}")
            .setSessionDelegate(sessionDelegate)
            .build()
    }
}
