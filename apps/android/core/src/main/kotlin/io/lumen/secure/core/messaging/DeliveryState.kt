package io.lumen.secure.core.messaging

/**
 * What the UI says about one of the user's own messages (integration.md §5):
 * - "Sending" for a local echo still in the SDK's send queue;
 * - "Sent" only once the server returned an event ID;
 * - "Read" only when a receipt from someone else exists;
 * - never "delivered" while the event is queued.
 */
enum class DeliveryState { NONE, SENDING, SENT, READ, FAILED }

/** The SDK's send state, reduced to what the mapping needs (mapped from `EventSendState` in the app). */
sealed interface SendStateInput {
    /** A remote event (it came back from the server). */
    data object Remote : SendStateInput

    /** Local echo, not yet acknowledged by the server (uploading, queued or sending). */
    data object NotSentYet : SendStateInput

    data class Failed(val recoverable: Boolean) : SendStateInput

    /** The server returned an event ID; the remote echo may not have arrived yet. */
    data class Sent(val eventId: String) : SendStateInput
}

object DeliveryStates {
    fun map(isOwn: Boolean, state: SendStateInput, receiptUserIds: Collection<String>, ownUserId: String): DeliveryState {
        if (!isOwn) return DeliveryState.NONE
        return when (state) {
            SendStateInput.NotSentYet -> DeliveryState.SENDING
            is SendStateInput.Failed -> DeliveryState.FAILED
            is SendStateInput.Sent, SendStateInput.Remote ->
                if (receiptUserIds.any { it != ownUserId }) DeliveryState.READ else DeliveryState.SENT
        }
    }
}
