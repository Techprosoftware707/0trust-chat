package io.lumen.secure.core.config

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.intOrNull

/** The `io.lumen.app` block of `/.well-known/matrix/client` (integration.md §2), validated. */
data class LumenAppInfo(
    val brandName: String?,
    val brandShortName: String?,
    val portalUrl: String?,
    val signupUrl: String?,
    val accountUrl: String?,
    val privacyUrl: String?,
    val helpUrl: String?,
    val ssoIdpId: String?,
    val webAppUrl: String?,
    val callWidgetUrl: String?,
    val pushGatewayUrl: String?,
)

enum class WellKnownError(val code: String) {
    INVALID_DOCUMENT("invalid_document"),
    MISSING_HOMESERVER("missing_homeserver"),
    INVALID_HOMESERVER("invalid_homeserver"),
}

sealed interface WellKnownResult {
    data class Ok(val homeserver: String, val lumen: LumenAppInfo?) : WellKnownResult
    data class Error(val error: WellKnownError) : WellKnownResult
}

/**
 * Parses `/.well-known/matrix/client`. Contract pinned by
 * apps/shared/test-vectors/wellknown.json:
 * - `m.homeserver.base_url` must pass [UrlPolicy.validateEndpointUrl];
 * - `io.lumen.app` is used only when `version` is exactly 1;
 * - every `*_url` that fails validation (non-debug rules) becomes null; unknown keys are ignored;
 * - `sso_idp_id` must match `^[A-Za-z0-9._~-]{1,255}$` or becomes null.
 */
object WellKnownParser {
    private val idpIdPattern = Regex("^[A-Za-z0-9._~-]{1,255}$")
    private const val MAX_BRAND_LENGTH = 64
    private val lenientJson = Json { isLenient = false }

    fun parse(json: String, debug: Boolean = false): WellKnownResult {
        val element = try {
            lenientJson.parseToJsonElement(json)
        } catch (_: Exception) {
            return WellKnownResult.Error(WellKnownError.INVALID_DOCUMENT)
        }
        return parse(element, debug)
    }

    fun parse(element: JsonElement, debug: Boolean = false): WellKnownResult {
        val doc = element as? JsonObject ?: return WellKnownResult.Error(WellKnownError.INVALID_DOCUMENT)
        val hs = doc["m.homeserver"] as? JsonObject ?: return WellKnownResult.Error(WellKnownError.MISSING_HOMESERVER)
        val rawBase = hs.string("base_url") ?: return WellKnownResult.Error(WellKnownError.MISSING_HOMESERVER)
        val base = UrlPolicy.validateEndpointUrl(rawBase, debug)
            ?: return WellKnownResult.Error(WellKnownError.INVALID_HOMESERVER)
        return WellKnownResult.Ok(base, parseLumen(doc["io.lumen.app"]))
    }

    private fun parseLumen(element: JsonElement?): LumenAppInfo? {
        val block = element as? JsonObject ?: return null
        val version = (block["version"] as? JsonPrimitive)?.takeUnless { it.isString }?.intOrNull
        if (version != 1) return null
        val brand = block["brand"] as? JsonObject
        fun url(key: String) = UrlPolicy.validateLinkUrl(block.string(key), debug = false)
        return LumenAppInfo(
            brandName = brand?.string("name")?.let(::cleanLabel),
            brandShortName = brand?.string("short_name")?.let(::cleanLabel),
            portalUrl = url("portal_url"),
            signupUrl = url("signup_url"),
            accountUrl = url("account_url"),
            privacyUrl = url("privacy_url"),
            helpUrl = url("help_url"),
            ssoIdpId = block.string("sso_idp_id")?.takeIf { idpIdPattern.matches(it) },
            webAppUrl = url("web_app_url"),
            callWidgetUrl = url("call_widget_url"),
            pushGatewayUrl = url("push_gateway_url"),
        )
    }

    /** Display labels from the server: no control characters, bounded length. */
    private fun cleanLabel(s: String): String? {
        val cleaned = s.filter { !it.isISOControl() }.trim().take(MAX_BRAND_LENGTH)
        return cleaned.ifEmpty { null }
    }

    private fun JsonObject.string(key: String): String? {
        val p = this[key] as? JsonPrimitive ?: return null
        if (!p.isString) return null
        return p.content.trim().ifEmpty { null }
    }
}
