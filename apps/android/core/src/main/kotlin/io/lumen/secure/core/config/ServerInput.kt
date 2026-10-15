package io.lumen.secure.core.config

/** What the user typed on the server picker, classified (integration.md §2). */
sealed interface ServerInput {
    /** A server name such as `example.com` (discovery via `/.well-known/matrix/client`). */
    data class ServerName(val name: String) : ServerInput

    /** A full homeserver URL (no discovery; used for servers without a well-known file). */
    data class HomeserverUrl(val url: String) : ServerInput

    data object Invalid : ServerInput

    companion object {
        private val serverNamePattern =
            Regex("^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?::[0-9]{1,5})?$")
        private val ipv6Pattern = Regex("^\\[[0-9a-f:.]+](?::[0-9]{1,5})?$")

        /**
         * Accepts a server name (`example.com`, `example.com:8448`), a Matrix user ID
         * (`@alice:example.com`, the server part is used) or an http(s) URL (validated by
         * [UrlPolicy]).
         */
        fun parse(raw: String, debug: Boolean): ServerInput {
            val s = raw.trim()
            if (s.isEmpty() || s.length > 255) return Invalid
            if (s.contains("://")) {
                return UrlPolicy.validateEndpointUrl(s, debug)?.let(::HomeserverUrl) ?: Invalid
            }
            val candidate = if (s.startsWith("@")) {
                val idx = s.indexOf(':')
                if (idx <= 1 || idx == s.length - 1) return Invalid
                s.substring(idx + 1)
            } else {
                s
            }.lowercase()
            return if (isValidServerName(candidate)) ServerName(candidate) else Invalid
        }

        fun isValidServerName(name: String): Boolean {
            if (name.isEmpty() || name.length > 255) return false
            val ok = serverNamePattern.matches(name) || ipv6Pattern.matches(name)
            if (!ok) return false
            val port = name.substringAfterLast(']', name).substringAfter(':', "")
            return port.isEmpty() || port.toInt() in 1..65535
        }
    }
}
