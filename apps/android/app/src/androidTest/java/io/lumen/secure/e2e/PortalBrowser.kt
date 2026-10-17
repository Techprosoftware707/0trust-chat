package io.lumen.secure.e2e

import java.io.IOException
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import java.net.URLEncoder
import javax.net.ssl.HttpsURLConnection

/**
 * Stands in for the browser during the end-to-end test: HTTPS requests with a cookie jar and
 * redirects followed by hand, so the chain can stop at the app's own scheme exactly where a browser
 * would hand the URL to the app.
 *
 * It runs inside the app's process (instrumentation), so it uses the app's network security
 * config: the server's private test CA is trusted only because the device has it installed as a
 * user CA, and only in this debuggable build. Certificates and host names are verified as usual.
 *
 * Nothing it handles (passwords, cookies, codes, login tokens) is logged; error messages carry
 * host and path only, never query strings.
 */
internal class PortalBrowser {
    private val cookies = CookieJar()

    class Response(val status: Int, val location: String?, val body: String)

    fun get(url: String): Response = request("GET", url, form = null, referer = null)

    fun postForm(url: String, form: Map<String, String>, referer: String): Response = request("POST", url, form, referer)

    /** Portal sign-in (the same form a person fills in the browser, CSRF token included). */
    fun signIn(base: String, username: String, password: String) {
        val loginUrl = "https://$base/accounts/login/"
        val page = get(loginUrl)
        check(page.status == 200) { "portal sign-in page: HTTP ${page.status}" }
        val csrf = CSRF.find(page.body)?.groupValues?.get(1) ?: error("portal sign-in page has no CSRF token")
        val r = postForm(loginUrl, mapOf("csrfmiddlewaretoken" to csrf, "login" to username, "password" to password), referer = loginUrl)
        check(r.status == 302) { "portal sign-in was not accepted (HTTP ${r.status}, expected a redirect)" }
    }

    /**
     * Follows redirects from [start] until one points at [scheme] (the app); returns that URL.
     * Fails on anything that is not a redirect (for example a confirmation page).
     */
    fun followUntilScheme(start: String, scheme: String, maxHops: Int = 15): Pair<String, List<String>> {
        var url = start
        val hops = mutableListOf<String>()
        repeat(maxHops) {
            val r = get(url)
            hops += "${r.status} ${hostAndPath(url)}"
            val loc = r.location
            if (r.status !in 300..399 || loc == null) {
                throw AssertionError("sign-in chain stopped with HTTP ${r.status} at ${hostAndPath(url)} (hops: $hops)")
            }
            if (loc.startsWith("$scheme:")) return loc to hops
            url = URL(URL(url), loc).toString()
        }
        throw AssertionError("sign-in chain did not reach $scheme: after $maxHops redirects (hops: $hops)")
    }

    private fun request(method: String, url: String, form: Map<String, String>?, referer: String?): Response {
        val uri = URI(url)
        if (uri.scheme != "https") throw IOException("refusing non-https URL ${hostAndPath(url)}")
        val conn = URL(url).openConnection() as HttpsURLConnection
        try {
            conn.instanceFollowRedirects = false
            conn.connectTimeout = 30_000
            conn.readTimeout = 30_000
            conn.requestMethod = method
            conn.useCaches = false
            conn.setRequestProperty("User-Agent", "Lumen-Android-E2E")
            conn.setRequestProperty("Accept", "text/html,application/xhtml+xml,application/json")
            cookies.header(uri)?.let { conn.setRequestProperty("Cookie", it) }
            if (referer != null) {
                conn.setRequestProperty("Referer", referer)
                URI(referer).let { r -> conn.setRequestProperty("Origin", "${r.scheme}://${r.authority}") }
            }
            if (form != null) {
                conn.doOutput = true
                conn.setRequestProperty("Content-Type", "application/x-www-form-urlencoded")
                val body = form.entries.joinToString("&") { (k, v) -> enc(k) + "=" + enc(v) }
                conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            }
            val status = conn.responseCode
            conn.headerFields.forEach { (name, values) -> if (name.equals("Set-Cookie", ignoreCase = true)) values.forEach { cookies.store(uri, it) } }
            val location = conn.getHeaderField("Location")
            val stream = if (status >= HttpURLConnection.HTTP_BAD_REQUEST) conn.errorStream else conn.inputStream
            val body = stream?.use { it.readBytes().toString(Charsets.UTF_8) } ?: ""
            return Response(status, location, body)
        } finally {
            conn.disconnect()
        }
    }

    /**
     * Browser-style cookies (RFC 6265): sent back as `name=value`, matched by host (or Domain)
     * and path prefix. java.net.CookieManager is not usable here: it treats any cookie with
     * Max-Age as an RFC 2965 cookie and sends it back quoted with `$Path`, which servers (Synapse's
     * OIDC session cookie) do not accept.
     */
    private class CookieJar {
        private class Cookie(val domain: String, val hostOnly: Boolean, val path: String, val name: String, val value: String, val secure: Boolean)

        private val cookies = mutableListOf<Cookie>()

        fun store(uri: URI, header: String) {
            val parts = header.split(';').map { it.trim() }
            val nameValue = parts.first().split('=', limit = 2)
            if (nameValue.size != 2 || nameValue[0].isBlank()) return
            val host = uri.host.lowercase()
            var domain = host
            var hostOnly = true
            var path = "/"
            var secure = false
            var delete = false
            parts.drop(1).forEach { attr ->
                val kv = attr.split('=', limit = 2)
                val value = kv.getOrNull(1)?.trim()
                when (kv[0].trim().lowercase()) {
                    "domain" -> value?.trimStart('.')?.lowercase()?.takeIf { host == it || host.endsWith(".$it") }?.let {
                        domain = it
                        hostOnly = false
                    }
                    "path" -> if (value != null && value.startsWith("/")) path = value
                    "secure" -> secure = true
                    "max-age" -> if ((value?.toLongOrNull() ?: 1L) <= 0L) delete = true
                }
            }
            cookies.removeAll { it.domain == domain && it.path == path && it.name == nameValue[0] }
            if (!delete) cookies += Cookie(domain, hostOnly, path, nameValue[0], nameValue[1], secure)
        }

        fun header(uri: URI): String? {
            val host = uri.host.lowercase()
            val path = uri.rawPath?.takeIf { it.isNotEmpty() } ?: "/"
            return cookies.filter { c ->
                (if (c.hostOnly) host == c.domain else host == c.domain || host.endsWith(".${c.domain}")) &&
                    (path == c.path || path.startsWith(if (c.path.endsWith("/")) c.path else c.path + "/")) &&
                    (!c.secure || uri.scheme == "https")
            }.sortedByDescending { it.path.length }.joinToString("; ") { "${it.name}=${it.value}" }.ifEmpty { null }
        }
    }

    companion object {
        private val CSRF = Regex("name=\"csrfmiddlewaretoken\" value=\"([^\"]+)\"")

        private fun enc(s: String) = URLEncoder.encode(s, "UTF-8")

        /** For messages: never the query (it can hold codes and login tokens). */
        fun hostAndPath(url: String): String = try {
            URI(url).let { "${it.host}${it.rawPath ?: ""}" }
        } catch (_: Exception) {
            "<unparseable URL>"
        }
    }
}
