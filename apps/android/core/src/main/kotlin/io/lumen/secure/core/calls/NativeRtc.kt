package io.lumen.secure.core.calls

import io.lumen.secure.core.config.HttpResponse
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * Authenticated client-server API calls for [NativeRtc], implemented by the app with the
 * session's access token. [NativeRtc] never sees the token, so it cannot put it in a message
 * for the widget.
 */
interface HomeserverApi {
    /** Blocking; throws [java.io.IOException] when the homeserver cannot be reached. */
    fun request(method: String, path: String, jsonBody: String?): HttpResponse

    /** The full URL of [path] (for error reports; contains no credentials). */
    fun url(path: String): String
}

/**
 * The two MatrixRTC widget-API actions the native host answers itself next to the Rust widget
 * driver, because sdk-android 26.09.28 (matrix-rust-sdk 2a3db80e) cannot serve them against a
 * Lumen server. Port of tests/apps/widget-harness/src/native_rtc.rs (which proved a real E2EE
 * call with the same driver revision):
 *
 * 1. `org.matrix.msc4533.rtc_livekit_get_token` (MSC4533): the driver has no such action. The
 *    host adds `org.matrix.msc4533` to the driver's `supported_api_versions` answer, grants the
 *    capability only if the widget asked for it (added to the driver's `notify_capabilities`), and
 *    answers with `POST /_matrix/client/unstable/io.element.msc4195/rtc/livekit/get_token` (the
 *    request data verbatim as the body) — only for the driver's room and this device's member ID
 *    `<userId>:<deviceId>`. Not the OpenID/standalone route: it yields a different LiveKit
 *    identity than matrix-js-sdk 44 web clients expect.
 * 2. `org.matrix.msc4515.get_rtc_transports` (MSC4515): the driver implements it, but its
 *    ruma-client-api only parses `{type: livekit, livekit_service_url}` and rejects Lumen's
 *    `{type: livekit, url}`. The host answers it (when the driver approved
 *    `org.matrix.msc4515.rtc_transports`) from `GET /_matrix/client/unstable/org.matrix.msc4143/rtc/transports`,
 *    passing the entries through (entries without a string `type` are dropped).
 */
class NativeRtc(
    private val roomId: String,
    userId: String,
    deviceId: String,
    private val widgetId: String,
    private val homeserver: HomeserverApi,
) {
    sealed interface FromWidget {
        /** Hand to `WidgetDriverHandle.send` unchanged. */
        data object Forward : FromWidget

        /** Answer with [answer]; the driver never sees it. */
        data class Intercepted(val request: JsonObject) : FromWidget
    }

    private val memberId = "$userId:$deviceId"

    @Volatile
    var tokenCapabilityRequested = false
        private set

    @Volatile
    var transportsCapabilityApproved = false
        private set

    /** Inspects a widget → driver message (already filtered by [WidgetBridge.classify]). */
    fun onFromWidget(raw: String): FromWidget {
        val v = parse(raw) ?: return FromWidget.Forward
        if (v.str("widgetId") != widgetId) return FromWidget.Forward
        val api = v.str("api")
        val action = v.str("action")
        val isResponse = v.containsKey("response")

        // The widget's answer to the driver's `capabilities` request.
        if (api == "toWidget" && action == "capabilities" && isResponse) {
            val caps = ((v["response"] as? JsonObject)?.get("capabilities") as? JsonArray).orEmpty()
            tokenCapabilityRequested = caps.any { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content == GET_TOKEN }
        }
        if (api == "fromWidget" && !isResponse && (action == GET_TOKEN || action == GET_TRANSPORTS)) {
            return FromWidget.Intercepted(v)
        }
        return FromWidget.Forward
    }

    /** Inspects a driver → widget message; returns it, amended where needed. */
    fun onToWidget(raw: String): String {
        val v = parse(raw) ?: return raw
        val api = v.str("api")
        val action = v.str("action")

        // The driver's answer to the widget's `supported_api_versions` request.
        if (api == "fromWidget" && action == "supported_api_versions") {
            val response = v["response"] as? JsonObject ?: return raw
            val list = response["supported_versions"] as? JsonArray ?: return raw
            if (list.any { it.asString() == MSC4533_API_VERSION }) return raw
            val amended = JsonObject(response + ("supported_versions" to JsonArray(list + JsonPrimitive(MSC4533_API_VERSION))))
            return JsonObject(v + ("response" to amended)).toString()
        }

        // The driver tells the widget which capabilities were approved.
        if (api == "toWidget" && action == "notify_capabilities") {
            val data = v["data"] as? JsonObject ?: return raw
            val approved = data["approved"] as? JsonArray ?: return raw
            transportsCapabilityApproved = approved.any { it.asString() == TRANSPORTS_CAPABILITY }
            if (tokenCapabilityRequested && approved.none { it.asString() == GET_TOKEN }) {
                val amended = JsonObject(data + ("approved" to JsonArray(approved + JsonPrimitive(GET_TOKEN))))
                return JsonObject(v + ("data" to amended)).toString()
            }
        }
        return raw
    }

    /** Answers an intercepted request (blocking HTTP); returns the widget-API response message. */
    fun answer(request: JsonObject): String {
        val action = request.str("action")
        val data = request["data"]
        val result: Result = when (action) {
            GET_TOKEN -> getToken(data)
            GET_TRANSPORTS -> getTransports()
            else -> Result.Err(refuse("Unknown action"))
        }
        val response: JsonElement = when (result) {
            is Result.Ok -> result.body
            is Result.Err -> buildJsonObject { put("error", result.error) }
        }
        return JsonObject(request + ("response" to response)).toString()
    }

    private sealed interface Result {
        data class Ok(val body: JsonObject) : Result
        data class Err(val error: JsonObject) : Result
    }

    private fun getTransports(): Result {
        if (!transportsCapabilityApproved) return Result.Err(refuse("Missing capability"))
        val body = when (val r = call("GET", TRANSPORTS_PATH, null)) {
            is Result.Ok -> r.body
            is Result.Err -> return r
        }
        val transports = (body["rtc_transports"] as? JsonArray).orEmpty()
            .filter { t -> (t as? JsonObject)?.get("type")?.asString() != null }
        if (transports.isEmpty()) return Result.Err(refuse("The homeserver does not advertise any RTC transport"))
        return Result.Ok(buildJsonObject { put("rtc_transports", JsonArray(transports)) })
    }

    private fun getToken(data: JsonElement?): Result {
        if (!tokenCapabilityRequested) return Result.Err(refuse("Missing capability"))
        val body = data as? JsonObject ?: return Result.Err(refuse("Invalid request body"))
        if (body["room_id"]?.asString() != roomId) return Result.Err(refuse("Tokens are only issued for the widget's own room"))
        if (body["member_id"]?.asString() != memberId) return Result.Err(refuse("Tokens are only issued for this device's call membership"))
        val res = when (val r = call("POST", GET_TOKEN_PATH, body.toString())) {
            is Result.Ok -> r.body
            is Result.Err -> return r
        }
        if (res["jwt"]?.asString() == null) return Result.Err(refuse("The homeserver returned no token"))
        return Result.Ok(res)
    }

    private fun call(method: String, path: String, body: String?): Result {
        val res = try {
            homeserver.request(method, path, body)
        } catch (e: java.io.IOException) {
            return Result.Err(refuse("Couldn't reach the homeserver"))
        }
        val parsed = parse(res.body)
        if (res.status == 200 && parsed != null) return Result.Ok(parsed)
        // The shape a matrix-widget-api host uses for a failed homeserver call, so matrix-js-sdk
        // turns it into a MatrixError with the real status.
        return Result.Err(
            buildJsonObject {
                put("message", "The homeserver refused the request (HTTP ${res.status})")
                put(
                    "matrix_api_error",
                    buildJsonObject {
                        put("http_status", res.status)
                        put("http_headers", JsonObject(emptyMap()))
                        put("url", homeserver.url(path))
                        put("response", parsed ?: JsonObject(emptyMap()))
                    },
                )
            },
        )
    }

    private fun refuse(message: String) = buildJsonObject { put("message", message) }

    private fun parse(raw: String): JsonObject? = try {
        Json.parseToJsonElement(raw) as? JsonObject
    } catch (_: Exception) {
        null
    }

    private fun JsonObject.str(k: String) = this[k]?.asString()

    private fun JsonElement.asString(): String? = (this as? JsonPrimitive)?.takeIf { it.isString }?.content

    companion object {
        const val MSC4533_API_VERSION = "org.matrix.msc4533"
        const val GET_TOKEN = "org.matrix.msc4533.rtc_livekit_get_token"
        const val GET_TRANSPORTS = "org.matrix.msc4515.get_rtc_transports"
        const val TRANSPORTS_CAPABILITY = "org.matrix.msc4515.rtc_transports"
        const val GET_TOKEN_PATH = "_matrix/client/unstable/io.element.msc4195/rtc/livekit/get_token"
        const val TRANSPORTS_PATH = "_matrix/client/unstable/org.matrix.msc4143/rtc/transports"

        /** Whether a `/rtc/transports` answer advertises at least one transport (raw JSON, not the SDK's parser). */
        fun hasTransports(body: String): Boolean = try {
            ((Json.parseToJsonElement(body) as? JsonObject)?.get("rtc_transports") as? JsonArray).orEmpty()
                .any { t -> ((t as? JsonObject)?.get("type") as? JsonPrimitive)?.isString == true }
        } catch (_: Exception) {
            false
        }
    }
}
