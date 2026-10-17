package io.lumen.secure.core

import io.lumen.secure.core.security.RevocationInfo
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayOutputStream

/**
 * Extension values exactly as X509Certificate.getExtensionValue returns them (OCTET STRING around
 * the extension's DER), shaped like a Let's Encrypt certificate before May 2025 (OCSP + CA issuers)
 * and after (CA issuers only, CRL distribution point).
 */
class RevocationInfoTest {
    private fun tlv(tag: Int, vararg parts: ByteArray): ByteArray {
        val body = ByteArrayOutputStream().apply { parts.forEach { write(it) } }.toByteArray()
        val len = body.size
        val header = when {
            len < 0x80 -> byteArrayOf(tag.toByte(), len.toByte())
            len < 0x100 -> byteArrayOf(tag.toByte(), 0x81.toByte(), len.toByte())
            else -> byteArrayOf(tag.toByte(), 0x82.toByte(), (len shr 8).toByte(), len.toByte())
        }
        return header + body
    }

    private fun seq(vararg parts: ByteArray) = tlv(0x30, *parts)
    private fun uri(s: String) = tlv(0x86, s.toByteArray(Charsets.US_ASCII))
    private fun extension(body: ByteArray) = tlv(0x04, body)

    private val idAdOcsp = byteArrayOf(0x06, 0x08, 0x2B, 0x06, 0x01, 0x05, 0x05, 0x07, 0x30, 0x01)
    private val idAdCaIssuers = byteArrayOf(0x06, 0x08, 0x2B, 0x06, 0x01, 0x05, 0x05, 0x07, 0x30, 0x02)

    private val aiaWithOcsp = extension(seq(seq(idAdOcsp, uri("http://r11.o.lencr.org")), seq(idAdCaIssuers, uri("http://r11.i.lencr.org/"))))
    private val aiaIssuersOnly = extension(seq(seq(idAdCaIssuers, uri("http://r13.i.lencr.org/"))))
    private val crlDp = extension(seq(seq(tlv(0xA0, tlv(0xA0, uri("http://r13.c.lencr.org/12.crl"))))))

    @Test
    fun ocspResponderIsFoundOnlyWhenNamed() {
        assertTrue(RevocationInfo.namesOcspResponder(aiaWithOcsp))
        assertFalse("Let's Encrypt since 2025: CA issuers only", RevocationInfo.namesOcspResponder(aiaIssuersOnly))
        assertFalse("no AIA extension at all", RevocationInfo.namesOcspResponder(null))
    }

    @Test
    fun ocspAccessMethodWithANonUriLocationIsNotAResponder() {
        // The platform's OCSP check only uses URI locations (directoryName [4] here).
        val dirName = extension(seq(seq(idAdOcsp, tlv(0xA4, seq()))))
        assertFalse(RevocationInfo.namesOcspResponder(dirName))
    }

    @Test
    fun malformedAiaKeepsThePlatformDefault() {
        assertTrue(RevocationInfo.namesOcspResponder(byteArrayOf(0x04, 0x05, 0x30, 0x03)))
        assertTrue(RevocationInfo.namesOcspResponder(extension(seq(tlv(0x02, byteArrayOf(1))))))
        assertTrue(RevocationInfo.namesOcspResponder(byteArrayOf()))
    }

    @Test
    fun crlDistributionPointUrisAndHosts() {
        assertEquals(listOf("http://r13.c.lencr.org/12.crl"), RevocationInfo.crlUris(crlDp))
        assertEquals("r13.c.lencr.org", RevocationInfo.host("http://R13.c.lencr.org/12.crl"))
        assertEquals("c.pki.goog", RevocationInfo.host("http://c.pki.goog/we1/abc.crl"))
        assertNull(RevocationInfo.host("ldap://example.com/cn=crl"))
        assertEquals(emptyList<String>(), RevocationInfo.crlUris(null))
        assertEquals(emptyList<String>(), RevocationInfo.crlUris(byteArrayOf(0x04, 0x01)))
    }

    @Test
    fun longFormLengthsAreParsed() {
        val longUri = "http://crl.example.com/" + "a".repeat(300) + ".crl"
        val ext = extension(seq(seq(tlv(0xA0, tlv(0xA0, uri(longUri))))))
        assertEquals(listOf(longUri), RevocationInfo.crlUris(ext))
    }
}
