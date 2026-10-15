package io.lumen.secure.matrix

import io.lumen.secure.core.search.LocalSearch
import io.lumen.secure.log.LumenLog
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.consumeAsFlow
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.launch
import org.matrix.rustcomponents.sdk.LatestEventValue
import org.matrix.rustcomponents.sdk.Membership
import org.matrix.rustcomponents.sdk.Room
import org.matrix.rustcomponents.sdk.RoomListEntriesDynamicFilterKind
import org.matrix.rustcomponents.sdk.RoomListEntriesListener
import org.matrix.rustcomponents.sdk.RoomListEntriesUpdate
import org.matrix.rustcomponents.sdk.RoomListLoadingState
import org.matrix.rustcomponents.sdk.RoomListLoadingStateListener
import org.matrix.rustcomponents.sdk.TaskHandle
import uniffi.matrix_sdk_base.EncryptionState

data class RoomSummary(
    val id: String,
    val name: String,
    val isDirect: Boolean,
    val isInvite: Boolean,
    val inviterName: String?,
    val encrypted: Boolean,
    val unreadMessages: Long,
    val unreadMentions: Long,
    val markedUnread: Boolean,
    val lastMessage: String?,
    val lastTimestamp: Long?,
    val hasCall: Boolean,
) {
    val hasUnread: Boolean get() = unreadMessages > 0 || unreadMentions > 0 || markedUnread
}

enum class RoomCategory { ALL, PEOPLE, GROUPS, UNREAD, INVITES }

/** The room list from the SDK's RoomListService (sliding sync), applied diff by diff. */
@OptIn(FlowPreview::class)
class RoomListController(private val session: MatrixSession, private val strings: TimelineStrings) {
    private val rooms = mutableListOf<Room>()
    private val summaries = MutableStateFlow<List<RoomSummary>>(emptyList())
    private val _loaded = MutableStateFlow(false)
    val loaded: StateFlow<Boolean> = _loaded.asStateFlow()
    val category = MutableStateFlow(RoomCategory.ALL)
    val query = MutableStateFlow("")
    private val handles = mutableListOf<TaskHandle>()
    private val refresh = Channel<Unit>(Channel.CONFLATED)
    private var job: Job? = null

    val visible: StateFlow<List<RoomSummary>> = combine(summaries, category, query) { all, cat, q ->
        val byCat = all.filter {
            when (cat) {
                RoomCategory.ALL -> true
                RoomCategory.PEOPLE -> it.isDirect && !it.isInvite
                RoomCategory.GROUPS -> !it.isDirect && !it.isInvite
                RoomCategory.UNREAD -> it.hasUnread
                RoomCategory.INVITES -> it.isInvite
            }
        }
        LocalSearch.filterRooms(byCat.map { it.name }, q).map { byCat[it] }
    }.stateIn(session.scope, SharingStarted.Eagerly, emptyList())

    val inviteCount: StateFlow<Int> = combine(summaries, query) { all, _ -> all.count { it.isInvite } }
        .stateIn(session.scope, SharingStarted.Eagerly, 0)

    fun start() {
        if (job != null) return
        job = session.scope.launch {
            try {
                val list = session.roomListService().allRooms()
                val result = list.entriesWithDynamicAdapters(
                    PAGE_SIZE,
                    object : RoomListEntriesListener {
                        override fun onUpdate(roomEntriesUpdate: List<RoomListEntriesUpdate>) {
                            synchronized(rooms) { roomEntriesUpdate.forEach(::apply) }
                            refresh.trySend(Unit)
                        }
                    },
                )
                handles += result.entriesStream()
                val controller = result.controller()
                controller.setFilter(
                    RoomListEntriesDynamicFilterKind.All(
                        listOf(
                            RoomListEntriesDynamicFilterKind.NonSpace,
                            RoomListEntriesDynamicFilterKind.NonLeft,
                            RoomListEntriesDynamicFilterKind.DeduplicateVersions,
                        ),
                    ),
                )
                val loading = list.loadingState(
                    object : RoomListLoadingStateListener {
                        override fun onUpdate(state: RoomListLoadingState) {
                            if (state is RoomListLoadingState.Loaded) _loaded.value = true
                        }
                    },
                )
                if (loading.state is RoomListLoadingState.Loaded) _loaded.value = true
                handles += loading.stateStream
                refresh.consumeAsFlow().debounce(150).collect { recompute() }
            } catch (e: Exception) {
                LumenLog.w("roomlist", "room list failed", e)
            }
        }
    }

    private fun apply(u: RoomListEntriesUpdate) {
        when (u) {
            is RoomListEntriesUpdate.Append -> rooms.addAll(u.values)
            RoomListEntriesUpdate.Clear -> rooms.clear()
            is RoomListEntriesUpdate.PushFront -> rooms.add(0, u.value)
            is RoomListEntriesUpdate.PushBack -> rooms.add(u.value)
            RoomListEntriesUpdate.PopFront -> if (rooms.isNotEmpty()) rooms.removeAt(0)
            RoomListEntriesUpdate.PopBack -> if (rooms.isNotEmpty()) rooms.removeAt(rooms.lastIndex)
            is RoomListEntriesUpdate.Insert -> rooms.add(u.index.toInt().coerceIn(0, rooms.size), u.value)
            is RoomListEntriesUpdate.Set -> if (u.index.toInt() in rooms.indices) rooms[u.index.toInt()] = u.value
            is RoomListEntriesUpdate.Remove -> if (u.index.toInt() in rooms.indices) rooms.removeAt(u.index.toInt())
            is RoomListEntriesUpdate.Truncate -> while (rooms.size > u.length.toInt()) rooms.removeAt(rooms.lastIndex)
            is RoomListEntriesUpdate.Reset -> {
                rooms.clear()
                rooms.addAll(u.values)
            }
        }
    }

    private suspend fun recompute() {
        val snapshot = synchronized(rooms) { rooms.toList() }
        summaries.value = snapshot.mapNotNull { room ->
            try {
                summarise(room)
            } catch (e: Exception) {
                LumenLog.w("roomlist", "room summary failed", e)
                null
            }
        }
    }

    private suspend fun summarise(room: Room): RoomSummary {
        val info = room.roomInfo()
        val latest = try {
            room.latestEvent()
        } catch (_: Exception) {
            LatestEventValue.None
        }
        val (text, ts) = when (latest) {
            is LatestEventValue.Remote -> TimelineMapper.previewText(latest.content, strings) to latest.timestamp.toLong()
            is LatestEventValue.Local -> TimelineMapper.previewText(latest.content, strings) to latest.timestamp.toLong()
            is LatestEventValue.RemoteInvite -> null to latest.timestamp.toLong()
            else -> null to null
        }
        val invite = info.membership == Membership.INVITED
        return RoomSummary(
            id = info.id,
            name = info.displayName?.takeIf { it.isNotBlank() } ?: strings.unnamedRoom,
            isDirect = info.isDirect,
            isInvite = invite,
            inviterName = info.inviter?.let { it.displayName ?: it.userId },
            encrypted = info.encryptionState == EncryptionState.ENCRYPTED,
            unreadMessages = info.numUnreadMessages.toLong(),
            unreadMentions = info.numUnreadMentions.toLong(),
            markedUnread = info.isMarkedUnread,
            lastMessage = text,
            lastTimestamp = ts,
            hasCall = info.hasRoomCall,
        )
    }

    fun stop() {
        handles.forEach { it.cancel() }
        handles.clear()
        job?.cancel()
        job = null
    }

    private companion object {
        val PAGE_SIZE = 1000u
    }
}
