package io.lumen.secure.net

import io.lumen.secure.BuildConfig
import io.lumen.secure.core.config.HttpGet
import io.lumen.secure.core.config.HttpResponse
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/**
 * Small HTTPS client for discovery and the few client-server endpoints the Rust SDK does not
 * expose (device list). It uses the platform TLS stack with the system trust store; there is no
 * way to relax certificate validation. Cleartext is blocked by the network security config
 * except for loopback hosts in debug builds.
 */
object PlatformHttp : HttpGet {
    private const val MAX_BODY = 256 * 1024
    private const val TIMEOUT_MS = 15_000
    private val userAgent = "Lumen-Android/${BuildConfig.VERSION_NAME}"

    override fun get(url: String): HttpResponse = request("GET", url, null, null)

    fun request(method: String, url: String, bearer: String?, jsonBody: String?): HttpResponse {
        val u = URL(url)
        if (u.protocol != "https" && !(BuildConfig.ALLOW_LOOPBACK_HTTP && u.protocol == "http" && isLoopback(u.host))) {
            throw IOException("refusing non-https URL")
        }
        val conn = u.openConnection() as HttpURLConnection
        try {
            conn.instanceFollowRedirects = false
            conn.connectTimeout = TIMEOUT_MS
            conn.readTimeout = TIMEOUT_MS
            conn.requestMethod = method
            conn.useCaches = false
            conn.setRequestProperty("Accept", "application/json")
            conn.setRequestProperty("User-Agent", userAgent)
            if (bearer != null) conn.setRequestProperty("Authorization", "Bearer $bearer")
            if (jsonBody != null) {
                conn.doOutput = true
                conn.setRequestProperty("Content-Type", "application/json")
                conn.outputStream.use { it.write(jsonBody.toByteArray(Charsets.UTF_8)) }
            }
            val status = conn.responseCode
            val stream = if (status >= 400) conn.errorStream else conn.inputStream
            val body = stream?.use { s ->
                val buf = s.readNBytesCompat(MAX_BODY + 1)
                if (buf.size > MAX_BODY) throw IOException("response too large")
                String(buf, Charsets.UTF_8)
            } ?: ""
            return HttpResponse(status, body)
        } finally {
            conn.disconnect()
        }
    }

    private fun isLoopback(host: String) = io.lumen.secure.core.config.UrlPolicy.isLoopbackHost(host)

    private fun java.io.InputStream.readNBytesCompat(limit: Int): ByteArray {
        val out = java.io.ByteArrayOutputStream()
        val buf = ByteArray(8192)
        var total = 0
        while (total < limit) {
            val n = read(buf, 0, minOf(buf.size, limit - total))
            if (n < 0) break
            out.write(buf, 0, n)
            total += n
        }
        return out.toByteArray()
    }
}
