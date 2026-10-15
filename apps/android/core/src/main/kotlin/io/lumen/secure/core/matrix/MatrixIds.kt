package io.lumen.secure.core.matrix

import io.lumen.secure.core.config.ServerInput

/** Syntactic checks for Matrix identifiers (spec appendices, "Identifier grammar"). */
object MatrixIds {
    private const val MAX_ID_LENGTH = 255

    fun isUserId(id: String): Boolean = check(id, '@') { local -> local.isNotEmpty() && local.all { it.code in 0x21..0x7e && it != ':' } }

    /**
     * Room IDs: `!opaque:server` (room versions 1–11) or, since room version 12 (MSC4291),
     * `!` + the unpadded URL-safe base64 of the create event's reference hash (no server part).
     */
    fun isRoomId(id: String): Boolean =
        v12RoomId.matches(id) || check(id, '!') { local -> local.isNotEmpty() && local.none { it.isWhitespace() || it == '/' } }

    private val v12RoomId = Regex("^![A-Za-z0-9_-]{43}$")

    fun isRoomAlias(id: String): Boolean = check(id, '#') { local -> local.isNotEmpty() && local.none { it.isWhitespace() || it == '/' } }

    fun isEventId(id: String): Boolean =
        id.length in 2..MAX_ID_LENGTH && id[0] == '$' && id.drop(1).none { it.isWhitespace() || it == '/' }

    /** The server part of a user/room ID or alias (`@a:example.com` → `example.com`). */
    fun serverName(id: String): String? = id.indexOf(':').takeIf { it > 0 }?.let { id.substring(it + 1) }?.ifEmpty { null }

    private inline fun check(id: String, sigil: Char, localOk: (String) -> Boolean): Boolean {
        if (id.length < 4 || id.length > MAX_ID_LENGTH || id[0] != sigil) return false
        val idx = id.indexOf(':')
        if (idx <= 1) return false
        val server = id.substring(idx + 1)
        return localOk(id.substring(1, idx)) && ServerInput.isValidServerName(server.lowercase())
    }
}
