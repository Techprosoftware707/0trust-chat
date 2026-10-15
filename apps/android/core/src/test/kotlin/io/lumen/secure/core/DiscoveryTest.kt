package io.lumen.secure.core

import io.lumen.secure.core.config.DiscoveryFailure
import io.lumen.secure.core.config.DiscoveryResult
import io.lumen.secure.core.config.HttpGet
import io.lumen.secure.core.config.HttpResponse
import io.lumen.secure.core.config.ServerDiscovery
import io.lumen.secure.core.config.ServerInput
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException

class DiscoveryTest {
    private val versions = HttpResponse(200, """{"versions":["v1.11","v1.12"]}""")
    private val lumenLogin = HttpResponse(
        200,
        """{"flows":[{"type":"m.login.sso","identity_providers":[{"id":"oidc-lumen","name":"Lumen"}]},{"type":"m.login.token"}]}""",
    )
    private val wellKnown = HttpResponse(
        200,
        """{"m.homeserver":{"base_url":"https://matrix.example.com"},"io.lumen.app":{"version":1,"sso_idp_id":"oidc-lumen","signup_url":"https://example.com/accounts/signup/","push_gateway_url":"https://matrix.example.com/_matrix/push/v1/notify"}}""",
    )

    private class FakeHttp(private val routes: Map<String, HttpResponse?>) : HttpGet {
        val requested = mutableListOf<String>()
        override fun get(url: String): HttpResponse {
            requested += url
            return routes[url] ?: if (url in routes) throw IOException("unreachable") else HttpResponse(404, "")
        }
    }

    @Test
    fun `discovers a Lumen server from its server name`() {
        val http = FakeHttp(
            mapOf(
                "https://example.com/.well-known/matrix/client" to wellKnown,
                "https://matrix.example.com/_matrix/client/versions" to versions,
                "https://matrix.example.com/_matrix/client/v3/login" to lumenLogin,
            ),
        )
        val r = ServerDiscovery(http, debug = false).discover("Example.com") as DiscoveryResult.Ok
        assertEquals("example.com", r.server.serverName)
        assertEquals("https://matrix.example.com", r.server.homeserverUrl)
        assertEquals("oidc-lumen", r.server.ssoIdpId)
        assertEquals("https://example.com/accounts/signup/", r.server.lumen!!.signupUrl)
        assertTrue(r.server.loginFlows.sso && r.server.loginFlows.token && !r.server.loginFlows.password)
    }

    @Test
    fun `a Matrix ID selects its server`() {
        assertEquals(ServerInput.ServerName("example.com"), ServerInput.parse("@alice:Example.com", debug = false))
        assertEquals(ServerInput.Invalid, ServerInput.parse("@alice", debug = false))
        assertEquals(ServerInput.ServerName("example.com:8448"), ServerInput.parse(" example.com:8448 ", debug = false))
        assertEquals(ServerInput.Invalid, ServerInput.parse("example.com:99999", debug = false))
        assertEquals(ServerInput.Invalid, ServerInput.parse("exa mple.com", debug = false))
        assertEquals(ServerInput.HomeserverUrl("https://matrix.example.com"), ServerInput.parse("https://matrix.example.com/", debug = false))
        assertEquals(ServerInput.Invalid, ServerInput.parse("http://matrix.example.com", debug = true))
    }

    @Test
    fun `missing well-known falls back to the server name`() {
        val http = FakeHttp(
            mapOf(
                "https://matrix.org/_matrix/client/versions" to versions,
                "https://matrix.org/_matrix/client/v3/login" to HttpResponse(200, """{"flows":[{"type":"m.login.password"}]}"""),
            ),
        )
        val r = ServerDiscovery(http, false).discover("matrix.org") as DiscoveryResult.Ok
        assertNull(r.server.lumen)
        assertTrue(r.server.loginFlows.password)
    }

    @Test
    fun `an invalid well-known is not followed`() {
        val http = FakeHttp(mapOf("https://example.com/.well-known/matrix/client" to HttpResponse(200, """{"m.homeserver":{"base_url":"http://evil.example"}}""")))
        val r = ServerDiscovery(http, false).discover("example.com")
        assertEquals(DiscoveryResult.Failed(DiscoveryFailure.INVALID_WELL_KNOWN), r)
        assertEquals(listOf("https://example.com/.well-known/matrix/client"), http.requested)
    }

    @Test
    fun `not a Matrix server`() {
        val http = FakeHttp(mapOf("https://example.com/_matrix/client/versions" to HttpResponse(200, "<html>")))
        assertEquals(DiscoveryResult.Failed(DiscoveryFailure.NOT_A_MATRIX_SERVER), ServerDiscovery(http, false).discover("example.com"))
    }

    @Test
    fun `unreachable homeserver`() {
        val http = FakeHttp(
            mapOf(
                "https://example.com/.well-known/matrix/client" to wellKnown,
                "https://matrix.example.com/_matrix/client/versions" to null,
            ),
        )
        assertEquals(DiscoveryResult.Failed(DiscoveryFailure.UNREACHABLE), ServerDiscovery(http, false).discover("example.com"))
    }

    @Test
    fun `server without SSO or password login is unsupported`() {
        val http = FakeHttp(
            mapOf(
                "https://example.com/_matrix/client/versions" to versions,
                "https://example.com/_matrix/client/v3/login" to HttpResponse(200, """{"flows":[{"type":"m.login.sso"}]}"""),
            ),
        )
        assertEquals(DiscoveryResult.Failed(DiscoveryFailure.NO_SUPPORTED_LOGIN), ServerDiscovery(http, false).discover("example.com"))
    }

    @Test
    fun `invalid input is rejected without network access`() {
        val http = FakeHttp(emptyMap())
        assertEquals(DiscoveryResult.Failed(DiscoveryFailure.INVALID_INPUT), ServerDiscovery(http, false).discover("javascript:alert(1)//"))
        assertTrue(http.requested.isEmpty())
    }
}
