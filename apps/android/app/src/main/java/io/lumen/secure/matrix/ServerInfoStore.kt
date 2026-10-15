package io.lumen.secure.matrix

import android.content.Context
import androidx.core.content.edit
import io.lumen.secure.core.config.LumenAppInfo
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * Public, non-secret server facts of the signed-in account (from discovery): brand and the
 * `io.lumen.app` links. Re-discovered on each start.
 */
data class ServerInfo(val serverName: String?, val homeserverUrl: String, val lumen: LumenAppInfo?) {
    val brandName: String? get() = lumen?.brandName
}

class ServerInfoStore(context: Context) {
    private val prefs = context.getSharedPreferences("lumen_server", Context.MODE_PRIVATE)

    fun load(): ServerInfo? {
        val raw = prefs.getString("info", null) ?: return null
        val o = try {
            Json.parseToJsonElement(raw) as? JsonObject
        } catch (_: Exception) {
            null
        } ?: return null
        fun s(k: String) = (o[k] as? JsonPrimitive)?.takeIf { it.isString }?.content
        val hs = s("homeserver_url") ?: return null
        val lumen = if (o["lumen"] == null) null else (o["lumen"] as? JsonObject)?.let { l ->
            fun ls(k: String) = (l[k] as? JsonPrimitive)?.takeIf { it.isString }?.content
            LumenAppInfo(
                ls("brand_name"), ls("brand_short_name"), ls("portal_url"), ls("signup_url"), ls("account_url"), ls("privacy_url"),
                ls("help_url"), ls("sso_idp_id"), ls("web_app_url"), ls("call_widget_url"), ls("push_gateway_url"),
                ls("account_delete_url"),
            )
        }
        return ServerInfo(s("server_name"), hs, lumen)
    }

    fun save(info: ServerInfo) {
        val json = buildJsonObject {
            info.serverName?.let { put("server_name", it) }
            put("homeserver_url", info.homeserverUrl)
            info.lumen?.let { l ->
                put(
                    "lumen",
                    buildJsonObject {
                        l.brandName?.let { put("brand_name", it) }
                        l.brandShortName?.let { put("brand_short_name", it) }
                        l.portalUrl?.let { put("portal_url", it) }
                        l.signupUrl?.let { put("signup_url", it) }
                        l.accountUrl?.let { put("account_url", it) }
                        l.privacyUrl?.let { put("privacy_url", it) }
                        l.helpUrl?.let { put("help_url", it) }
                        l.ssoIdpId?.let { put("sso_idp_id", it) }
                        l.webAppUrl?.let { put("web_app_url", it) }
                        l.callWidgetUrl?.let { put("call_widget_url", it) }
                        l.pushGatewayUrl?.let { put("push_gateway_url", it) }
                        l.accountDeleteUrl?.let { put("account_delete_url", it) }
                    },
                )
            }
        }
        prefs.edit { putString("info", json.toString()) }
    }

    fun clear() = prefs.edit { clear() }
}
