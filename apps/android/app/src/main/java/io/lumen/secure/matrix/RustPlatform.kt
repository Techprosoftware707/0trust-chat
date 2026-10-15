package io.lumen.secure.matrix

import io.lumen.secure.BuildConfig
import io.lumen.secure.log.LumenLog
import org.matrix.rustcomponents.sdk.LogLevel
import org.matrix.rustcomponents.sdk.TracingConfiguration
import org.matrix.rustcomponents.sdk.initPlatform

/**
 * One-time Rust SDK runtime setup. Release builds write no SDK logs at all (the SDK's own logs
 * contain identifiers); debug builds write warnings to logcat. No Sentry, no log files.
 */
object RustPlatform {
    @Volatile
    private var initialised = false

    @Synchronized
    fun ensureInitialised() {
        if (initialised) return
        try {
            initPlatform(
                TracingConfiguration(
                    logLevel = if (BuildConfig.DEBUG) LogLevel.WARN else LogLevel.ERROR,
                    traceLogPacks = emptyList(),
                    extraTargets = emptyList(),
                    writeToStdoutOrSystem = BuildConfig.DEBUG,
                    writeToFiles = null,
                    sentryConfig = null,
                ),
                false,
            )
        } catch (e: Exception) {
            // Already initialised by an earlier process component: harmless.
            LumenLog.w("rust", "initPlatform failed", e)
        }
        initialised = true
    }
}
