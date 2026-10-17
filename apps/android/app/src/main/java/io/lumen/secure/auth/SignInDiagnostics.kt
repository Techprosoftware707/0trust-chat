package io.lumen.secure.auth

import android.os.Build
import io.lumen.secure.BuildConfig
import io.lumen.secure.core.log.Redactor
import io.lumen.secure.net.TlsDiagnostics

/**
 * The text behind a sign-in error's "Details" (shown in debug builds only), meant to be read out
 * or copied into a support message: the error's class and redacted message (with causes), the TLS
 * verifier's refusal if one happened during the attempt, and the app and Android versions.
 * Passes through [Redactor]: no tokens, IDs or URL paths.
 */
object SignInDiagnostics {
    fun describe(error: Throwable, attemptStartedMillis: Long): String = buildString {
        append(Redactor.describe(error))
        TlsDiagnostics.failureSince(attemptStartedMillis)?.let { v ->
            append("\nTLS: certificate of ").append(v.host).append(" refused: ").append(v.status)
            v.reason?.let { append(" (").append(Redactor.redact(it)).append(')') }
        }
        append("\nLumen ").append(BuildConfig.VERSION_NAME).append(" (").append(BuildConfig.BUILD_TYPE).append(")")
        append(" · Android ").append(Build.VERSION.RELEASE).append(" (API ").append(Build.VERSION.SDK_INT).append(')')
    }
}
