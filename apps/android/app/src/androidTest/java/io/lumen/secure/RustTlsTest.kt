package io.lumen.secure

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.lumen.secure.matrix.RustPlatform
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.util.Base64

/**
 * The Rust SDK verifies TLS through rustls-platform-verifier, whose JVM half lives in the app
 * (org.rustls.platformverifier.CertificateVerifier) and needs `org.matrix.rustsdk.Android.init`.
 * Without both, every connection of the SDK fails. Runs without a server.
 */
@RunWith(AndroidJUnit4::class)
class RustTlsTest {
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext

    @Test
    fun sdkGetsTheJvmAndContextForTlsVerification() {
        RustPlatform.ensureInitialised(context)
        assertTrue("org.matrix.rustsdk.Android.init ran", RustPlatform.tlsVerifierReady)
    }

    @Test
    fun verifierRejectsACertificateNoTrustedCaIssued() {
        assertEquals(UNKNOWN_CERT, verify(arrayOf(Base64.getDecoder().decode(UNTRUSTED_SELF_SIGNED))))
    }

    @Test
    fun verifierRejectsGarbage() {
        assertEquals(INVALID_ENCODING, verify(arrayOf(byteArrayOf(1, 2, 3))))
    }

    private fun verify(chain: Array<ByteArray>): Int = VerifierProbe.verify(context, "untrusted.lumen.invalid", chain).code

    private companion object {
        const val UNKNOWN_CERT = VerifierProbe.UNKNOWN_CERT
        const val INVALID_ENCODING = VerifierProbe.INVALID_ENCODING

        /** Self-signed, CN=untrusted.lumen.invalid, serverAuth, valid until 2046; its key was discarded. */
        const val UNTRUSTED_SELF_SIGNED = "MIIB1DCCAXqgAwIBAgIUXZDAhXpgTqHILM+7cDEnGvLV4yowCgYIKoZIzj0EAwIwIjEgMB4GA1UEAwwXdW50cnVzdGVkLmx1bWVuLmludmFsaWQwHhcNMjYxMDE3MDEyNTE2WhcNNDYxMDEyMDEyNTE2WjAiMSAwHgYDVQQDDBd1bnRydXN0ZWQubHVtZW4uaW52YWxpZDBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABP56Tnlu9JWc3IZsOLxklVamMac6FwZ2LSvs2d3wweVj6f1+LVHLPzpy3tsLxk5Q1n0qL3V7BU/JppqmMZT0JbajgY0wgYowHQYDVR0OBBYEFHAH3AAU3IQC8Q9xrztusQL3yO4CMB8GA1UdIwQYMBaAFHAH3AAU3IQC8Q9xrztusQL3yO4CMA8GA1UdEwEB/wQFMAMBAf8wIgYDVR0RBBswGYIXdW50cnVzdGVkLmx1bWVuLmludmFsaWQwEwYDVR0lBAwwCgYIKwYBBQUHAwEwCgYIKoZIzj0EAwIDSAAwRQIhAJ/WhqUg4/NpoO7GP8ExXDeiARIXf48+/tItuAEwYcO8AiB/MtUPITIm/dmxtTOnj1Jw78twsRDBb5Ji6fW10wS+8w=="
    }
}
