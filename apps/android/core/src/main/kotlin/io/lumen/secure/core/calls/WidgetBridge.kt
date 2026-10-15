package io.lumen.secure.core.calls

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** Media-encryption state as reported by the call widget (never derived by the native layer). */
enum class CallE2ee(val wire: String) {
    ENCRYPTED("encrypted"),
    WAITING_FOR_KEY("waiting-for-key"),
    DECRYPT_ERROR("decrypt-error"),
    NOT_ENCRYPTED("not-encrypted"),
    UNKNOWN("unknown"),
    ;

    companion object {
        fun fromWire(s: String?): CallE2ee = entries.firstOrNull { it.wire == s } ?: UNKNOWN
    }
}

enum class CallPhase(val wire: String) {
    CONNECTING("connecting"),
    CONNECTED("connected"),
    RECONNECTING("reconnecting"),
    ENDED("ended"),
    ;

    companion object {
        fun fromWire(s: String?): CallPhase? = entries.firstOrNull { it.wire == s }
    }
}

/** `io.lumen.call_state` from the widget (integration.md §6.2 item 3). Never contains keys. */
data class CallStateUpdate(val phase: CallPhase, val video: Boolean, val muted: Boolean, val e2ee: CallE2ee)

enum class CallAction(val wire: String) {
    HANGUP("hangup"),
    MUTE("mute"),
    UNMUTE("unmute"),
    VIDEO_ON("video_on"),
    VIDEO_OFF("video_off"),
    SWITCH_CAMERA("switch_camera"),
}

sealed interface BridgeInbound {
    /** A widget-API message to hand to `WidgetDriverHandle.send` unchanged. */
    data class ToDriver(val json: String) : BridgeInbound

    /** [ack] is the widget-API response to post back when the state came as a `fromWidget` request. */
    data class CallState(val update: CallStateUpdate, val ack: String? = null) : BridgeInbound

    data class Drop(val reason: String) : BridgeInbound
}

/**
 * The native side of the widget bridge (integration.md §6.2).
 *
 * Widget → native: only `fromWidget` requests and `toWidget` responses for *our* widget ID (and
 * never `io.lumen.*` actions) are forwarded to the Rust widget driver; `io.lumen.call_state`
 * drives the native call UI; everything else is dropped. Envelope of the Lumen messages:
 * `{"type":"io.lumen.call_state","state":…,"video":…,"muted":…,"e2ee":…}` (the fields may also be
 * nested under `"data"`), and native → widget `{"type":"io.lumen.call_action","action":…}`.
 */
object WidgetBridge {
    const val CALL_STATE_TYPE = "io.lumen.call_state"
    const val CALL_ACTION_TYPE = "io.lumen.call_action"
    const val MAX_MESSAGE_BYTES = 1_000_000

    private val json = Json { isLenient = false }

    fun classify(raw: String, widgetId: String): BridgeInbound {
        if (raw.length > MAX_MESSAGE_BYTES) return BridgeInbound.Drop("too large")
        val obj = try {
            json.parseToJsonElement(raw) as? JsonObject
        } catch (_: Exception) {
            null
        } ?: return BridgeInbound.Drop("not a JSON object")

        if (obj.str("type") == CALL_STATE_TYPE) return parseCallState(obj)

        val api = obj.str("api") ?: return BridgeInbound.Drop("no api")
        if (obj.str("widgetId") != widgetId) return BridgeInbound.Drop("other widget")
        val action = obj.str("action")
        if (obj.str("requestId").isNullOrEmpty() || action.isNullOrEmpty()) return BridgeInbound.Drop("malformed")
        val hasResponse = obj.containsKey("response")
        // Lumen's own messages never reach the Rust driver. The call state may also arrive as a
        // widget-API request (integration.md §6.2 item 4); it is answered with an empty response.
        if (action.startsWith("io.lumen.")) {
            if (api != "fromWidget" || hasResponse || action != CALL_STATE_TYPE) return BridgeInbound.Drop("unexpected Lumen action")
            val state = parseCallState(obj) as? BridgeInbound.CallState ?: return BridgeInbound.Drop("unknown call state")
            val ack = JsonObject(obj + ("response" to JsonObject(emptyMap()))).toString()
            return state.copy(ack = ack)
        }
        return when {
            api == "fromWidget" && !hasResponse -> BridgeInbound.ToDriver(raw)
            api == "toWidget" && obj["response"] is JsonObject -> BridgeInbound.ToDriver(raw)
            else -> BridgeInbound.Drop("not a fromWidget request or toWidget response")
        }
    }

    private fun parseCallState(obj: JsonObject): BridgeInbound {
        val body = obj["data"] as? JsonObject ?: obj
        val phase = CallPhase.fromWire(body.str("state")) ?: return BridgeInbound.Drop("unknown call state")
        return BridgeInbound.CallState(
            CallStateUpdate(
                phase = phase,
                video = body.bool("video") ?: false,
                muted = body.bool("muted") ?: false,
                e2ee = CallE2ee.fromWire(body.str("e2ee")),
            ),
        )
    }

    fun actionMessage(action: CallAction): String = buildJsonObject {
        put("type", CALL_ACTION_TYPE)
        put("action", action.wire)
    }.toString()

    /**
     * JavaScript that delivers [message] (a JSON string from the driver) to the widget page:
     * `window.postMessage(<json>, '<origin>')`. The message is re-serialised from its parsed form,
     * so only JSON reaches the script (no injection through a malformed string), and U+2028/U+2029
     * are escaped for older JavaScript engines. Returns null if [message] is not a JSON object.
     */
    fun postMessageScript(message: String, targetOrigin: String): String? {
        // Widget-API messages are JSON objects. Anything else (including bare literals, which the
        // JSON parser accepts) is refused, so nothing but an object literal reaches the script.
        val element: JsonElement = try {
            json.parseToJsonElement(message) as? JsonObject
        } catch (_: Exception) {
            null
        } ?: return null
        val payload = element.toString().replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")
        val origin = JsonPrimitive(targetOrigin).toString()
        return "window.postMessage($payload, $origin);"
    }

    private fun JsonObject.str(key: String): String? = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content

    private fun JsonObject.bool(key: String): Boolean? = (this[key] as? JsonPrimitive)?.takeUnless { it.isString }?.booleanOrNull
}

/** The label the call screen shows for media encryption; derived only from the widget's report. */
enum class CallEncryptionLabel { END_TO_END_ENCRYPTED, WAITING_FOR_KEYS, NOT_ENCRYPTED, DECRYPTION_ERROR, UNKNOWN }

fun CallE2ee.label(): CallEncryptionLabel = when (this) {
    CallE2ee.ENCRYPTED -> CallEncryptionLabel.END_TO_END_ENCRYPTED
    CallE2ee.WAITING_FOR_KEY -> CallEncryptionLabel.WAITING_FOR_KEYS
    CallE2ee.NOT_ENCRYPTED -> CallEncryptionLabel.NOT_ENCRYPTED
    CallE2ee.DECRYPT_ERROR -> CallEncryptionLabel.DECRYPTION_ERROR
    CallE2ee.UNKNOWN -> CallEncryptionLabel.UNKNOWN
}

/**
 * Widget URL (integration.md §6.2): the Rust SDK fills the `$…` placeholders in
 * `generateWebviewUrl`. Placeholder names are the ones compiled into sdk-android 26.09.28
 * (checked in libmatrix_sdk_ffi.so): the device ID is `$org.matrix.msc2873.matrix_device_id`;
 * the `msc3819` spelling in integration.md is not substituted by this SDK.
 */
object CallWidgetUrl {
    const val ASSET_ORIGIN = "https://appassets.androidplatform.net"
    const val INDEX = "$ASSET_ORIGIN/call-widget/index.html"

    enum class Intent(val wire: String) { START_CALL("start_call"), JOIN_EXISTING("join_existing") }
    enum class Notify(val wire: String) { RING("ring"), NOTIFICATION("notification"), NONE("none") }

    fun rawUrl(intent: Intent, video: Boolean, notify: Notify, theme: String, lang: String): String {
        require(theme == "light" || theme == "dark")
        val safeLang = lang.filter { it.isLetterOrDigit() || it == '-' }.take(35).ifEmpty { "en" }
        return INDEX +
            "?widgetId=\$matrix_widget_id" +
            "&parentUrl=" + java.net.URLEncoder.encode(ASSET_ORIGIN, Charsets.UTF_8) +
            "&roomId=\$matrix_room_id" +
            "&userId=\$matrix_user_id" +
            "&deviceId=\$org.matrix.msc2873.matrix_device_id" +
            "&baseUrl=\$org.matrix.msc4039.matrix_base_url" +
            "&lang=$safeLang" +
            "&theme=$theme" +
            "&intent=${intent.wire}" +
            "&video=$video" +
            "&notify=${notify.wire}"
    }
}
