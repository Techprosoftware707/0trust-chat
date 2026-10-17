package io.lumen.secure.net

import io.lumen.secure.log.LumenLog

/**
 * What the Rust SDK's certificate verifier ([org.rustls.platformverifier.CertificateVerifier])
 * decided, per host, in memory only. The SDK reports a refused certificate as a generic "error
 * sending request", so this is how a failed sign-in can say *why* the connection was refused
 * (the sign-in error's Details in debug builds, and the log).
 *
 * Holds host names and verifier status codes, nothing secret. Never throws: it is called from the
 * verifier's JNI path.
 */
object TlsDiagnostics {
    data class Verdict(val host: String, val status: String, val reason: String?, val atMillis: Long) {
        val ok get() = status == OK
    }

    const val OK = "Ok"
    private const val MAX_HOSTS = 16

    private val byHost = LinkedHashMap<String, Verdict>()
    @Volatile private var lastFailure: Verdict? = null

    fun record(host: String, status: String, reason: String?) {
        try {
            val v = Verdict(host.lowercase(), status, reason?.take(600), System.currentTimeMillis())
            synchronized(byHost) {
                byHost.remove(v.host)
                byHost[v.host] = v
                while (byHost.size > MAX_HOSTS) byHost.remove(byHost.keys.first())
            }
            if (!v.ok) {
                lastFailure = v
                // Status and reason only (no host name): what the verifier refused and why.
                LumenLog.w("tls", "certificate refused: $status" + (reason?.let { " ($it)" } ?: ""))
            }
        } catch (_: Throwable) {
            // Diagnostics must never break a TLS handshake.
        }
    }

    /** The latest verdict for [host], or null if the verifier has not seen it in this process. */
    fun verdict(host: String): Verdict? = synchronized(byHost) { byHost[host.lowercase()] }

    /** The latest refusal at or after [sinceMillis]. */
    fun failureSince(sinceMillis: Long): Verdict? = lastFailure?.takeIf { it.atMillis >= sinceMillis }
}
