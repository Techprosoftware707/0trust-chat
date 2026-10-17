package io.lumen.secure.core.security

/**
 * Where an X.509 certificate says its revocation status is published, read from raw extension
 * values as `X509Certificate.getExtensionValue` returns them (a DER OCTET STRING around the
 * extension's own DER value). Java has no public parser for these extensions.
 *
 * Why it matters: Android's `PKIXRevocationChecker` (the platform half of the Rust SDK's TLS
 * verifier) prefers OCSP, and a certificate that names no OCSP responder makes that OCSP attempt a
 * hard error. Since 2025 Let's Encrypt (and other public CAs) issue certificates with a CRL
 * distribution point and no OCSP responder, so the verifier checks those against their CRL instead
 * (see org.rustls.platformverifier.CertificateVerifier).
 */
object RevocationInfo {
    /** Authority Information Access (RFC 5280 §4.2.2.1). */
    const val AIA_OID = "1.3.6.1.5.5.7.1.1"

    /** CRL Distribution Points (RFC 5280 §4.2.1.13). */
    const val CRL_DISTRIBUTION_POINTS_OID = "2.5.29.31"

    /** DER body of id-ad-ocsp, 1.3.6.1.5.5.7.48.1. */
    private val ID_AD_OCSP = byteArrayOf(0x2B, 0x06, 0x01, 0x05, 0x05, 0x07, 0x30, 0x01)

    private const val OCTET_STRING = 0x04
    private const val OID = 0x06
    private const val SEQUENCE = 0x30
    private const val CONTEXT_0_CONSTRUCTED = 0xA0
    private const val URI_NAME = 0x86 // GeneralName uniformResourceIdentifier [6] IMPLICIT IA5String

    /**
     * True when the AIA extension names an OCSP responder by URI (what the platform's OCSP check
     * needs). No extension: false. An extension that cannot be parsed counts as naming one, so the
     * caller keeps the platform's default OCSP-first check for anything unusual.
     */
    fun namesOcspResponder(aiaExtension: ByteArray?): Boolean {
        if (aiaExtension == null) return false
        val descriptions = extensionBody(aiaExtension)?.children() ?: return true
        for (description in descriptions) {
            if (description.tag != SEQUENCE) return true
            val parts = description.children() ?: return true
            if (parts.size < 2) return true
            if (parts[0].tag == OID && parts[0].contentEquals(ID_AD_OCSP) && parts[1].tag == URI_NAME) return true
        }
        return false
    }

    /** The URIs in the CRL Distribution Points extension (full names only); empty if none or unparsable. */
    fun crlUris(crlDistributionPointsExtension: ByteArray?): List<String> {
        if (crlDistributionPointsExtension == null) return emptyList()
        val points = extensionBody(crlDistributionPointsExtension)?.children() ?: return emptyList()
        val uris = mutableListOf<String>()
        for (point in points) {
            if (point.tag != SEQUENCE) continue
            // DistributionPoint ::= SEQUENCE { distributionPoint [0] DistributionPointName OPTIONAL, ... }
            val name = point.children()?.firstOrNull { it.tag == CONTEXT_0_CONSTRUCTED } ?: continue
            // DistributionPointName ::= CHOICE { fullName [0] GeneralNames, ... }
            val fullName = name.children()?.firstOrNull { it.tag == CONTEXT_0_CONSTRUCTED } ?: continue
            fullName.children()?.filter { it.tag == URI_NAME }?.forEach { uris += it.text() }
        }
        return uris
    }

    /** Host part of an http(s) URI, lowercase; null for anything else. */
    fun host(uri: String): String? =
        Regex("^https?://([A-Za-z0-9.-]+)(?::\\d+)?(?:[/?#].*)?$", RegexOption.IGNORE_CASE).find(uri)?.groupValues?.get(1)?.lowercase()

    /** The SEQUENCE inside the OCTET STRING that getExtensionValue returns. */
    private fun extensionBody(value: ByteArray): Tlv? {
        val outer = parse(value, 0, value.size)?.singleOrNull()?.takeIf { it.tag == OCTET_STRING } ?: return null
        return outer.children()?.singleOrNull()?.takeIf { it.tag == SEQUENCE }
    }

    private class Tlv(val tag: Int, private val buf: ByteArray, private val start: Int, private val end: Int) {
        fun children(): List<Tlv>? = parse(buf, start, end)
        fun contentEquals(other: ByteArray) = end - start == other.size && (0 until other.size).all { buf[start + it] == other[it] }
        fun text() = String(buf, start, end - start, Charsets.US_ASCII)
    }

    /** DER TLVs between [from] and [to]; null if malformed. Low tag numbers and lengths below 16 MB only. */
    private fun parse(b: ByteArray, from: Int, to: Int): List<Tlv>? {
        val out = mutableListOf<Tlv>()
        var i = from
        while (i < to) {
            if (to - i < 2) return null
            val tag = b[i].toInt() and 0xFF
            if (tag and 0x1F == 0x1F) return null
            var len = b[i + 1].toInt() and 0xFF
            var p = i + 2
            if (len and 0x80 != 0) {
                val n = len and 0x7F
                if (n == 0 || n > 3 || p + n > to) return null
                len = 0
                repeat(n) { len = (len shl 8) or (b[p++].toInt() and 0xFF) }
            }
            if (p + len > to) return null
            out += Tlv(tag, b, p, p + len)
            i = p + len
        }
        return out
    }
}
