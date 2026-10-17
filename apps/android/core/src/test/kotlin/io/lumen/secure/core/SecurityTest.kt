package io.lumen.secure.core

import io.lumen.secure.core.calls.BridgeInbound
import io.lumen.secure.core.calls.CallAction
import io.lumen.secure.core.calls.CallE2ee
import io.lumen.secure.core.calls.CallEncryptionLabel
import io.lumen.secure.core.calls.CallPhase
import io.lumen.secure.core.calls.CallWidgetUrl
import io.lumen.secure.core.calls.WidgetBridge
import io.lumen.secure.core.calls.label
import io.lumen.secure.core.log.Redactor
import io.lumen.secure.core.security.AppLockTimer
import io.lumen.secure.core.security.AutoLockTimeout
import io.lumen.secure.core.security.BlobStorage
import io.lumen.secure.core.security.KeyWrapper
import io.lumen.secure.core.security.SealedBlob
import io.lumen.secure.core.security.SecretVault
import io.lumen.secure.core.security.StoredSession
import io.lumen.secure.core.security.VaultException
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class SecurityTest {

    // ---- widget bridge --------------------------------------------------------------------------
    private val wid = "w-123"

    @Test
    fun `only fromWidget requests and toWidget responses for our widget reach the driver`() {
        val req = """{"api":"fromWidget","widgetId":"w-123","requestId":"r1","action":"send_event","data":{}}"""
        assertEquals(BridgeInbound.ToDriver(req), WidgetBridge.classify(req, wid))
        val resp = """{"api":"toWidget","widgetId":"w-123","requestId":"r2","action":"capabilities","data":{},"response":{"capabilities":[]}}"""
        assertEquals(BridgeInbound.ToDriver(resp), WidgetBridge.classify(resp, wid))

        // a toWidget *request* (no response) would be the widget impersonating the client
        assertTrue(WidgetBridge.classify("""{"api":"toWidget","widgetId":"w-123","requestId":"r","action":"x","data":{}}""", wid) is BridgeInbound.Drop)
        // a fromWidget *response* is not something the widget sends to the driver
        assertTrue(WidgetBridge.classify("""{"api":"fromWidget","widgetId":"w-123","requestId":"r","action":"x","response":{}}""", wid) is BridgeInbound.Drop)
        assertTrue(WidgetBridge.classify(req.replace("w-123", "other"), wid) is BridgeInbound.Drop)
        assertTrue(WidgetBridge.classify("""{"api":"fromWidget","widgetId":"w-123","action":"x"}""", wid) is BridgeInbound.Drop)
        assertTrue(WidgetBridge.classify("[1,2]", wid) is BridgeInbound.Drop)
        assertTrue(WidgetBridge.classify("not json", wid) is BridgeInbound.Drop)
        assertTrue(WidgetBridge.classify("{\"api\":\"fromWidget\",\"pad\":\"" + "x".repeat(WidgetBridge.MAX_MESSAGE_BYTES) + "\"}", wid) is BridgeInbound.Drop)
    }

    @Test
    fun `call state messages are parsed, flat or nested`() {
        val flat = WidgetBridge.classify("""{"type":"io.lumen.call_state","state":"connected","video":true,"muted":false,"e2ee":"encrypted"}""", wid)
        val u = (flat as BridgeInbound.CallState).update
        assertEquals(CallPhase.CONNECTED, u.phase)
        assertTrue(u.video)
        assertEquals(CallE2ee.ENCRYPTED, u.e2ee)
        val nested = WidgetBridge.classify("""{"type":"io.lumen.call_state","data":{"state":"reconnecting","e2ee":"something-new"}}""", wid)
        assertEquals(CallE2ee.UNKNOWN, (nested as BridgeInbound.CallState).update.e2ee)
        assertTrue(WidgetBridge.classify("""{"type":"io.lumen.call_state","state":"hacked"}""", wid) is BridgeInbound.Drop)
        // strings are not booleans
        val s = WidgetBridge.classify("""{"type":"io.lumen.call_state","state":"connected","muted":"true"}""", wid) as BridgeInbound.CallState
        assertFalse(s.update.muted)
    }

    @Test
    fun `call state as a fromWidget request is acknowledged, never forwarded`() {
        val req = """{"api":"fromWidget","widgetId":"w-123","requestId":"r9","action":"io.lumen.call_state","data":{"state":"connected","video":false,"muted":true,"e2ee":"waiting-for-key"}}"""
        val r = WidgetBridge.classify(req, wid) as BridgeInbound.CallState
        assertEquals(CallPhase.CONNECTED, r.update.phase)
        assertTrue(r.update.muted)
        assertEquals(CallE2ee.WAITING_FOR_KEY, r.update.e2ee)
        val ack = kotlinx.serialization.json.Json.parseToJsonElement(r.ack!!).jsonObject
        assertEquals("r9", ack["requestId"]!!.jsonPrimitive.content)
        assertEquals("{}", ack["response"].toString())
        // other io.lumen.* actions and responses are dropped
        assertTrue(WidgetBridge.classify(req.replace("io.lumen.call_state", "io.lumen.other"), wid) is BridgeInbound.Drop)
        assertTrue(WidgetBridge.classify("""{"api":"toWidget","widgetId":"w-123","requestId":"r","action":"io.lumen.call_action","response":{}}""", wid) is BridgeInbound.Drop)
        // the shape the bundled widget actually posts: {"type":"io.lumen.call_state","data":{…}}
        val posted = WidgetBridge.classify("""{"type":"io.lumen.call_state","data":{"state":"ended","video":false,"muted":false,"e2ee":"unknown","e2eeLabel":"none","reason":null,"error":true}}""", wid)
        assertEquals(CallPhase.ENDED, (posted as BridgeInbound.CallState).update.phase)
        assertNull(posted.ack)
    }

    @Test
    fun `encryption label comes only from the widget`() {
        assertEquals(CallEncryptionLabel.END_TO_END_ENCRYPTED, CallE2ee.ENCRYPTED.label())
        assertEquals(CallEncryptionLabel.WAITING_FOR_KEYS, CallE2ee.WAITING_FOR_KEY.label())
        assertEquals(CallEncryptionLabel.UNKNOWN, CallE2ee.fromWire(null).label())
    }

    @Test
    fun `postMessage script contains only re-serialised JSON`() {
        val js = WidgetBridge.postMessageScript("{\"a\":\"</script>\u2028\",\"b\":[1]}", CallWidgetUrl.ASSET_ORIGIN)!!
        assertEquals("window.postMessage({\"a\":\"</script>\\u2028\",\"b\":[1]}, \"https://appassets.androidplatform.net\");", js)
        assertNull(WidgetBridge.postMessageScript("alert(1)", CallWidgetUrl.ASSET_ORIGIN))
        assertNull(WidgetBridge.postMessageScript("{}); alert(1); ({", CallWidgetUrl.ASSET_ORIGIN))
        assertEquals("""{"type":"io.lumen.call_action","action":"switch_camera"}""", WidgetBridge.actionMessage(CallAction.SWITCH_CAMERA))
    }

    @Test
    fun `widget URL carries the documented parameters`() {
        val url = CallWidgetUrl.rawUrl(CallWidgetUrl.Intent.START_CALL, video = true, notify = CallWidgetUrl.Notify.RING, theme = "dark", lang = "de-DE")
        assertTrue(url.startsWith("https://appassets.androidplatform.net/call-widget/index.html?widgetId=\$matrix_widget_id"))
        for (p in listOf("roomId=\$matrix_room_id", "userId=\$matrix_user_id", "deviceId=\$org.matrix.msc2873.matrix_device_id",
            "baseUrl=\$org.matrix.msc4039.matrix_base_url", "lang=de-DE", "theme=dark", "intent=start_call", "video=true", "notify=ring",
            "parentUrl=https%3A%2F%2Fappassets.androidplatform.net")) {
            assertTrue(p, url.contains(p))
        }
        assertTrue(CallWidgetUrl.rawUrl(CallWidgetUrl.Intent.JOIN_EXISTING, false, CallWidgetUrl.Notify.NONE, "light", "en&x=<y>").contains("lang=enxy&"))
    }

    // ---- app lock -------------------------------------------------------------------------------
    @Test
    fun `app lock timer`() {
        var now = 1_000L
        val t = AppLockTimer { now }
        t.configure(enabled = true, timeout = AutoLockTimeout.MINUTE_1, startLocked = true)
        assertTrue(t.onForeground())
        t.onUnlocked()
        assertFalse(t.onForeground())
        t.onBackground(); now += 59_000
        assertFalse(t.onForeground())
        t.onBackground(); now += 60_000
        assertTrue(t.onForeground())
        t.onUnlocked()
        t.onBackground(); now -= 10 // clock anomaly locks
        assertTrue(t.onForeground())
        t.configure(enabled = false, timeout = AutoLockTimeout.MINUTE_1, startLocked = false)
        assertFalse(t.locked)
        t.onBackground(); now += 10_000_000
        assertFalse(t.onForeground())
        t.configure(true, AutoLockTimeout.IMMEDIATELY, startLocked = false)
        t.onBackground()
        assertTrue(t.onForeground())
        assertEquals(AutoLockTimeout.MINUTE_1, AutoLockTimeout.fromKey("nope"))
    }

    // ---- vault ----------------------------------------------------------------------------------
    /** Software stand-in for the Keystore wrapper (same AES-256-GCM construction). */
    private class FakeKeyWrapper : KeyWrapper {
        var key: SecretKey? = null
        override fun seal(plaintext: ByteArray, associatedData: ByteArray): SealedBlob {
            val k = key ?: KeyGenerator.getInstance("AES").apply { init(256) }.generateKey().also { key = it }
            val iv = ByteArray(12).also { SecureRandom().nextBytes(it) }
            val c = Cipher.getInstance("AES/GCM/NoPadding")
            c.init(Cipher.ENCRYPT_MODE, k, GCMParameterSpec(128, iv))
            c.updateAAD(associatedData)
            return SealedBlob(iv, c.doFinal(plaintext))
        }
        override fun open(blob: SealedBlob, associatedData: ByteArray): ByteArray {
            val c = Cipher.getInstance("AES/GCM/NoPadding")
            c.init(Cipher.DECRYPT_MODE, key ?: error("no key"), GCMParameterSpec(128, blob.iv))
            c.updateAAD(associatedData)
            return c.doFinal(blob.ciphertext)
        }
        override fun deleteKey() { key = null }
    }

    private class MemStorage : BlobStorage {
        val files = mutableMapOf<String, ByteArray>()
        override fun read(name: String) = files[name]
        override fun write(name: String, bytes: ByteArray) { files[name] = bytes }
        override fun delete(name: String) { files.remove(name) }
        override fun names() = files.keys.toSet()
    }

    @Test
    fun `vault round trip, binding to name, tamper detection and wipe`() {
        val keys = FakeKeyWrapper()
        val storage = MemStorage()
        val v = SecretVault(keys, storage)
        v.put("session", "secret-json".toByteArray())
        v.put("db_key", ByteArray(32) { it.toByte() })
        assertArrayEquals("secret-json".toByteArray(), v.get("session"))
        assertFalse(String(storage.files["session"]!!, Charsets.ISO_8859_1).contains("secret-json"))
        assertNull(v.get("missing"))

        // swapping blobs between names fails (name is associated data)
        storage.files["session"] = storage.files["db_key"]!!
        try { v.get("session"); fail() } catch (_: VaultException) {}

        // tampering fails
        v.put("session", "x".toByteArray())
        val b = storage.files["session"]!!; b[b.size - 1] = (b[b.size - 1] + 1).toByte()
        try { v.get("session"); fail() } catch (_: VaultException) {}

        v.wipe()
        assertTrue(storage.files.isEmpty())
        assertNull(keys.key)
        assertNull(SealedBlob.decode(byteArrayOf(1, 2, 3)))
    }

    @Test
    fun `stored session JSON round trip without leaking secrets in toString`() {
        val s = StoredSession("@a:example.com", "DEV", "syt_secret", null, "https://m.example.com", null, "NATIVE", "abcdef0123", "example.com")
        assertEquals(s, StoredSession.fromJson(s.toJson()))
        assertFalse(s.toString().contains("syt_secret"))
        assertNull(StoredSession.fromJson("""{"v":1,"user_id":"x"}"""))
        assertNull(StoredSession.fromJson(s.toJson().replace("abcdef0123", "../../etc")))
    }

    // ---- logging --------------------------------------------------------------------------------
    @Test
    fun `redactor removes identifiers, tokens and keys`() {
        val raw = "user @alice:example.com in !room:example.com #lounge:example.com event \$abcdefghijkl token=syt_YWxpY2U_abc " +
            "Authorization: Bearer abc.def https://matrix.example.com/_matrix/client/v3/rooms/!x:y/send?access_token=zzz " +
            "key EsTc LW2K PGiF wKEo 9a3o Bu8m 2bN9 Hp47 PGVJ Cyjg 3Sb7 dRbs mail bob@example.org"
        val r = Redactor.redact(raw)
        for (secret in listOf("alice", "!room", "lounge", "abcdefghijkl", "syt_", "abc.def", "rooms/", "zzz", "EsTc", "bob@")) {
            assertFalse("leaked $secret in: $r", r.contains(secret))
        }
        assertTrue(r.contains("https://matrix.example.com"))
        assertEquals("", Redactor.redact(null))
        assertEquals("IllegalStateException: for @<user>", Redactor.describe(IllegalStateException("for @bob:example.com")))
    }

    /** The Rust SDK's errors are nested classes (ClientBuildException.Sdk); causes are kept, redacted. */
    @Test
    fun `describe names nested classes and causes`() {
        val e = SdkLike.Sdk("error sending request for url (https://lumen.example/_matrix/client/versions?access_token=syt_abc)")
        // The URL rule keeps scheme and host and drops the rest of the token (here also the ")").
        assertEquals("SecurityTest.SdkLike.Sdk: error sending request for url (https://lumen.example/…", Redactor.describe(e))
        val chained = IllegalStateException("outer", java.io.IOException("inner @bob:example.com"))
        assertEquals("IllegalStateException: outer ← caused by IOException: inner @<user>", Redactor.describe(chained))
    }

    private sealed class SdkLike(message: String) : Exception(message) {
        class Sdk(message: String) : SdkLike(message)
    }
}
