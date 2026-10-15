package io.lumen.secure.core

import io.lumen.secure.core.calls.HomeserverApi
import io.lumen.secure.core.calls.NativeRtc
import io.lumen.secure.core.config.HttpResponse
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/** The MSC4533 / MSC4515 actions answered next to the widget driver (port of native_rtc.rs). */
class NativeRtcTest {
    private val room = "!room:example.com"
    private val user = "@alice:example.com"
    private val device = "DEVICEID"
    private val wid = "w-1"
    private val accessToken = "syt_SECRET_ACCESS_TOKEN"

    /** Fake homeserver: records requests; "uses" an access token the widget must never see. */
    private class FakeHs(private val token: String, var reply: (String, String, String?) -> HttpResponse) : HomeserverApi {
        val calls = mutableListOf<Triple<String, String, String?>>()
        override fun request(method: String, path: String, jsonBody: String?): HttpResponse {
            calls += Triple(method, path, jsonBody)
            check(token.isNotEmpty()) // the app's implementation sends it in the Authorization header only
            return reply(method, path, jsonBody)
        }
        override fun url(path: String) = "https://matrix.example.com/$path"
    }

    private fun rtc(hs: HomeserverApi) = NativeRtc(room, user, device, wid, hs)
    private fun obj(s: String) = Json.parseToJsonElement(s).jsonObject

    private fun negotiate(r: NativeRtc, requestToken: Boolean, approveTransports: Boolean) {
        val caps = mutableListOf("\"org.matrix.msc4143.rtc_member\"")
        if (requestToken) caps += "\"${NativeRtc.GET_TOKEN}\""
        r.onFromWidget("""{"api":"toWidget","widgetId":"$wid","requestId":"c1","action":"capabilities","data":{},"response":{"capabilities":[${caps.joinToString(",")}]}}""")
        val approved = if (approveTransports) "[\"${NativeRtc.TRANSPORTS_CAPABILITY}\"]" else "[]"
        r.onToWidget("""{"api":"toWidget","widgetId":"$wid","requestId":"n1","action":"notify_capabilities","data":{"requested":[],"approved":$approved}}""")
    }

    private fun tokenRequest(roomId: String = room, memberId: String = "$user:$device") =
        """{"api":"fromWidget","widgetId":"$wid","requestId":"t1","action":"${NativeRtc.GET_TOKEN}","data":{"room_id":"$roomId","slot_id":"m.call#ROOM","member_id":"$memberId"}}"""

    @Test
    fun `routing - only the two fromWidget requests for our widget are intercepted`() {
        val r = rtc(FakeHs(accessToken) { _, _, _ -> HttpResponse(500, "") })
        assertTrue(r.onFromWidget(tokenRequest()) is NativeRtc.FromWidget.Intercepted)
        assertTrue(r.onFromWidget("""{"api":"fromWidget","widgetId":"$wid","requestId":"x","action":"${NativeRtc.GET_TRANSPORTS}","data":{}}""") is NativeRtc.FromWidget.Intercepted)
        // everything else goes to the driver
        assertSame(NativeRtc.FromWidget.Forward, r.onFromWidget("""{"api":"fromWidget","widgetId":"$wid","requestId":"x","action":"send_event","data":{}}"""))
        assertSame(NativeRtc.FromWidget.Forward, r.onFromWidget("""{"api":"fromWidget","widgetId":"$wid","requestId":"x","action":"org.matrix.msc4533.rtc_livekit_delegate_delayed_leave","data":{}}"""))
        assertSame(NativeRtc.FromWidget.Forward, r.onFromWidget(tokenRequest().replace("\"data\"", "\"response\":{},\"data\"")))
        assertSame(NativeRtc.FromWidget.Forward, r.onFromWidget(tokenRequest().replace(wid, "other")))
        assertSame(NativeRtc.FromWidget.Forward, r.onFromWidget("not json"))
    }

    @Test
    fun `supported_api_versions gains msc4533 once`() {
        val r = rtc(FakeHs(accessToken) { _, _, _ -> HttpResponse(500, "") })
        val msg = """{"api":"fromWidget","widgetId":"$wid","requestId":"v","action":"supported_api_versions","data":{},"response":{"supported_versions":["0.0.2","org.matrix.msc2762"]}}"""
        val out = obj(r.onToWidget(msg))
        val list = out["response"]!!.jsonObject["supported_versions"]!!.jsonArray.map { it.jsonPrimitive.content }
        assertEquals(listOf("0.0.2", "org.matrix.msc2762", "org.matrix.msc4533"), list)
        assertEquals("v", out["requestId"]!!.jsonPrimitive.content)
        val again = r.onToWidget(out.toString())
        assertEquals(out.toString(), again)
        // unrelated driver messages pass unchanged
        val other = """{"api":"toWidget","widgetId":"$wid","requestId":"s","action":"send_to_device","data":{}}"""
        assertSame(other, r.onToWidget(other))
    }

    @Test
    fun `token capability is granted only when the widget asked for it`() {
        val asked = rtc(FakeHs(accessToken) { _, _, _ -> HttpResponse(500, "") })
        asked.onFromWidget("""{"api":"toWidget","widgetId":"$wid","requestId":"c","action":"capabilities","data":{},"response":{"capabilities":["${NativeRtc.GET_TOKEN}"]}}""")
        val notify = """{"api":"toWidget","widgetId":"$wid","requestId":"n","action":"notify_capabilities","data":{"requested":[],"approved":["a"]}}"""
        val approved = obj(asked.onToWidget(notify))["data"]!!.jsonObject["approved"]!!.jsonArray.map { it.jsonPrimitive.content }
        assertEquals(listOf("a", NativeRtc.GET_TOKEN), approved)

        val notAsked = rtc(FakeHs(accessToken) { _, _, _ -> HttpResponse(500, "") })
        notAsked.onFromWidget("""{"api":"toWidget","widgetId":"$wid","requestId":"c","action":"capabilities","data":{},"response":{"capabilities":["a"]}}""")
        assertSame(notify, notAsked.onToWidget(notify))
        // and the action is refused without the capability, with no homeserver call
        val hs = FakeHs(accessToken) { _, _, _ -> HttpResponse(200, """{"jwt":"x"}""") }
        val r = rtc(hs)
        val ans = obj(r.answer((r.onFromWidget(tokenRequest()) as NativeRtc.FromWidget.Intercepted).request))
        assertEquals("Missing capability", ans["response"]!!.jsonObject["error"]!!.jsonObject["message"]!!.jsonPrimitive.content)
        assertTrue(hs.calls.isEmpty())
    }

    @Test
    fun `token only for the driver's room and this device's member id, body passed verbatim`() {
        val hs = FakeHs(accessToken) { _, _, _ -> HttpResponse(200, """{"url":"wss://rtc.example.com","jwt":"eyJ.sfu.token"}""") }
        val r = rtc(hs)
        negotiate(r, requestToken = true, approveTransports = false)

        for ((roomId, member, why) in listOf(
            Triple("!other:example.com", "$user:$device", "own room"),
            Triple(room, "@mallory:example.com:$device", "call membership"),
            Triple(room, "$user:OTHERDEVICE", "call membership"),
        )) {
            val req = (r.onFromWidget(tokenRequest(roomId, member)) as NativeRtc.FromWidget.Intercepted).request
            val err = obj(r.answer(req))["response"]!!.jsonObject["error"]!!.jsonObject["message"]!!.jsonPrimitive.content
            assertTrue("$roomId/$member: $err", err.contains(why))
        }
        assertTrue(hs.calls.isEmpty())

        val req = (r.onFromWidget(tokenRequest()) as NativeRtc.FromWidget.Intercepted).request
        val answer = r.answer(req)
        val response = obj(answer)["response"]!!.jsonObject
        assertEquals("eyJ.sfu.token", response["jwt"]!!.jsonPrimitive.content)
        assertEquals("t1", obj(answer)["requestId"]!!.jsonPrimitive.content)
        val (method, path, body) = hs.calls.single()
        assertEquals("POST", method)
        assertEquals("_matrix/client/unstable/io.element.msc4195/rtc/livekit/get_token", path)
        assertEquals(req["data"], Json.parseToJsonElement(body!!))
        assertFalse(answer.contains(accessToken))
    }

    @Test
    fun `homeserver errors keep their status for matrix-js-sdk, without credentials`() {
        val hs = FakeHs(accessToken) { _, _, _ -> HttpResponse(403, """{"errcode":"M_FORBIDDEN","error":"not a member"}""") }
        val r = rtc(hs)
        negotiate(r, requestToken = true, approveTransports = false)
        val answer = r.answer((r.onFromWidget(tokenRequest()) as NativeRtc.FromWidget.Intercepted).request)
        val err = obj(answer)["response"]!!.jsonObject["error"]!!.jsonObject
        val mae = err["matrix_api_error"]!!.jsonObject
        assertEquals(403, mae["http_status"]!!.jsonPrimitive.content.toInt())
        assertEquals("M_FORBIDDEN", mae["response"]!!.jsonObject["errcode"]!!.jsonPrimitive.content)
        assertFalse(answer.contains(accessToken))
        // a 200 without a JWT is refused too
        hs.reply = { _, _, _ -> HttpResponse(200, "{}") }
        val noJwt = r.answer((r.onFromWidget(tokenRequest()) as NativeRtc.FromWidget.Intercepted).request)
        assertEquals("The homeserver returned no token", obj(noJwt)["response"]!!.jsonObject["error"]!!.jsonObject["message"]!!.jsonPrimitive.content)
        // unreachable homeserver
        hs.reply = { _, _, _ -> throw java.io.IOException("down") }
        val down = r.answer((r.onFromWidget(tokenRequest()) as NativeRtc.FromWidget.Intercepted).request)
        assertTrue(obj(down)["response"]!!.jsonObject.containsKey("error"))
    }

    @Test
    fun `transports from the raw endpoint, only with the driver's approval`() {
        val hs = FakeHs(accessToken) { _, _, _ ->
            HttpResponse(200, """{"rtc_transports":[{"type":"livekit","url":"wss://rtc.example.com"},{"url":"wss://untyped"},{"type":7}]}""")
        }
        val req = """{"api":"fromWidget","widgetId":"$wid","requestId":"g","action":"${NativeRtc.GET_TRANSPORTS}","data":{}}"""
        val denied = rtc(hs)
        negotiate(denied, requestToken = false, approveTransports = false)
        val d = obj(denied.answer((denied.onFromWidget(req) as NativeRtc.FromWidget.Intercepted).request))
        assertEquals("Missing capability", d["response"]!!.jsonObject["error"]!!.jsonObject["message"]!!.jsonPrimitive.content)
        assertTrue(hs.calls.isEmpty())

        val r = rtc(hs)
        negotiate(r, requestToken = false, approveTransports = true)
        val a = obj(r.answer((r.onFromWidget(req) as NativeRtc.FromWidget.Intercepted).request))
        val transports = a["response"]!!.jsonObject["rtc_transports"] as JsonArray
        assertEquals(1, transports.size)
        assertEquals("wss://rtc.example.com", transports[0].jsonObject["url"]!!.jsonPrimitive.content)
        assertEquals(Triple("GET", "_matrix/client/unstable/org.matrix.msc4143/rtc/transports", null as String?), hs.calls.single())

        hs.reply = { _, _, _ -> HttpResponse(200, """{"rtc_transports":[]}""") }
        val none = obj(r.answer((r.onFromWidget(req) as NativeRtc.FromWidget.Intercepted).request))
        assertTrue(none["response"]!!.jsonObject.containsKey("error"))
    }

    @Test
    fun `raw transports check used for call availability`() {
        assertTrue(NativeRtc.hasTransports("""{"rtc_transports":[{"type":"livekit","url":"wss://rtc.example.com"}]}"""))
        assertFalse(NativeRtc.hasTransports("""{"rtc_transports":[]}"""))
        assertFalse(NativeRtc.hasTransports("""{"rtc_transports":[{"url":"x"}]}"""))
        assertFalse(NativeRtc.hasTransports("<html>"))
        assertNull((obj("""{"a":1}""")["rtc_transports"] as? JsonObject))
    }
}
