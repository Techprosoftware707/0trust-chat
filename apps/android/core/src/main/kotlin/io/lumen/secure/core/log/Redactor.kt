package io.lumen.secure.core.log

/**
 * Last line of defence for log output (integration.md §9: no tokens, keys, message bodies or room
 * names in logs). Call sites log fixed strings and error *types*; this scrubs anything that slips
 * through: Matrix identifiers, access/login tokens, recovery keys, long secrets, URL paths and
 * queries, and e-mail addresses. Message bodies and room names cannot be recognised by pattern,
 * which is why call sites never pass them.
 */
object Redactor {
    private const val MAX_LENGTH = 2000

    private val rules: List<Pair<Regex, String>> = listOf(
        // Authorization headers and token-looking query/JSON parameters
        Regex("(?i)(bearer\\s+)[^\\s\"']+") to "$1<redacted>",
        Regex("(?i)((?:access_token|refresh_token|loginToken|login_token|token|pushkey|password|passphrase|key)[\"']?\\s*[=:]\\s*[\"']?)[^&\\s\"',}]+") to "$1<redacted>",
        // Synapse/MAS token formats
        Regex("\\b(?:syt|syr|mct|mat|mar)_[A-Za-z0-9_\\-]+") to "<token>",
        // Recovery keys: 12 groups of 4 base58 characters
        Regex("\\b(?:[1-9A-HJ-NP-Za-km-z]{4}\\s){11}[1-9A-HJ-NP-Za-km-z]{4}\\b") to "<recovery-key>",
        // URLs: keep scheme and host, drop path/query/fragment (they carry IDs and tokens)
        Regex("(?i)\\b(https?|wss?|matrix|io\\.lumen\\.[a-z.]+):(//[^/\\s?#\"']*)?[^\\s\"']*") to "$1:$2/…",
        // Matrix identifiers
        Regex("@[A-Za-z0-9._=\\-/+]+:[A-Za-z0-9.\\-]+(?::\\d+)?") to "@<user>",
        Regex("![A-Za-z0-9._=\\-/+]+(?::[A-Za-z0-9.\\-]+(?::\\d+)?)?") to "!<room>",
        Regex("#[A-Za-z0-9._=\\-/+]+:[A-Za-z0-9.\\-]+(?::\\d+)?") to "#<alias>",
        Regex("\\$[A-Za-z0-9._=\\-/+]{8,}(?::[A-Za-z0-9.\\-]+)?") to "\$<event>",
        // E-mail addresses
        Regex("[A-Za-z0-9._%+\\-]+@[A-Za-z0-9.\\-]+\\.[A-Za-z]{2,}") to "<email>",
        // Long base64/hex runs (keys, signatures, nonces)
        Regex("[A-Za-z0-9+/_\\-]{32,}={0,2}") to "<secret>",
    )

    fun redact(message: String?): String {
        if (message.isNullOrEmpty()) return ""
        var out = message.take(MAX_LENGTH)
        for ((re, replacement) in rules) out = re.replace(out, replacement)
        return out.filter { !it.isISOControl() || it == '\n' }
    }

    /** For exceptions: the class name and a redacted message, never the raw message. */
    fun describe(t: Throwable?): String {
        if (t == null) return ""
        return t::class.java.simpleName + (t.message?.let { ": " + redact(it) } ?: "")
    }
}
