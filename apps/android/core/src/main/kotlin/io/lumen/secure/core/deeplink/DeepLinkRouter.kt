package io.lumen.secure.core.deeplink

import io.lumen.secure.core.auth.SsoRedirect
import io.lumen.secure.core.matrix.MatrixIds
import java.net.URLDecoder
import java.nio.charset.StandardCharsets

sealed interface DeepLinkRoute {
    /** Completes the pending sign-in. [callbackUrl] is passed to `SsoHandler.finish`. */
    data class SsoCallback(val loginToken: String, val callbackUrl: String) : DeepLinkRoute

    /** A room ID (`!…`) or alias (`#…`). The user confirms before anything is joined. */
    data class Room(val id: String, val via: List<String> = emptyList(), val eventId: String? = null) : DeepLinkRoute

    /** A user ID. The user confirms before a chat is started. */
    data class User(val id: String) : DeepLinkRoute

    data object Reject : DeepLinkRoute
}

/**
 * Routes incoming links (integration.md §8). Contract pinned by
 * apps/shared/test-vectors/deeplinks.json; [appLinkHosts] adds the Android App Links hosts
 * (`https://<web_app_url>/#/room/<id>`, `#/user/<id>`), which are empty in the shared vectors.
 * This only parses: joining or opening always asks the user first.
 */
object DeepLinkRouter {
    private const val MAX_URL_LENGTH = 4096
    private val tokenPattern = Regex("^[\\x21-\\x7e]{1,1024}$")

    fun route(
        url: String,
        pendingSsoNonce: String?,
        appScheme: String = "io.lumen.secure",
        appLinkHosts: Set<String> = emptySet(),
    ): DeepLinkRoute {
        val s = url.trim()
        if (s.isEmpty() || s.length > MAX_URL_LENGTH || s.any { it.isISOControl() || it == ' ' }) return DeepLinkRoute.Reject
        val colon = s.indexOf(':')
        if (colon <= 0) return DeepLinkRoute.Reject
        val scheme = s.substring(0, colon).lowercase()
        val rest = s.substring(colon + 1)
        return when (scheme) {
            appScheme.lowercase() -> routeSso(s, rest, pendingSsoNonce)
            "matrix" -> routeMatrixUri(rest)
            "https" -> routeHttps(rest, appLinkHosts)
            else -> DeepLinkRoute.Reject
        }
    }

    // io.lumen.secure:/sso-callback?n=…&loginToken=…  (also the //sso-callback authority form)
    private fun routeSso(full: String, rest: String, pendingNonce: String?): DeepLinkRoute {
        val beforeFragment = rest.substringBefore('#')
        val path = beforeFragment.substringBefore('?')
        val query = beforeFragment.substringAfter('?', "")
        val isCallback = path == "/${SsoRedirect.CALLBACK_PATH}" || path == "//${SsoRedirect.CALLBACK_PATH}" ||
            path == "//${SsoRedirect.CALLBACK_PATH}/"
        if (!isCallback) return DeepLinkRoute.Reject
        val params = parseQuery(query) ?: return DeepLinkRoute.Reject
        val nonce = params[SsoRedirect.NONCE_PARAM]?.singleOrNull()
        if (!SsoRedirect.nonceMatches(pendingNonce, nonce)) return DeepLinkRoute.Reject
        val token = params["loginToken"]?.singleOrNull() ?: return DeepLinkRoute.Reject
        if (!tokenPattern.matches(token)) return DeepLinkRoute.Reject
        return DeepLinkRoute.SsoCallback(token, full)
    }

    // https://matrix.to/#/<id>[/<event>][?via=…]   or   https://<app link host>/#/room/<id>
    private fun routeHttps(rest: String, appLinkHosts: Set<String>): DeepLinkRoute {
        if (!rest.startsWith("//")) return DeepLinkRoute.Reject
        val hashIdx = rest.indexOf('#')
        if (hashIdx < 0) return DeepLinkRoute.Reject
        val authorityAndPath = rest.substring(2, hashIdx)
        val fragment = rest.substring(hashIdx + 1)
        val host = authorityAndPath.substringBefore('/')
        val path = authorityAndPath.substring(host.length)
        if (host.contains('@') || host.contains('?') || path.contains('?')) return DeepLinkRoute.Reject
        if (path != "" && path != "/") return DeepLinkRoute.Reject
        val lowerHost = host.lowercase()
        return when {
            lowerHost == "matrix.to" -> routeMatrixTo(fragment)
            lowerHost in appLinkHosts.map { it.lowercase() } -> routeWebApp(fragment)
            else -> DeepLinkRoute.Reject
        }
    }

    private fun routeMatrixTo(fragment: String): DeepLinkRoute {
        if (!fragment.startsWith("/")) return DeepLinkRoute.Reject
        val idPart = fragment.substring(1).substringBefore('?')
        val via = parseQuery(fragment.substringAfter('?', ""))?.get("via").orEmpty()
        val segments = idPart.split('/').map { decode(it) ?: return DeepLinkRoute.Reject }
        val primary = segments.firstOrNull() ?: return DeepLinkRoute.Reject
        val event = segments.getOrNull(1)?.takeIf { MatrixIds.isEventId(it) }
        return entity(primary, via, event)
    }

    private fun routeWebApp(fragment: String): DeepLinkRoute {
        // The web client's routes: #/room/<id> and #/user/<id>
        val parts = fragment.removePrefix("/").substringBefore('?').split('/')
        if (parts.size < 2) return DeepLinkRoute.Reject
        val id = decode(parts[1]) ?: return DeepLinkRoute.Reject
        return when (parts[0]) {
            "room" -> if (MatrixIds.isRoomId(id) || MatrixIds.isRoomAlias(id)) DeepLinkRoute.Room(id) else DeepLinkRoute.Reject
            "user" -> if (MatrixIds.isUserId(id)) DeepLinkRoute.User(id) else DeepLinkRoute.Reject
            else -> DeepLinkRoute.Reject
        }
    }

    // matrix:u/alice:example.com, matrix:r/lounge:example.com, matrix:roomid/abc:example.com[/e/event]
    private fun routeMatrixUri(rest: String): DeepLinkRoute {
        if (rest.startsWith("//")) return DeepLinkRoute.Reject // authority form is not used by MSC2312 links
        val pathPart = rest.substringBefore('#').substringBefore('?')
        val via = parseQuery(rest.substringBefore('#').substringAfter('?', ""))?.get("via").orEmpty()
        val segs = pathPart.split('/')
        if (segs.size < 2) return DeepLinkRoute.Reject
        val body = decode(segs[1]) ?: return DeepLinkRoute.Reject
        val event = if (segs.size >= 4 && segs[2] == "e") decode(segs[3])?.let { "$$it" }?.takeIf { MatrixIds.isEventId(it) } else null
        val id = when (segs[0]) {
            "u" -> "@$body"
            "r" -> "#$body"
            "roomid" -> "!$body"
            else -> return DeepLinkRoute.Reject
        }
        return entity(id, via, event)
    }

    private fun entity(id: String, via: List<String>, eventId: String?): DeepLinkRoute = when {
        MatrixIds.isUserId(id) -> DeepLinkRoute.User(id)
        MatrixIds.isRoomId(id) || MatrixIds.isRoomAlias(id) -> DeepLinkRoute.Room(id, via.filter { it.isNotBlank() }.take(10), eventId)
        else -> DeepLinkRoute.Reject
    }

    /** Returns null when the query is malformed. */
    private fun parseQuery(query: String): Map<String, List<String>>? {
        if (query.isEmpty()) return emptyMap()
        val out = linkedMapOf<String, MutableList<String>>()
        for (pair in query.split('&')) {
            if (pair.isEmpty()) continue
            val k = decode(pair.substringBefore('=')) ?: return null
            val v = decode(pair.substringAfter('=', "")) ?: return null
            out.getOrPut(k) { mutableListOf() } += v
        }
        return out
    }

    private fun decode(s: String): String? = try {
        URLDecoder.decode(s.replace("+", "%2B"), StandardCharsets.UTF_8)
    } catch (_: IllegalArgumentException) {
        null
    }
}
