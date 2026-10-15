package io.lumen.secure

import io.lumen.secure.core.messaging.DeliveryState
import io.lumen.secure.core.messaging.DeliveryStates
import io.lumen.secure.core.messaging.SendStateInput
import io.lumen.secure.matrix.TimelineMapper
import org.junit.Assert.assertEquals
import org.junit.Test
import org.matrix.rustcomponents.sdk.EventSendState
import org.matrix.rustcomponents.sdk.QueueWedgeError

/** The SDK's EventSendState → what the UI may claim (integration.md §5). */
class DeliveryMappingTest {
    private val me = "@me:example.com"

    private fun state(isRemote: Boolean, s: EventSendState?, receipts: Set<String> = emptySet()) =
        DeliveryStates.map(isOwn = true, state = TimelineMapper.sendState(isRemote, s), receiptUserIds = receipts, ownUserId = me)

    @Test
    fun `local echo is sending, never delivered`() {
        assertEquals(SendStateInput.NotSentYet, TimelineMapper.sendState(false, EventSendState.NotSentYet(null)))
        assertEquals(DeliveryState.SENDING, state(false, EventSendState.NotSentYet(null), setOf("@bob:example.com")))
        // A local item without any send state is still not acknowledged by the server.
        assertEquals(DeliveryState.SENDING, state(false, null))
    }

    @Test
    fun `sent only with a server event id, read only with someone else's receipt`() {
        assertEquals(DeliveryState.SENT, state(false, EventSendState.Sent("\$abc")))
        assertEquals(DeliveryState.SENT, state(true, null, setOf(me)))
        assertEquals(DeliveryState.READ, state(true, null, setOf(me, "@bob:example.com")))
    }

    @Test
    fun `failures map to failed, recoverable or not`() {
        assertEquals(DeliveryState.FAILED, state(false, EventSendState.SendingFailed(QueueWedgeError.GenericApiError("x"), true)))
        assertEquals(
            DeliveryState.FAILED,
            state(false, EventSendState.SendingFailed(QueueWedgeError.IdentityViolations(listOf("@bob:example.com")), false)),
        )
        assertEquals(SendStateInput.Failed(false), TimelineMapper.sendState(false, EventSendState.SendingFailed(QueueWedgeError.CrossVerificationRequired, false)))
    }
}
