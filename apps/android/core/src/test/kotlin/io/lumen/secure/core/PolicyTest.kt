package io.lumen.secure.core

import io.lumen.secure.core.messaging.DeliveryState
import io.lumen.secure.core.messaging.DeliveryStates
import io.lumen.secure.core.messaging.SendStateInput
import io.lumen.secure.core.notifications.NotificationPreview
import io.lumen.secure.core.notifications.NotificationPreviewPolicy
import io.lumen.secure.core.notifications.PreviewStrings
import io.lumen.secure.core.push.PushPayload
import io.lumen.secure.core.push.PusherPolicy
import io.lumen.secure.core.search.LocalSearch
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PolicyTest {
    private val me = "@me:example.com"

    @Test
    fun `delivery state comes only from the SDK send state and receipts`() {
        assertEquals(DeliveryState.SENDING, DeliveryStates.map(true, SendStateInput.NotSentYet, listOf("@bob:example.com"), me))
        assertEquals(DeliveryState.FAILED, DeliveryStates.map(true, SendStateInput.Failed(true), emptyList(), me))
        assertEquals(DeliveryState.SENT, DeliveryStates.map(true, SendStateInput.Sent("\$e"), emptyList(), me))
        assertEquals(DeliveryState.SENT, DeliveryStates.map(true, SendStateInput.Remote, listOf(me), me))
        assertEquals(DeliveryState.READ, DeliveryStates.map(true, SendStateInput.Remote, listOf(me, "@bob:example.com"), me))
        assertEquals(DeliveryState.NONE, DeliveryStates.map(false, SendStateInput.Remote, listOf("@bob:example.com"), me))
        // A queued message is never shown as read even if receipts were attached to its echo.
        assertEquals(DeliveryState.SENDING, DeliveryStates.map(true, SendStateInput.NotSentYet, listOf("@bob:example.com", me), me))
    }

    private val strings = PreviewStrings(
        appName = "Lumen",
        newMessage = "New message",
        newMessageInRoom = { "New message in $it" },
        incomingCall = "Incoming call",
        incomingCallFrom = { "Call from $it" },
        invite = "New invitation",
    )

    @Test
    fun `notification previews are hidden by default`() {
        assertEquals(NotificationPreview.HIDDEN, NotificationPreview.DEFAULT)
        assertEquals(NotificationPreview.HIDDEN, NotificationPreview.fromKey("garbage"))
        val t = NotificationPreviewPolicy.message(NotificationPreview.HIDDEN, strings, "Alice", "Secret project", false, "the launch code is 1234")
        assertEquals("Lumen", t.title)
        assertEquals("New message", t.body)
    }

    @Test
    fun `sender policy shows sender but not text`() {
        val t = NotificationPreviewPolicy.message(NotificationPreview.SENDER, strings, "Alice", "Team", false, "hello")
        assertEquals("Alice · Team", t.title)
        assertEquals("New message", t.body)
        val dm = NotificationPreviewPolicy.message(NotificationPreview.SENDER, strings, "Alice", "Alice", true, "hello")
        assertEquals("Alice", dm.title)
    }

    @Test
    fun `sender and text policy shows a cleaned, bounded body`() {
        val t = NotificationPreviewPolicy.message(NotificationPreview.SENDER_AND_TEXT, strings, "Alice", null, true, "line1\nline2\u0007" + "x".repeat(500))
        assertEquals("Alice", t.title)
        assertEquals(240, t.body.length)
        assertEquals("line1 line2", t.body.substring(0, 11))
        val empty = NotificationPreviewPolicy.message(NotificationPreview.SENDER_AND_TEXT, strings, null, null, true, null)
        assertEquals("Lumen", empty.title)
        assertEquals("New message", empty.body)
    }

    @Test
    fun `call notifications follow the same policy`() {
        assertEquals("Incoming call", NotificationPreviewPolicy.call(NotificationPreview.HIDDEN, strings, "Alice").body)
        assertEquals("Call from Alice", NotificationPreviewPolicy.call(NotificationPreview.SENDER, strings, "Alice").body)
    }

    @Test
    fun `push payloads carry only valid identifiers`() {
        val ok = PushPayload.parse(mapOf("room_id" to "!r:example.com", "event_id" to "\$abcdef", "unread" to "3", "prio" to "high"))!!
        assertEquals("!r:example.com", ok.roomId)
        assertEquals(3, ok.unread)
        assertNull(PushPayload.parse(mapOf("room_id" to "not a room", "event_id" to "\$abcdef")))
        assertNull(PushPayload.parse(mapOf("unread" to "0")))
        assertEquals(0, PushPayload.unreadOnly(mapOf("unread" to "0")))
    }

    @Test
    fun `pusher only with FCM, gateway and token`() {
        val gw = "https://matrix.example.com/_matrix/push/v1/notify"
        val spec = PusherPolicy.spec(true, "io.lumen.secure.android", gw, "tok")!!
        assertEquals("event_id_only", spec.format)
        assertEquals(gw, spec.gatewayUrl)
        assertNull(PusherPolicy.spec(false, "io.lumen.secure.android", gw, "tok"))
        assertNull(PusherPolicy.spec(true, "io.lumen.secure.android", null, "tok"))
        assertNull(PusherPolicy.spec(true, "io.lumen.secure.android", "http://matrix.example.com/notify", "tok"))
        assertNull(PusherPolicy.spec(true, "io.lumen.secure.android", gw, " "))
    }

    @Test
    fun `local search is case and accent insensitive and needs every term`() {
        val msgs = listOf("Café meeting at noon", "cafe closed", "Lunch?", null)
        val hits = LocalSearch.search(msgs, "CAFE meeting") { it }
        assertEquals(listOf("Café meeting at noon"), hits.map { it.item })
        assertEquals(2, LocalSearch.search(msgs, "café") { it }.size)
        assertEquals(emptyList<Any>(), LocalSearch.search(msgs, "   ") { it })
        assertEquals(listOf(0, 2), LocalSearch.filterRooms(listOf("Design", "Ops", "design review"), "DES"))
    }
}
