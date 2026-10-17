package io.lumen.secure

import org.junit.AfterClass
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.BeforeClass
import org.junit.Test
import org.rustls.platformverifier.CertificateVerifier
import java.net.InetAddress
import java.net.ServerSocket
import java.security.KeyStore
import java.security.cert.CertPathValidatorException
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate

/**
 * The revocation step of the Rust SDK's certificate verifier (CertificateVerifier.checkRevocation),
 * on the JVM's PKIX implementation, which Android's (libcore ojluni RevocationChecker) is taken from.
 * A local test CA (src/test/resources/revocation, keys discarded) issued, valid until 2045:
 *  - crl-only-good / crl-only-revoked: CA issuers but no OCSP responder, CRL at
 *    http://127.0.0.1:45671/lumen-test.crl (served here; it lists crl-only-revoked), the shape of
 *    Let's Encrypt certificates since May 2025;
 *  - crl-unreachable: no OCSP responder, CRL at a closed port;
 *  - ocsp-and-crl-unreachable: OCSP responder and CRL, both at a closed port (the old shape).
 *
 * The case that broke sign-in: with upstream's options (OCSP first) a certificate without OCSP
 * responder whose CRL cannot be fetched is refused although nothing says it is revoked.
 */
class RevocationCheckTest {
    @Test
    fun crlOnlyCertificateNotOnTheCrlIsAccepted() {
        assertNull(check(cert("crl-only-good.crt")))
    }

    @Test
    fun crlOnlyCertificateOnTheCrlIsRevoked() {
        val e = check(cert("crl-only-revoked.crt"))
        assertNotNull("a certificate the CRL lists is refused", e)
        assertEquals(CertPathValidatorException.BasicReason.REVOKED, e!!.reason)
    }

    @Test
    fun crlOnlyCertificateWhoseCrlCannotBeFetchedIsASoftFailure() {
        assertNull(check(cert("crl-unreachable.crt")))
    }

    @Test
    fun certificateWithOcspResponderIsCheckedAsUpstreamDoes() {
        // OCSP responder and CRL both unreachable: two soft failures, accepted (unchanged behaviour).
        assertNull(check(cert("ocsp-and-crl-unreachable.crt")))
        assertEquals(CertificateVerifier.revocationOptions(crlOnly = false), UPSTREAM_OPTIONS)
    }

    /** The behaviour this replaces, kept as a record of why sign-in failed. */
    @Test
    fun upstreamOptionsRefuseACrlOnlyCertificateWhoseCrlCannotBeFetched() {
        val e = CertificateVerifier.checkRevocation(anchors, listOf(cert("crl-unreachable.crt"), root), null, UPSTREAM_OPTIONS)
        assertNotNull(e)
        assertTrue(e!!.message, e.message!!.contains("does not specify OCSP responder"))
        assertTrue("not a revocation: ${e.reason}", e.reason != CertPathValidatorException.BasicReason.REVOKED)
    }

    private fun check(leaf: X509Certificate) = CertificateVerifier.checkRevocation(anchors, listOf(leaf, root), null)

    companion object {
        private val UPSTREAM_OPTIONS = java.util.EnumSet.of(
            java.security.cert.PKIXRevocationChecker.Option.SOFT_FAIL,
            java.security.cert.PKIXRevocationChecker.Option.ONLY_END_ENTITY,
        )
        private val factory = CertificateFactory.getInstance("X.509")
        private fun bytes(name: String) = RevocationCheckTest::class.java.getResourceAsStream("/revocation/$name")!!.use { it.readBytes() }
        private fun cert(name: String) = factory.generateCertificate(bytes(name).inputStream()) as X509Certificate
        private val root = cert("root.crt")
        private val anchors: KeyStore = KeyStore.getInstance(KeyStore.getDefaultType()).apply {
            load(null)
            setCertificateEntry("lumen-test-root", root)
        }
        private lateinit var server: ServerSocket

        /** A minimal HTTP/1.1 responder for the CRL (android.jar has no HTTP server). */
        @BeforeClass
        @JvmStatic
        fun serveCrl() {
            val crl = bytes("lumen-test.crl")
            server = ServerSocket(45671, 8, InetAddress.getByName("127.0.0.1"))
            Thread {
                while (!server.isClosed) {
                    val socket = try {
                        server.accept()
                    } catch (_: java.io.IOException) {
                        break
                    }
                    socket.use { sock ->
                        val reader = sock.getInputStream().bufferedReader(Charsets.US_ASCII)
                        val requestLine = reader.readLine() ?: return@use
                        while (!reader.readLine().isNullOrEmpty()) Unit
                        val out = sock.getOutputStream()
                        if (requestLine.startsWith("GET /lumen-test.crl ")) {
                            out.write("HTTP/1.1 200 OK\r\nContent-Type: application/pkix-crl\r\nContent-Length: ${crl.size}\r\nConnection: close\r\n\r\n".toByteArray())
                            out.write(crl)
                        } else {
                            out.write("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".toByteArray())
                        }
                        out.flush()
                    }
                }
            }.apply { isDaemon = true }.start()
        }

        @AfterClass
        @JvmStatic
        fun stop() = server.close()
    }
}
