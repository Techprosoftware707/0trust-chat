package io.lumen.secure.matrix

import android.content.Context
import io.lumen.secure.BuildConfig
import io.lumen.secure.log.LumenLog
import org.matrix.rustcomponents.sdk.LogLevel
import org.matrix.rustcomponents.sdk.TracingConfiguration
import org.matrix.rustcomponents.sdk.initPlatform

/**
 * One-time Rust SDK runtime setup. Release builds write no SDK logs at all (the SDK's own logs
 * contain identifiers); debug builds write warnings to logcat. No Sentry, no log files.
 *
 * First the SDK gets the JVM and the application context ([org.matrix.rustsdk.Android.init]):
 * its TLS verifier (rustls-platform-verifier) calls Android's trust manager through
 * [org.rustls.platformverifier.CertificateVerifier], which follows the app's network security
 * config. Without this step no TLS connection of the SDK can be verified.
 */
object RustPlatform {
    @Volatile
    private var initialised = false

    /** True once the SDK has the JVM and context for TLS verification (checked by RustTlsTest). */
    @Volatile
    var tlsVerifierReady = false
        private set

    @Synchronized
    fun ensureInitialised(context: Context) {
        if (initialised) return
        try {
            org.matrix.rustsdk.Android.init(context.applicationContext)
            tlsVerifierReady = true
        } catch (e: Throwable) {
            // UnsatisfiedLinkError included: the SDK's TLS connections will then fail visibly.
            LumenLog.e("rust", "Android platform init failed", e)
        }
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
