package io.lumen.secure

import android.content.Context
import java.net.URL
import java.security.cert.X509Certificate
import javax.net.ssl.HttpsURLConnection

/**
 * Test access to the Rust SDK's certificate verifier ([org.rustls.platformverifier.CertificateVerifier]),
 * called exactly as the native side calls it (same JNI method, same result fields), and to the
 * certificate chains public servers present (fetched with the platform's HTTPS client, which checks
 * the chain but not revocation).
 */
object VerifierProbe {
    const val OK = 0
    const val UNKNOWN_CERT = 3
    const val REVOKED = 4
    const val INVALID_ENCODING = 5
    const val SERVER_AUTH = "1.3.6.1.5.5.7.3.1"

    data class Result(val code: Int, val message: String?)

    fun verify(context: Context, serverName: String, chain: Array<ByteArray>, ocspResponse: ByteArray? = null): Result {
        val cls = Class.forName("org.rustls.platformverifier.CertificateVerifier")
        val m = cls.getDeclaredMethod(
            "verifyCertificateChain",
            Context::class.java, String::class.java, String::class.java, Array<String>::class.java,
            ByteArray::class.java, Long::class.javaPrimitiveType, Array<ByteArray>::class.java,
        )
        m.isAccessible = true
        val result = m.invoke(null, context, serverName, "RSA", arrayOf(SERVER_AUTH), ocspResponse, System.currentTimeMillis(), chain)
        fun field(name: String) = result.javaClass.getDeclaredField(name).apply { isAccessible = true }
        return Result(field("code").getInt(result), field("message").get(result) as String?)
    }

    /** The chain [host] presents (end entity first), as the platform's HTTPS client received it. */
    fun presentedChain(host: String): List<X509Certificate> {
        val conn = URL("https://$host/").openConnection() as HttpsURLConnection
        conn.connectTimeout = 20_000
        conn.readTimeout = 20_000
        conn.instanceFollowRedirects = false
        try {
            conn.connect()
            return conn.serverCertificates.map { it as X509Certificate }
        } finally {
            conn.disconnect()
        }
    }
}
