package io.lumen.secure.matrix

import org.matrix.rustcomponents.sdk.CreateRoomParameters
import org.matrix.rustcomponents.sdk.RoomPreset
import org.matrix.rustcomponents.sdk.RoomVisibility

/** New chats are always created encrypted (integration.md §5). */
object DirectChats {
    /** Returns the existing DM with [userId] or creates an encrypted one. */
    suspend fun open(session: MatrixSession, userId: String): String {
        session.client.getDmRoom(userId)?.let { return it.id() }
        return session.client.createRoom(
            CreateRoomParameters(
                name = null,
                isEncrypted = true,
                isDirect = true,
                visibility = RoomVisibility.Private,
                preset = RoomPreset.TRUSTED_PRIVATE_CHAT,
                invite = listOf(userId),
            ),
        )
    }

    suspend fun createGroup(session: MatrixSession, name: String, topic: String?, invite: List<String>): String =
        session.client.createRoom(
            CreateRoomParameters(
                name = name.trim().take(255),
                topic = topic?.trim()?.takeIf { it.isNotEmpty() },
                isEncrypted = true,
                isDirect = false,
                visibility = RoomVisibility.Private,
                preset = RoomPreset.PRIVATE_CHAT,
                invite = invite,
            ),
        )
}
