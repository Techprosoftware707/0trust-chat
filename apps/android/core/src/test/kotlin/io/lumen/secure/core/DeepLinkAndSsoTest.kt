package io.lumen.secure.core

import io.lumen.secure.core.auth.PendingSso
import io.lumen.secure.core.auth.SsoRedirect
import io.lumen.secure.core.deeplink.DeepLinkRoute
import io.lumen.secure.core.deeplink.DeepLinkRouter
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class DeepLinkAndSsoTest {
    @Test
    fun `redirect URL carries the nonce under the whitelisted prefix`() {
        val n = SsoRedirect.newNonce()
        val url = SsoRedirect.redirectUrl("io.lumen.secure", n)
        assertTrue(url.startsWith("io.lumen.secure:/sso-callback"))
        assertEquals("io.lumen.secure:/sso-callback?n=$n", url)
        assertTrue(n.length >= 32 && n.all { it.isLetterOrDigit() || it == '-' || it == '_' })
        assertNotEquals(n, SsoRedirect.newNonce())
    }

    @Test
    fun `a full round trip is accepted only with the pending nonce`() {
        val n = SsoRedirect.newNonce()
        val callback = SsoRedirect.redirectUrl("io.lumen.secure", n) + "&loginToken=syt_abc"
        assertEquals(DeepLinkRoute.SsoCallback("syt_abc", callback), DeepLinkRouter.route(callback, n))
        assertEquals(DeepLinkRoute.Reject, DeepLinkRouter.route(callback, SsoRedirect.newNonce()))
        assertEquals(DeepLinkRoute.Reject, DeepLinkRouter.route(callback, null))
        assertEquals(DeepLinkRoute.Reject, DeepLinkRouter.route(callback, ""))
    }

    @Test
    fun `duplicate parameters and a different scheme are rejected`() {
        val dup = "io.lumen.secure:/sso-callback?n=abc&n=abc&loginToken=t"
        assertEquals(DeepLinkRoute.Reject, DeepLinkRouter.route(dup, "abc"))
        val other = "com.example.app:/sso-callback?n=abc&loginToken=t"
        assertEquals(DeepLinkRoute.Reject, DeepLinkRouter.route(other, "abc"))
        // White-label builds use their own scheme
        assertTrue(DeepLinkRouter.route(other, "abc", appScheme = "com.example.app") is DeepLinkRoute.SsoCallback)
    }

    @Test
    fun `pending attempts expire`() {
        val p = PendingSso("n", "https://m.example.com", "example.com", "oidc-lumen", createdAtMillis = 1_000)
        assertFalse(p.isExpired(1_000 + 60_000))
        assertTrue(p.isExpired(1_000 + PendingSso.MAX_AGE_MILLIS + 1))
        assertTrue(p.isExpired(0)) // clock went backwards
    }

    @Test
    fun `app link hosts route the web client's room and user paths`() {
        val hosts = setOf("app.example.com")
        assertEquals(DeepLinkRoute.Room("!abc:example.com"), DeepLinkRouter.route("https://app.example.com/#/room/!abc:example.com", null, appLinkHosts = hosts))
        assertEquals(DeepLinkRoute.Room("#lounge:example.com"), DeepLinkRouter.route("https://APP.example.com/#/room/%23lounge:example.com", null, appLinkHosts = hosts))
        assertEquals(DeepLinkRoute.User("@bob:example.com"), DeepLinkRouter.route("https://app.example.com/#/user/@bob:example.com", null, appLinkHosts = hosts))
        assertEquals(DeepLinkRoute.Reject, DeepLinkRouter.route("https://app.example.com/#/settings", null, appLinkHosts = hosts))
        assertEquals(DeepLinkRoute.Reject, DeepLinkRouter.route("https://app.example.com.evil.example/#/room/!abc:example.com", null, appLinkHosts = hosts))
        assertEquals(DeepLinkRoute.Reject, DeepLinkRouter.route("https://user@app.example.com/#/room/!abc:example.com", null, appLinkHosts = hosts))
    }

    @Test
    fun `matrix links keep via servers and event IDs`() {
        val r = DeepLinkRouter.route("https://matrix.to/#/!abc:example.com/\$ev1?via=a.example&via=b.example", null) as DeepLinkRoute.Room
        assertEquals(listOf("a.example", "b.example"), r.via)
        assertEquals("\$ev1", r.eventId)
        val m = DeepLinkRouter.route("matrix:roomid/abc:example.com/e/ev2?via=a.example", null) as DeepLinkRoute.Room
        assertEquals("!abc:example.com", m.id)
        assertEquals("\$ev2", m.eventId)
    }

    @Test
    fun `room version 12 IDs without a server part are accepted`() {
        val id = "!" + "a".repeat(43)
        assertEquals(DeepLinkRoute.Room(id), DeepLinkRouter.route("https://matrix.to/#/$id", null))
    }

    @Test
    fun `control characters and huge URLs are rejected`() {
        assertEquals(DeepLinkRoute.Reject, DeepLinkRouter.route("https://matrix.to/#/@a\u0001:b.c", null))
        assertEquals(DeepLinkRoute.Reject, DeepLinkRouter.route("https://matrix.to/#/@" + "a".repeat(5000) + ":b.c", null))
    }
}
