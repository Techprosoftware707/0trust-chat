package io.lumen.secure.core

import io.lumen.secure.core.config.UrlPolicy
import io.lumen.secure.core.config.WellKnownParser
import io.lumen.secure.core.config.WellKnownResult
import io.lumen.secure.core.deeplink.DeepLinkRoute
import io.lumen.secure.core.deeplink.DeepLinkRouter
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Cross-platform vectors from apps/shared/test-vectors (added to the test classpath by
 * core/build.gradle.kts). Every case is asserted; all four apps run the same files.
 */
class SharedVectorsTest {

    private fun load(name: String): JsonObject {
        val text = javaClass.classLoader!!.getResourceAsStream(name)?.bufferedReader()?.readText()
            ?: error("test vector $name not on the classpath (apps/shared/test-vectors)")
        return Json.parseToJsonElement(text).jsonObject
    }

    private fun cases(name: String): JsonArray = load(name)["cases"]!!.jsonArray.also { assertTrue("$name has cases", it.isNotEmpty()) }

    private fun JsonElement?.strOrNull(): String? = (this as? JsonPrimitive)?.takeIf { it.isString }?.content

    @Test
    fun urlValidation() {
        for (c in cases("url-validation.json")) {
            val o = c.jsonObject
            val input = o["input"]!!.jsonPrimitive.content
            val debug = o["debug"]!!.jsonPrimitive.boolean
            val expect = o["expect"].strOrNull()
            assertEquals("validateEndpointUrl(\"$input\", debug=$debug)", expect, UrlPolicy.validateEndpointUrl(input, debug))
        }
    }

    @Test
    fun wellKnown() {
        for (c in cases("wellknown.json")) {
            val o = c.jsonObject
            val name = o["name"].strOrNull()
            val expect = o["expect"]!!.jsonObject
            val result = WellKnownParser.parse(o["input"]!!)
            val error = expect["error"].strOrNull()
            if (error != null) {
                assertTrue("$name: expected error $error, got $result", result is WellKnownResult.Error)
                assertEquals(name, error, (result as WellKnownResult.Error).error.code)
                continue
            }
            assertTrue("$name: expected success, got $result", result is WellKnownResult.Ok)
            result as WellKnownResult.Ok
            assertEquals(name, expect["homeserver"].strOrNull(), result.homeserver)
            val lumen = expect["lumen"]
            if (lumen == null || lumen is JsonNull) {
                assertEquals("$name: lumen block", null, result.lumen)
                continue
            }
            val l = result.lumen ?: throw AssertionError("$name: lumen block missing")
            val actual = mapOf(
                "brand_name" to l.brandName, "brand_short_name" to l.brandShortName,
                "portal_url" to l.portalUrl, "signup_url" to l.signupUrl, "account_url" to l.accountUrl,
                "privacy_url" to l.privacyUrl, "help_url" to l.helpUrl, "sso_idp_id" to l.ssoIdpId,
                "web_app_url" to l.webAppUrl, "call_widget_url" to l.callWidgetUrl, "push_gateway_url" to l.pushGatewayUrl,
                "account_delete_url" to l.accountDeleteUrl,
            )
            for ((k, v) in lumen.jsonObject) assertEquals("$name: $k", v.strOrNull(), actual[k] ?: if (k in actual) null else error("unknown key $k"))
        }
    }

    @Test
    fun deepLinks() {
        for (c in cases("deeplinks.json")) {
            val o = c.jsonObject
            val url = o["url"]!!.jsonPrimitive.content
            val pending = o["pending"].strOrNull()
            val expect = o["expect"]!!.jsonObject
            val route = DeepLinkRouter.route(url, pending)
            val msg = "route(\"$url\", pending=$pending)"
            when (expect["type"].strOrNull()) {
                "sso_callback" -> {
                    assertTrue("$msg → $route", route is DeepLinkRoute.SsoCallback)
                    assertEquals(msg, expect["loginToken"].strOrNull(), (route as DeepLinkRoute.SsoCallback).loginToken)
                    assertEquals(msg, url, route.callbackUrl)
                }
                "room" -> {
                    assertTrue("$msg → $route", route is DeepLinkRoute.Room)
                    assertEquals(msg, expect["id"].strOrNull(), (route as DeepLinkRoute.Room).id)
                }
                "user" -> {
                    assertTrue("$msg → $route", route is DeepLinkRoute.User)
                    assertEquals(msg, expect["id"].strOrNull(), (route as DeepLinkRoute.User).id)
                }
                "reject" -> assertEquals(msg, DeepLinkRoute.Reject, route)
                else -> error("unknown route type in vector: $expect")
            }
        }
    }
}
