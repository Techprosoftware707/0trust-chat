package io.lumen.secure.net

import io.lumen.secure.core.config.HttpResponse
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import java.net.URLEncoder

data class DeviceInfo(val deviceId: String, val displayName: String?, val lastSeenTs: Long?, val lastSeenIp: String?)

/** User-interactive auth required for a device deletion (integration.md §3). */
data class UiaChallenge(val session: String, val ssoFallback: Boolean, val password: Boolean)

sealed interface DeleteResult {
    data object Deleted : DeleteResult
    data class NeedsAuth(val challenge: UiaChallenge) : DeleteResult
    data class Failed(val status: Int) : DeleteResult
}

/**
 * `GET /devices`, `PUT /devices/{id}` and `DELETE /devices/{id}` (the Rust SDK FFI has no device
 * list). Requests carry the session's access token and go only to the session's homeserver.
 */
class DevicesApi(private val homeserverUrl: String, private val accessToken: () -> String) {

    fun list(): List<DeviceInfo> {
        val r = PlatformHttp.request("GET", "$homeserverUrl/_matrix/client/v3/devices", accessToken(), null)
        if (r.status != 200) throw java.io.IOException("devices: HTTP ${r.status}")
        val arr = (Json.parseToJsonElement(r.body) as? JsonObject)?.get("devices") as? JsonArray ?: return emptyList()
        return arr.mapNotNull { e ->
            val o = e as? JsonObject ?: return@mapNotNull null
            val id = o.str("device_id") ?: return@mapNotNull null
            DeviceInfo(id, o.str("display_name"), (o["last_seen_ts"] as? JsonPrimitive)?.longOrNull, o.str("last_seen_ip"))
        }.sortedByDescending { it.lastSeenTs ?: 0 }
    }

    fun rename(deviceId: String, name: String) {
        val body = buildJsonObject { put("display_name", name.take(100)) }.toString()
        PlatformHttp.request("PUT", "$homeserverUrl/_matrix/client/v3/devices/${enc(deviceId)}", accessToken(), body)
    }

    /** First call without [uiaSession]; after the user completed SSO in the browser, again with it. */
    fun delete(deviceId: String, uiaSession: String? = null, password: Pair<String, String>? = null): DeleteResult {
        val body = buildJsonObject {
            if (uiaSession != null) {
                put(
                    "auth",
                    buildJsonObject {
                        put("session", uiaSession)
                        if (password != null) {
                            put("type", "m.login.password")
                            put("identifier", buildJsonObject { put("type", "m.id.user"); put("user", password.first) })
                            put("password", password.second)
                        }
                    },
                )
            }
        }.toString()
        val r: HttpResponse = PlatformHttp.request("DELETE", "$homeserverUrl/_matrix/client/v3/devices/${enc(deviceId)}", accessToken(), body)
        return when (r.status) {
            200 -> DeleteResult.Deleted
            401 -> parseUia(r.body)?.let { DeleteResult.NeedsAuth(it) } ?: DeleteResult.Failed(401)
            else -> DeleteResult.Failed(r.status)
        }
    }

    /** The SSO fallback page for a UIA session, opened in the browser (Custom Tabs). */
    fun ssoFallbackUrl(session: String) =
        "$homeserverUrl/_matrix/client/v3/auth/m.login.sso/fallback/web?session=${enc(session)}"

    private fun parseUia(body: String): UiaChallenge? {
        val o = try {
            Json.parseToJsonElement(body) as? JsonObject
        } catch (_: Exception) {
            null
        } ?: return null
        val session = o.str("session") ?: return null
        val stages = (o["flows"] as? JsonArray).orEmpty().flatMap { f ->
            ((f as? JsonObject)?.get("stages") as? JsonArray).orEmpty().mapNotNull { (it as? JsonPrimitive)?.content }
        }
        return UiaChallenge(session, "m.login.sso" in stages, "m.login.password" in stages)
    }

    private fun JsonObject.str(k: String) = (this[k] as? JsonPrimitive)?.takeIf { it.isString }?.content
    private fun enc(s: String) = URLEncoder.encode(s, "UTF-8").replace("+", "%20")
}
