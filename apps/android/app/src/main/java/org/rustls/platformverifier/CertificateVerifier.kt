// JVM half of rustls-platform-verifier, which the Matrix Rust SDK uses for every TLS connection.
//
// Ported from https://github.com/rustls/rustls-platform-verifier
// (android/rustls-platform-verifier/src/main/java/org/rustls/platformverifier/CertificateVerifier.kt,
// the Android component 0.2.0 that rustls-platform-verifier 0.7.1 in sdk-android 26.09.28 calls
// through JNI). Copyright (c) 2022 1Password; MIT OR Apache-2.0, see
// assets/licenses/LICENSE-rustls-platform-verifier.txt. The JNI contract (class, method and
// field names, signature, status codes) is unchanged; the native side keeps checking the host
// name itself after this returns Ok.
//
// One deliberate change: the trust anchors come from the app's network security config
// (TrustManagerFactory.init(null)), not from every entry of AndroidCAStore. Upstream accepts
// user-installed CAs in every build. Lumen release builds trust system CAs only; debuggable builds
// also accept user-installed CAs (res/xml/network_security_config.xml, debug-overrides), exactly
// like the app's own HTTPS client. Upstream's test-only mock-root hooks are omitted.
//
// Lumen addition (no change to the decision): every verdict is also handed to
// io.lumen.secure.net.TlsDiagnostics, so a refused connection can say why (the SDK itself only
// reports "error sending request").
package org.rustls.platformverifier

import android.annotation.SuppressLint
import android.content.Context
import android.net.http.X509TrustManagerExtensions
import android.util.Log
import io.lumen.secure.net.TlsDiagnostics
import java.io.ByteArrayInputStream
import java.io.File
import java.security.KeyStore
import java.security.KeyStoreException
import java.security.MessageDigest
import java.security.PublicKey
import java.security.cert.CertPathValidator
import java.security.cert.CertPathValidatorException
import java.security.cert.CertificateException
import java.security.cert.CertificateExpiredException
import java.security.cert.CertificateFactory
import java.security.cert.CertificateNotYetValidException
import java.security.cert.CertificateParsingException
import java.security.cert.PKIXBuilderParameters
import java.security.cert.PKIXRevocationChecker
import java.security.cert.X509Certificate
import java.util.Date
import java.util.EnumSet
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager
import javax.security.auth.x500.X500Principal

// Must match the Rust definition (rustls-platform-verifier src/verification/android.rs).
private enum class StatusCode(val value: Int) {
    Ok(0),
    Unavailable(1),
    Expired(2),
    UnknownCert(3),
    Revoked(4),
    InvalidEncoding(5),
    InvalidExtension(6),
}

// Read by the native side through JNI: fields `code` (int) and `message` (String).
private class VerificationResult(
    val status: StatusCode,
    @Suppress("unused") val message: String? = null,
) {
    @Suppress("unused")
    private val code: Int = status.value
}

// Only JNI calls this object.
@Suppress("unused")
@SuppressLint("LongLogTag")
internal object CertificateVerifier {
    private const val TAG = "rustls-platform-verifier-android"

    private val certFactory: CertificateFactory = CertificateFactory.getInstance("X.509")

    private var systemTrustAnchorCache = hashSetOf<Pair<X500Principal, PublicKey>>()

    @get:Synchronized
    private var systemCertificateDirectory: File? = System.getenv("ANDROID_ROOT")?.let { rootPath ->
        File("$rootPath/etc/security/cacerts")
    }

    /** Only used to recognise public (system) roots for revocation checks, never as trust anchors. */
    @get:Synchronized
    private val systemKeystore: KeyStore? = try {
        KeyStore.getInstance("AndroidCAStore").apply { load(null) }
    } catch (_: Exception) {
        null
    }

    /** The app's network security config decides which anchors are trusted (see the file header). */
    private val trustManager: X509TrustManagerExtensions? by lazy { createTrustManager() }

    private fun createTrustManager(): X509TrustManagerExtensions? {
        val factory = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm())
        try {
            factory.init(null as KeyStore?)
        } catch (e: KeyStoreException) {
            Log.w(TAG, "exception thrown initialising the TrustManagerFactory: $e")
            return null
        }
        val availableTrustManagers = try {
            factory.trustManagers
        } catch (e: RuntimeException) {
            Log.w(TAG, "exception thrown creating a TrustManager: $e")
            return null
        }
        for (manager in availableTrustManagers) {
            if (manager is X509TrustManager) return X509TrustManagerExtensions(manager)
        }
        Log.e(TAG, "failed to find a usable trust manager")
        return null
    }

    @JvmStatic
    private fun verifyCertificateChain(
        @Suppress("UNUSED_PARAMETER") context: Context,
        serverName: String,
        authMethod: String,
        allowedEkus: Array<String>,
        ocspResponse: ByteArray?,
        time: Long,
        certChain: Array<ByteArray>,
    ): VerificationResult {
        val result = verify(serverName, authMethod, allowedEkus, ocspResponse, time, certChain)
        TlsDiagnostics.record(serverName, result.status.name, result.message)
        return result
    }

    private fun verify(
        serverName: String,
        authMethod: String,
        allowedEkus: Array<String>,
        ocspResponse: ByteArray?,
        time: Long,
        certChain: Array<ByteArray>,
    ): VerificationResult {
        // Convert the array of (supposedly) DER bytes into certificates.
        val certificateChain = mutableListOf<X509Certificate>()
        certChain.forEach { certBytes ->
            val certificate = try {
                certFactory.generateCertificate(ByteArrayInputStream(certBytes))
            } catch (e: CertificateException) {
                return VerificationResult(StatusCode.InvalidEncoding)
            }
            certificateChain.add(certificate as X509Certificate)
        }

        // rustls always passes the end-entity certificate first.
        val endEntity = certificateChain[0]

        // Valid at the time rustls provided.
        try {
            endEntity.checkValidity(Date(time))
        } catch (e: CertificateExpiredException) {
            return VerificationResult(StatusCode.Expired)
        } catch (e: CertificateNotYetValidException) {
            return VerificationResult(StatusCode.Expired)
        }

        // Usable for a TLS server.
        if (!verifyCertUsage(endEntity, allowedEkus)) {
            return VerificationResult(StatusCode.InvalidExtension)
        }

        val trustManager = trustManager ?: return VerificationResult(StatusCode.Unavailable)

        // Chain validation against the trusted anchors (host name: pinning/CT only; the native side
        // verifies the host name against the end-entity certificate afterwards). Returns the chain
        // from the end-entity certificate to the trust anchor.
        val validChain = try {
            trustManager.checkServerTrusted(certificateChain.toTypedArray(), authMethod, serverName)
        } catch (e: CertificateException) {
            return VerificationResult(StatusCode.UnknownCert, e.toString())
        }

        // Revocation, best effort and at the end-entity depth only (as upstream): roots that are
        // not public system roots (private or user-installed CAs) are not checked unless the
        // server stapled an OCSP response.
        if (ocspResponse == null && !isKnownRoot(validChain.last())) {
            return VerificationResult(StatusCode.Ok)
        }
        val keystore = systemKeystore ?: return VerificationResult(StatusCode.Ok)

        val parameters = PKIXBuilderParameters(keystore, null)
        val validator = CertPathValidator.getInstance("PKIX")
        val revocationChecker = validator.revocationChecker as PKIXRevocationChecker
        revocationChecker.options = EnumSet.of(
            PKIXRevocationChecker.Option.SOFT_FAIL,
            PKIXRevocationChecker.Option.ONLY_END_ENTITY,
        )
        ocspResponse?.let { providedResponse ->
            revocationChecker.ocspResponses = mapOf(endEntity to providedResponse)
        }
        parameters.certPathCheckers = listOf(revocationChecker)
        parameters.isRevocationEnabled = false
        try {
            validator.validate(certFactory.generateCertPath(validChain), parameters)
        } catch (e: CertPathValidatorException) {
            return VerificationResult(StatusCode.Revoked, e.toString())
        }

        return VerificationResult(StatusCode.Ok)
    }

    private fun verifyCertUsage(certificate: X509Certificate, allowedEkus: Array<String>): Boolean {
        val ekus = try {
            certificate.extendedKeyUsage
        } catch (_: CertificateParsingException) {
            return false
        } catch (_: NullPointerException) {
            // Chromium notes this can happen with malformed EKU data.
            Log.w(TAG, "exception handling certificate EKU")
            return false
        } ?: return true // no EKU extension: nothing to restrict

        return ekus.any { allowedEkus.contains(it) }
    }

    // Android names system anchors after the first four bytes of the subject's MD5 digest,
    // lowercase hex, reversed (as Chromium's X509Util).
    private fun hashPrincipal(principal: X500Principal): String {
        val hexDigits = "0123456789abcdef".toCharArray()
        val digest = MessageDigest.getInstance("MD5").digest(principal.encoded)
        val hexChars = CharArray(8)
        for (i in 0..3) {
            val digestByte = digest[3 - i].toInt()
            hexChars[2 * i] = hexDigits[(digestByte shr 4) and 0xf]
            hexChars[2 * i + 1] = hexDigits[digestByte and 0xf]
        }
        return String(hexChars)
    }

    /** True when [root] is one of the system's (public) root CAs. */
    private fun isKnownRoot(root: X509Certificate): Boolean {
        val keystore = systemKeystore ?: return false
        val directory = systemCertificateDirectory ?: return false
        val key = Pair(root.subjectX500Principal, root.publicKey)
        if (systemTrustAnchorCache.contains(key)) return true

        // System anchors are stored under a hash of the principal; collisions get a higher suffix.
        val hash = hashPrincipal(root.subjectX500Principal)
        var i = 0
        while (true) {
            val alias = "$hash.$i"
            i += 1
            if (!File(directory, alias).exists()) break
            // null when the user disabled that system anchor; keep looking.
            val anchor = keystore.getCertificate("system:$alias") ?: continue
            if (anchor !is X509Certificate) {
                Log.e(TAG, "anchor is not a certificate, alias: $alias")
                continue
            }
            if (root.subjectX500Principal == anchor.subjectX500Principal && root.publicKey == anchor.publicKey) {
                systemTrustAnchorCache.add(key)
                return true
            }
        }
        return false
    }
}
