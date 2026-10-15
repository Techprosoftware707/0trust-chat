package io.lumen.secure.core

import io.lumen.secure.core.config.UrlPolicy
import io.lumen.secure.core.config.WellKnownParser
import io.lumen.secure.core.config.WellKnownResult
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Mirrors the cases of services/chat/test/unit/config.test.ts for the native discovery path. */
class UrlPolicyTest {
    private val full = """{"m.homeserver":{"base_url":"https://matrix.example.com/"},
        "io.lumen.app":{"version":1,"brand":{"name":"Lumen Secure","short_name":"Lumen"},"sso_idp_id":"oidc-lumen",
        "portal_url":"https://example.com","privacy_url":"https://example.com/privacy/","help_url":"https://example.com/docs/"}}"""

    @Test
    fun `parses the installer's well-known schema and normalises the base URL`() {
        val r = WellKnownParser.parse(full) as WellKnownResult.Ok
        assertEquals("https://matrix.example.com", r.homeserver)
        assertEquals("Lumen Secure", r.lumen!!.brandName)
        assertEquals("Lumen", r.lumen!!.brandShortName)
        assertEquals("oidc-lumen", r.lumen!!.ssoIdpId)
        assertEquals("https://example.com/privacy/", r.lumen!!.privacyUrl)
    }

    @Test
    fun `rejects plain http except for loopback development servers in debug builds`() {
        assertNull(UrlPolicy.validateEndpointUrl("http://matrix.example.com", debug = true))
        assertEquals("http://127.0.0.1:28008", UrlPolicy.validateEndpointUrl("http://127.0.0.1:28008", debug = true))
        assertEquals("http://[::1]:8008", UrlPolicy.validateEndpointUrl("http://[::1]:8008", debug = true))
        assertEquals("http://chat.localhost", UrlPolicy.validateEndpointUrl("http://chat.localhost/", debug = true))
        assertNull(UrlPolicy.validateEndpointUrl("http://127.0.0.1:28008", debug = false))
        val r = WellKnownParser.parse("""{"m.homeserver":{"base_url":"http://127.0.0.1:28008"}}""", debug = true)
        assertEquals("http://127.0.0.1:28008", (r as WellKnownResult.Ok).homeserver)
    }

    @Test
    fun `rejects non-http schemes and credentials in URLs`() {
        assertNull(UrlPolicy.validateEndpointUrl("javascript:alert(1)", false))
        assertNull(UrlPolicy.validateEndpointUrl("https://u:p@m.example.com", false))
        assertNull(UrlPolicy.validateEndpointUrl("https://m.example.com@evil.example", false))
        assertNull(UrlPolicy.validateEndpointUrl("data:text/html,hi", false))
        assertNull(UrlPolicy.validateEndpointUrl("https://exa mple.com", false))
    }

    @Test
    fun `validates the SSO provider id`() {
        val r = WellKnownParser.parse("""{"m.homeserver":{"base_url":"https://m.example.com"},"io.lumen.app":{"version":1,"sso_idp_id":"../../evil"}}""")
        assertNull((r as WellKnownResult.Ok).lumen!!.ssoIdpId)
    }

    @Test
    fun `drops invalid optional links instead of failing`() {
        val r = WellKnownParser.parse(
            """{"m.homeserver":{"base_url":"https://m.example.com"},"io.lumen.app":{"version":1,"privacy_url":"javascript:alert(1)","help_url":42}}""",
        ) as WellKnownResult.Ok
        assertNull(r.lumen!!.privacyUrl)
        assertNull(r.lumen!!.helpUrl)
    }

    @Test
    fun `brand labels are cleaned and bounded`() {
        val r = WellKnownParser.parse(
            """{"m.homeserver":{"base_url":"https://m.example.com"},"io.lumen.app":{"version":1,"brand":{"name":"A\u0000B${"x".repeat(100)}","short_name":"  "}}}""",
        ) as WellKnownResult.Ok
        assertEquals(64, r.lumen!!.brandName!!.length)
        assertFalse(r.lumen!!.brandName!!.contains('\u0000'))
        assertNull(r.lumen!!.brandShortName)
    }

    @Test
    fun `version must be the number 1`() {
        val r = WellKnownParser.parse("""{"m.homeserver":{"base_url":"https://m.example.com"},"io.lumen.app":{"version":"1"}}""") as WellKnownResult.Ok
        assertNull(r.lumen)
    }

    @Test
    fun `invalid JSON is an invalid document`() {
        assertTrue(WellKnownParser.parse("{not json") is WellKnownResult.Error)
    }

    @Test
    fun `loopback detection`() {
        assertTrue(UrlPolicy.isLoopbackHost("localhost"))
        assertTrue(UrlPolicy.isLoopbackHost("[::1]"))
        assertTrue(UrlPolicy.isLoopbackHost("dev.localhost"))
        assertFalse(UrlPolicy.isLoopbackHost("localhost.example.com"))
        assertFalse(UrlPolicy.isLoopbackHost("127.0.0.1.nip.io"))
    }

    @Test
    fun `link URLs keep their path and query`() {
        assertEquals("https://example.com/portal/security/?tab=devices", UrlPolicy.validateLinkUrl(" https://example.com/portal/security/?tab=devices "))
        assertNull(UrlPolicy.validateLinkUrl("http://example.com/"))
    }
}
