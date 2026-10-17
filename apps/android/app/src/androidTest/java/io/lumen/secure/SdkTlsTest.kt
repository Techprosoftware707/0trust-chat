package io.lumen.secure

import android.os.Build
import android.security.NetworkSecurityPolicy
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.lumen.secure.core.security.RevocationInfo
import io.lumen.secure.matrix.MatrixClients
import io.lumen.secure.matrix.RustPlatform
import io.lumen.secure.net.TlsDiagnostics
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.matrix.rustcomponents.sdk.Client
import org.matrix.rustcomponents.sdk.ClientSessionDelegate
import org.matrix.rustcomponents.sdk.Session
import java.io.File
import java.io.IOException
import java.security.SecureRandom
import java.security.cert.X509Certificate
import java.util.UUID
import javax.net.ssl.SSLException

/**
 * The Rust SDK makes its own HTTPS requests (rustls, with certificates checked by Android through
 * org.rustls.platformverifier.CertificateVerifier, including a revocation check for chains that end
 * at a public root). Server discovery uses the platform's HTTP client instead, which does not check
 * revocation, so a server can be discovered and then refused by the SDK at "Continue with single
 * sign-on". Android counterpart of apps/ios/LumenTests/SdkTlsTests.swift.
 *
 * Against public servers, on whichever Android version runs it (CI: API 26, 28 and 35):
 *  - Let's Encrypt (ISRG Root X1 test site; since 2025 its certificates name a CRL and no OCSP
 *    responder) and matrix.org: the verifier accepts the chain, the SDK gets through TLS and starts
 *    single sign-on;
 *  - Let's Encrypt's revoked test site: refused as revoked, i.e. the revocation check still works;
 *  - a self-signed certificate: refused.
 *
 * The platform HTTPS client is the control: without a network path to a server the test is skipped,
 * unless the instrumentation argument LUMEN_TLS_REQUIRE_NETWORK=true (CI), which makes it fail.
 * Every verdict is logged with the tag LumenTls.
 */
@RunWith(AndroidJUnit4::class)
class SdkTlsTest {
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
    private val requireNetwork get() = InstrumentationRegistry.getArguments().getString("LUMEN_TLS_REQUIRE_NETWORK") == "true"
    private lateinit var root: File

    @Before
    fun setUp() {
        root = File(context.cacheDir, "tls-test-" + UUID.randomUUID()).apply { mkdirs() }
        RustPlatform.ensureInitialised(context)
        log("device: Android ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT}), ${Build.MODEL}")
    }

    @After
    fun tearDown() {
        root.deleteRecursively()
    }

    // ---- the verifier, with the chains public servers present --------------------------------------

    @Test
    fun verifierAcceptsALetsEncryptCertificate() = assertVerifierAccepts(LE_VALID)

    @Test
    fun verifierAcceptsMatrixOrgsCertificate() = assertVerifierAccepts(MATRIX_ORG)

    @Test
    fun verifierRefusesARevokedLetsEncryptCertificateAsRevoked() {
        val chain = chainOrSkip(LE_REVOKED)
        describe(LE_REVOKED, chain)
        val r = VerifierProbe.verify(context, LE_REVOKED, chain.encoded())
        log("RESULT verifier $LE_REVOKED: code=${r.code} ${r.message}")
        assertEquals("verifier status for $LE_REVOKED (${r.message})", VerifierProbe.REVOKED, r.code)
        // Revoked because the CRL lists it, not because the status could not be determined.
        assertTrue("refused because the CA's revocation list lists it: ${r.message}", r.message?.contains("revoked", ignoreCase = true) == true)
    }

    /** Certificates that name only a CRL: the verifier must be able to fetch it (plain http by design). */
    @Test
    fun crlsOfPublicCertificatesMayBeFetched() {
        val policy = NetworkSecurityPolicy.getInstance()
        for (host in listOf(LE_VALID, MATRIX_ORG)) {
            val leaf = chainOrSkip(host).first()
            val crlHosts = RevocationInfo.crlUris(leaf.getExtensionValue(RevocationInfo.CRL_DISTRIBUTION_POINTS_OID)).mapNotNull { RevocationInfo.host(it) }
            log("RESULT crl hosts of $host: " + crlHosts.joinToString { "$it cleartext=${policy.isCleartextTrafficPermitted(it)}" })
            for (h in crlHosts) assertTrue("the app may fetch the CRL of $host from $h", policy.isCleartextTrafficPermitted(h))
        }
        assertFalse("plain http stays blocked for other hosts", policy.isCleartextTrafficPermitted("example.com"))
        assertFalse("plain http stays blocked for Matrix servers", policy.isCleartextTrafficPermitted(MATRIX_ORG))
    }

    // ---- the SDK, with a client built the way sign-in builds it -------------------------------------

    @Test
    fun sdkStartsSingleSignOnWithAPubliclyTrustedServer() {
        chainOrSkip(MATRIX_ORG)
        val started = System.currentTimeMillis()
        val client = try {
            newClient("https://$MATRIX_ORG")
        } catch (e: Exception) {
            fail("the Rust SDK could not reach $MATRIX_ORG, which the platform client can: ${e.describe()}; verifier: ${verdictSince(MATRIX_ORG, started)}")
            return
        }
        client.use { c ->
            val url = runBlocking { withTimeout(TIMEOUT) { c.startSsoLogin("${BuildConfig.APPLICATION_ID}:/sso-callback?n=tls-test", null) } }.use { it.url() }
            log("RESULT sdk $MATRIX_ORG: single sign-on URL on ${android.net.Uri.parse(url).host}")
            assertTrue("SSO URL ($url)", url.startsWith("https://$MATRIX_ORG/_matrix/client/"))
        }
        assertEquals("verifier verdict for $MATRIX_ORG", TlsDiagnostics.OK, verdictSince(MATRIX_ORG, started)?.status)
    }

    /** Not a Matrix server: the request fails after TLS, so the verifier's verdict is what counts. */
    @Test
    fun sdkGetsThroughTlsWithALetsEncryptServer() {
        chainOrSkip(LE_VALID)
        val started = System.currentTimeMillis()
        val error = sdkRequest(LE_VALID)
        val verdict = verdictSince(LE_VALID, started)
        log("RESULT sdk $LE_VALID: verifier=${verdict?.status} ${verdict?.reason ?: ""}; sdk error=${error?.describe()}")
        assertNotNull("the SDK's verifier saw $LE_VALID", verdict)
        assertEquals("verifier verdict for $LE_VALID (${verdict?.reason})", TlsDiagnostics.OK, verdict?.status)
    }

    @Test
    fun sdkRefusesARevokedCertificate() {
        chainOrSkip(LE_REVOKED)
        val started = System.currentTimeMillis()
        val error = sdkRequest(LE_REVOKED)
        val verdict = verdictSince(LE_REVOKED, started)
        log("RESULT sdk $LE_REVOKED: verifier=${verdict?.status} ${verdict?.reason ?: ""}; sdk error=${error?.describe()}")
        assertNotNull("the SDK refused $LE_REVOKED", error)
        assertEquals("verifier verdict for $LE_REVOKED", "Revoked", verdict?.status)
    }

    @Test
    fun sdkRefusesASelfSignedCertificate() {
        val control = try {
            VerifierProbe.presentedChain(SELF_SIGNED)
            null
        } catch (e: SSLException) {
            e
        } catch (e: IOException) {
            skipOrFail("no network path to $SELF_SIGNED (${e.describe()})")
            return
        }
        assumeTrue("$SELF_SIGNED did not present an untrusted certificate to the platform client", control != null)
        val started = System.currentTimeMillis()
        val error = sdkRequest(SELF_SIGNED)
        val verdict = verdictSince(SELF_SIGNED, started)
        log("RESULT sdk $SELF_SIGNED: verifier=${verdict?.status}; sdk error=${error?.describe()}")
        assertNotNull("the Rust SDK accepted a self-signed certificate", error)
        assertEquals("verifier verdict for $SELF_SIGNED", "UnknownCert", verdict?.status)
    }

    // ---- helpers ------------------------------------------------------------------------------------

    private fun assertVerifierAccepts(host: String) {
        val chain = chainOrSkip(host)
        describe(host, chain)
        val r = VerifierProbe.verify(context, host, chain.encoded())
        log("RESULT verifier $host: code=${r.code} ${r.message ?: ""}")
        assertEquals("verifier status for $host (${r.message})", VerifierProbe.OK, r.code)
    }

    private fun describe(host: String, chain: List<X509Certificate>) {
        val leaf = chain.first()
        val ocsp = RevocationInfo.namesOcspResponder(leaf.getExtensionValue(RevocationInfo.AIA_OID))
        val crls = RevocationInfo.crlUris(leaf.getExtensionValue(RevocationInfo.CRL_DISTRIBUTION_POINTS_OID))
        log("CHAIN $host: ${chain.joinToString(" <- ") { it.subjectX500Principal.name.substringBefore(',') }}; leaf issuer ${leaf.issuerX500Principal.name.substringBefore(',')}; OCSP responder: $ocsp; CRL: $crls")
    }

    /** The SDK verifier's verdict for [host] from this test (the probe tests record verdicts too). */
    private fun verdictSince(host: String, since: Long) = TlsDiagnostics.verdict(host)?.takeIf { it.atMillis >= since }

    /** One request through the SDK's HTTP client; the error, or null if it got an answer. */
    private fun sdkRequest(host: String): Exception? = try {
        newClient("https://$host").use { c -> runBlocking { withTimeout(TIMEOUT) { c.availableSlidingSyncVersions() } } }
        null
    } catch (e: Exception) {
        e
    }

    private fun newClient(homeserverUrl: String): Client = runBlocking {
        withTimeout(TIMEOUT) {
            val dir = File(root, UUID.randomUUID().toString())
            MatrixClients.build(
                context, homeserverUrl, File(dir, "data"), File(dir, "cache"),
                ByteArray(32).also { SecureRandom().nextBytes(it) }, discoverSlidingSync = true, sessionDelegate = NoAccountYet,
            )
        }
    }

    /** Sign-in's state: no session is stored until the login succeeds. */
    private object NoAccountYet : ClientSessionDelegate {
        override fun retrieveSessionFromKeychain(userId: String): Session = throw IllegalStateException("no session")
        override fun saveSessionInKeychain(session: Session) = Unit
    }

    private fun chainOrSkip(host: String): List<X509Certificate> = try {
        VerifierProbe.presentedChain(host)
    } catch (e: IOException) {
        skipOrFail("no network path to $host through the platform client (${e.describe()})")
        throw IllegalStateException("unreachable")
    }

    private fun skipOrFail(why: String) {
        log("SKIP $why")
        if (requireNetwork) fail(why) else assumeTrue(why, false)
    }

    private fun List<X509Certificate>.encoded() = map { it.encoded }.toTypedArray()

    private fun Throwable.describe() = io.lumen.secure.core.log.Redactor.describe(this)

    private fun log(line: String) {
        Log.i(TAG, line)
    }

    private companion object {
        const val TAG = "LumenTls"
        const val TIMEOUT = 90_000L
        const val LE_VALID = "valid-isrgrootx1.letsencrypt.org"
        const val LE_REVOKED = "revoked-isrgrootx1.letsencrypt.org"
        const val MATRIX_ORG = "matrix-client.matrix.org"
        const val SELF_SIGNED = "self-signed.badssl.com"
    }
}
