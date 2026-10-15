package io.lumen.secure.core.config

import java.net.URI
import java.net.URISyntaxException

/**
 * URL policy for every server-provided or user-provided endpoint (integration.md §2):
 * - `https` only;
 * - `http` only for loopback hosts, and only in debug builds;
 * - no user-info (credentials) in the URL;
 * - malformed URLs are rejected (callers drop them, they are never followed).
 *
 * Contract pinned by apps/shared/test-vectors/url-validation.json.
 */
object UrlPolicy {

    private const val MAX_URL_LENGTH = 2048

    /**
     * Validates and normalises a server base URL (homeserver, push gateway base):
     * lowercase scheme and host, no trailing slash, no query and no fragment.
     * Returns null when the URL is not acceptable.
     */
    fun validateEndpointUrl(raw: String?, debug: Boolean): String? {
        val uri = parseAllowed(raw, debug) ?: return null
        val scheme = uri.scheme.lowercase()
        val host = uri.host.lowercase()
        val port = if (uri.port >= 0) ":${uri.port}" else ""
        val path = (uri.rawPath ?: "").trimEnd('/')
        return "$scheme://$host$port$path"
    }

    /**
     * Validates a link URL (portal, sign-up, account, privacy, help, …). The URL is returned as
     * given (trimmed) when acceptable, so paths, trailing slashes and queries are preserved.
     */
    fun validateLinkUrl(raw: String?, debug: Boolean = false): String? {
        parseAllowed(raw, debug) ?: return null
        return raw!!.trim()
    }

    fun isLoopbackHost(hostname: String): Boolean {
        val h = hostname.lowercase().removeSurrounding("[", "]")
        return h == "localhost" || h == "127.0.0.1" || h == "::1" || h.endsWith(".localhost")
    }

    private fun parseAllowed(raw: String?, debug: Boolean): URI? {
        val s = raw?.trim() ?: return null
        if (s.isEmpty() || s.length > MAX_URL_LENGTH) return null
        if (s.any { it.isWhitespace() || it.code < 0x20 || it.code == 0x7f }) return null
        val uri = try {
            URI(s)
        } catch (_: URISyntaxException) {
            return null
        }
        if (uri.isOpaque) return null
        val scheme = uri.scheme?.lowercase() ?: return null
        // A null host means an authority java.net.URI could not parse as host[:port]
        // (for example "https://" or a registry-based authority): reject.
        val host = uri.host ?: return null
        if (host.isEmpty()) return null
        if (uri.rawUserInfo != null) return null
        // Reject anything that smuggles an '@' into the authority.
        if (uri.rawAuthority?.contains('@') == true) return null
        return when (scheme) {
            "https" -> uri
            "http" -> if (debug && isLoopbackHost(host)) uri else null
            else -> null
        }
    }
}
