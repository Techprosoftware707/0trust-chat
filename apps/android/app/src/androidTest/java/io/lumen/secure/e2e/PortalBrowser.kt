package io.lumen.secure.e2e

import java.io.IOException
import java.net.CookieManager
import java.net.CookiePolicy
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
    private val cookies = CookieManager(null, CookiePolicy.ACCEPT_ALL)

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
            cookies.get(uri, emptyMap())["Cookie"]?.takeIf { it.isNotEmpty() }?.let {
                conn.setRequestProperty("Cookie", it.joinToString("; "))
            }
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
            cookies.put(uri, conn.headerFields.filterKeys { it != null })
            val location = conn.getHeaderField("Location")
            val stream = if (status >= HttpURLConnection.HTTP_BAD_REQUEST) conn.errorStream else conn.inputStream
            val body = stream?.use { it.readBytes().toString(Charsets.UTF_8) } ?: ""
            return Response(status, location, body)
        } finally {
            conn.disconnect()
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
