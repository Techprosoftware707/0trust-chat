package io.lumen.secure.core.auth

import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64

/**
 * One SSO sign-in attempt (integration.md §3 and §8). A random nonce is created and stored
 * before the browser is opened. It travels in the redirect URL
 * (`<scheme>:/sso-callback?n=<nonce>`, a prefix of the whitelisted redirect URI, so Synapse
 * still skips its confirmation page) and must come back unchanged; any other callback is ignored.
 */
data class PendingSso(
    val nonce: String,
    val homeserverUrl: String,
    val serverName: String?,
    val idpId: String?,
    val createdAtMillis: Long,
) {
    fun isExpired(nowMillis: Long): Boolean = nowMillis - createdAtMillis !in 0..MAX_AGE_MILLIS

    companion object {
        /** A sign-in that took longer than this is treated as abandoned. */
        const val MAX_AGE_MILLIS: Long = 15 * 60 * 1000L
    }
}

object SsoRedirect {
    const val CALLBACK_PATH = "sso-callback"
    const val NONCE_PARAM = "n"

    /** The exact redirect URI whitelisted by the server: `<scheme>:/sso-callback`. */
    fun baseRedirectUri(scheme: String): String = "$scheme:/$CALLBACK_PATH"

    fun redirectUrl(scheme: String, nonce: String): String = "${baseRedirectUri(scheme)}?$NONCE_PARAM=$nonce"

    fun newNonce(random: SecureRandom = SecureRandom()): String {
        val bytes = ByteArray(24)
        random.nextBytes(bytes)
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
    }

    /** Constant-time comparison so a callback cannot probe the nonce byte by byte. */
    fun nonceMatches(expected: String?, actual: String?): Boolean {
        if (expected.isNullOrEmpty() || actual.isNullOrEmpty()) return false
        return MessageDigest.isEqual(expected.toByteArray(), actual.toByteArray())
    }
}
