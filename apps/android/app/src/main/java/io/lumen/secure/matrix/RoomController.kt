package io.lumen.secure.matrix

import io.lumen.secure.core.search.LocalSearch
import io.lumen.secure.data.ReceiptMode
import io.lumen.secure.log.LumenLog
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.matrix.rustcomponents.sdk.EditedContent
import org.matrix.rustcomponents.sdk.FileInfo
import org.matrix.rustcomponents.sdk.IdentityStatusChange
import org.matrix.rustcomponents.sdk.IdentityStatusChangeListener
import org.matrix.rustcomponents.sdk.ImageInfo
import org.matrix.rustcomponents.sdk.Membership
import org.matrix.rustcomponents.sdk.PaginationStatusListener
import org.matrix.rustcomponents.sdk.ReceiptType
import org.matrix.rustcomponents.sdk.Room
import org.matrix.rustcomponents.sdk.RoomInfo
import org.matrix.rustcomponents.sdk.RoomInfoListener
import org.matrix.rustcomponents.sdk.TaskHandle
import org.matrix.rustcomponents.sdk.Timeline
import org.matrix.rustcomponents.sdk.TimelineDiff
import org.matrix.rustcomponents.sdk.TimelineItem
import org.matrix.rustcomponents.sdk.TimelineListener
import org.matrix.rustcomponents.sdk.TypingNotificationsListener
import org.matrix.rustcomponents.sdk.UploadParameters
import org.matrix.rustcomponents.sdk.UploadSource
import org.matrix.rustcomponents.sdk.messageEventContentFromMarkdown
import uniffi.matrix_sdk.PaginationStatus
import uniffi.matrix_sdk_base.EncryptionState
import uniffi.matrix_sdk_crypto.IdentityState
import java.io.File

data class RoomHeader(
    val name: String,
    val isDirect: Boolean,
    val encrypted: Boolean,
    val membership: Membership,
    val inviterName: String?,
    val hasCall: Boolean,
    val memberCount: Long,
)

/** A member whose cryptographic identity changed (integration.md §4: banner + acknowledgement). */
data class IdentityWarning(val userId: String, val displayName: String?, val state: IdentityState)

/** One open room: timeline diffs, sending, receipts, typing, identity warnings. */
class RoomController(
    private val session: MatrixSession,
    val roomId: String,
    private val strings: TimelineStrings,
) {
    private val scope = CoroutineScope(session.scope.coroutineContext + SupervisorJob(session.scope.coroutineContext[Job]))
    private var room: Room? = null
    private var timeline: Timeline? = null
    private val handles = mutableListOf<TaskHandle>()
    private val items = mutableListOf<TimelineItem>()

    private val _rows = MutableStateFlow<List<TimelineRow>>(emptyList())
    /** Oldest first. */
    val rows: StateFlow<List<TimelineRow>> = _rows.asStateFlow()
    private val _header = MutableStateFlow<RoomHeader?>(null)
    val header: StateFlow<RoomHeader?> = _header.asStateFlow()
    private val _typing = MutableStateFlow<List<String>>(emptyList())
    val typing: StateFlow<List<String>> = _typing.asStateFlow()
    private val _warnings = MutableStateFlow<List<IdentityWarning>>(emptyList())
    val warnings: StateFlow<List<IdentityWarning>> = _warnings.asStateFlow()
    private val _atStart = MutableStateFlow(false)
    val atStart: StateFlow<Boolean> = _atStart.asStateFlow()
    private val _paginating = MutableStateFlow(false)
    val paginating: StateFlow<Boolean> = _paginating.asStateFlow()
    private val _error = MutableStateFlow<Throwable?>(null)
    val error: StateFlow<Throwable?> = _error.asStateFlow()

    private var lastTypingSent = 0L

    fun start() {
        scope.launch {
            try {
                val r = session.client.getRoom(roomId) ?: session.roomListService().room(roomId)
                room = r
                updateHeader(r.roomInfo())
                handles += r.subscribeToRoomInfoUpdates(object : RoomInfoListener {
                    override fun call(roomInfo: RoomInfo) = updateHeader(roomInfo)
                })
                if (r.membership() != Membership.JOINED) return@launch
                val t = r.timeline()
                timeline = t
                handles += t.addListener(object : TimelineListener {
                    override fun onUpdate(diff: List<TimelineDiff>) = onDiff(diff)
                })
                handles += t.subscribeToBackPaginationStatus(object : PaginationStatusListener {
                    override fun onUpdate(status: PaginationStatus) {
                        _paginating.value = status is PaginationStatus.Paginating
                        if (status is PaginationStatus.Idle) _atStart.value = status.hitTimelineStart
                    }
                })
                handles += r.subscribeToTypingNotifications(object : TypingNotificationsListener {
                    override fun call(typingUserIds: List<String>) {
                        scope.launch {
                            _typing.value = typingUserIds.filter { it != session.userId }.map { id ->
                                try { r.memberDisplayName(id) ?: id } catch (_: Exception) { id }
                            }
                        }
                    }
                })
                handles += r.subscribeToIdentityStatusChanges(object : IdentityStatusChangeListener {
                    override fun call(identityStatusChange: List<IdentityStatusChange>) = onIdentityChanges(identityStatusChange)
                })
                if (rows.value.size < 20) paginateBack()
            } catch (e: Exception) {
                LumenLog.w("room", "open failed", e)
                _error.value = e
            }
        }
    }

    private fun updateHeader(info: RoomInfo) {
        _header.value = RoomHeader(
            name = info.displayName?.takeIf { it.isNotBlank() } ?: strings.unnamedRoom,
            isDirect = info.isDirect,
            encrypted = info.encryptionState == EncryptionState.ENCRYPTED,
            membership = info.membership,
            inviterName = info.inviter?.let { it.displayName ?: it.userId },
            hasCall = info.hasRoomCall,
            memberCount = info.joinedMembersCount.toLong(),
        )
    }

    private fun onDiff(diffs: List<TimelineDiff>) {
        synchronized(items) {
            for (d in diffs) {
                when (d) {
                    is TimelineDiff.Append -> items.addAll(d.values)
                    TimelineDiff.Clear -> items.clear()
                    is TimelineDiff.PushFront -> items.add(0, d.value)
                    is TimelineDiff.PushBack -> items.add(d.value)
                    TimelineDiff.PopFront -> if (items.isNotEmpty()) items.removeAt(0)
                    TimelineDiff.PopBack -> if (items.isNotEmpty()) items.removeAt(items.lastIndex)
                    is TimelineDiff.Insert -> items.add(d.index.toInt().coerceIn(0, items.size), d.value)
                    is TimelineDiff.Set -> if (d.index.toInt() in items.indices) items[d.index.toInt()] = d.value
                    is TimelineDiff.Remove -> if (d.index.toInt() in items.indices) items.removeAt(d.index.toInt())
                    is TimelineDiff.Truncate -> while (items.size > d.length.toInt()) items.removeAt(items.lastIndex)
                    is TimelineDiff.Reset -> {
                        items.clear()
                        items.addAll(d.values)
                    }
                }
            }
            _rows.value = items.mapNotNull { TimelineMapper.map(it, session.userId, strings) }
        }
    }

    private fun onIdentityChanges(changes: List<IdentityStatusChange>) {
        scope.launch {
            val current = _warnings.value.associateBy { it.userId }.toMutableMap()
            for (c in changes) {
                when (c.changedTo) {
                    IdentityState.PIN_VIOLATION, IdentityState.VERIFICATION_VIOLATION -> {
                        val name = try { room?.memberDisplayName(c.userId) } catch (_: Exception) { null }
                        current[c.userId] = IdentityWarning(c.userId, name, c.changedTo)
                    }
                    else -> current.remove(c.userId)
                }
            }
            _warnings.value = current.values.sortedBy { it.userId }
        }
    }

    /** "I understand" for a changed identity: pin the new identity (or withdraw a verification). */
    fun acknowledgeIdentity(w: IdentityWarning) = launchCatching {
        val identity = session.client.encryption().userIdentity(w.userId, false) ?: return@launchCatching
        if (w.state == IdentityState.VERIFICATION_VIOLATION) identity.withdrawVerification() else identity.pin()
    }

    fun paginateBack() = launchCatching {
        val t = timeline ?: return@launchCatching
        if (_atStart.value) return@launchCatching
        _atStart.value = t.paginateBackwards(PAGE.toUShort())
    }

    fun sendText(text: String, replyTo: TimelineRow.Event?, editing: TimelineRow.Event?) = launchCatching {
        val t = timeline ?: return@launchCatching
        val content = messageEventContentFromMarkdown(text)
        when {
            editing != null -> t.edit(editing.id, EditedContent.RoomMessage(content))
            replyTo?.eventId != null -> t.sendReply(content, replyTo.eventId)
            else -> t.send(content)
        }
        setTyping(false, force = true)
    }

    fun toggleReaction(row: TimelineRow.Event, key: String) = launchCatching {
        timeline?.toggleReaction(row.id, key)
    }

    fun redact(row: TimelineRow.Event) = launchCatching {
        timeline?.redactEvent(row.id, null)
    }

    /** Sends an encrypted attachment (the SDK encrypts it; the temporary file is deleted after). */
    fun sendAttachment(file: File, filename: String, mimeType: String, size: Long, imageSize: Pair<Int, Int>?, replyTo: TimelineRow.Event?) =
        launchCatching {
            val t = timeline ?: return@launchCatching
            try {
                val params = UploadParameters(
                    source = UploadSource.File(file.absolutePath),
                    caption = null,
                    formattedCaption = null,
                    mentions = null,
                    inReplyTo = replyTo?.eventId,
                )
                val handle = if (imageSize != null) {
                    t.sendImage(
                        params, null,
                        ImageInfo(
                            height = imageSize.second.toULong(), width = imageSize.first.toULong(), mimetype = mimeType,
                            size = size.toULong(), thumbnailInfo = null, thumbnailSource = null, blurhash = null, isAnimated = null,
                        ),
                    )
                } else {
                    t.sendFile(params, FileInfo(mimetype = mimeType, size = size.toULong(), thumbnailInfo = null, thumbnailSource = null))
                }
                handle.join()
            } finally {
                withContext(Dispatchers.IO) { file.delete() }
            }
            Unit
        }

    fun retry(row: TimelineRow.Event) = launchCatching {
        items.firstOrNull { it.uniqueId().id == row.key }?.asEvent()?.lazyProvider?.getSendHandle()?.tryResend()
    }

    fun cancelSend(row: TimelineRow.Event) = launchCatching {
        items.firstOrNull { it.uniqueId().id == row.key }?.asEvent()?.lazyProvider?.getSendHandle()?.abort(null)
    }

    /** Read receipts per the privacy setting (integration.md §5). */
    fun markRead(mode: ReceiptMode) = launchCatching {
        val t = timeline ?: return@launchCatching
        t.markAsRead(
            when (mode) {
                ReceiptMode.PUBLIC -> ReceiptType.READ
                ReceiptMode.PRIVATE -> ReceiptType.READ_PRIVATE
                ReceiptMode.OFF -> ReceiptType.FULLY_READ
            },
        )
    }

    /** Typing notices, throttled; never sent when the setting is off. */
    fun setTyping(typing: Boolean, enabled: Boolean = true, force: Boolean = false) {
        if (!enabled && !force) return
        val now = System.currentTimeMillis()
        if (typing && now - lastTypingSent < TYPING_THROTTLE_MS) return
        lastTypingSent = if (typing) now else 0
        launchCatching { room?.typingNotice(typing) }
    }

    fun join() = launchCatching {
        room?.join()
        stopInternal()
        start()
    }

    fun leave(onDone: () -> Unit) = launchCatching {
        room?.leave()
        withContext(Dispatchers.Main) { onDone() }
    }

    fun search(query: String): List<TimelineRow.Event> =
        LocalSearch.search(rows.value.filterIsInstance<TimelineRow.Event>().asReversed(), query) { it.content.searchableText }.map { it.item }

    fun clearError() {
        _error.value = null
    }

    private fun launchCatching(block: suspend () -> Unit) = scope.launch {
        try {
            block()
        } catch (e: Exception) {
            LumenLog.w("room", "action failed", e)
            _error.value = e
        }
    }

    private fun stopInternal() {
        handles.forEach { it.cancel() }
        handles.clear()
    }

    fun stop() {
        // The final "stopped typing" outlives this controller's scope.
        val r = room
        if (lastTypingSent != 0L && r != null) session.scope.launch { runCatching { r.typingNotice(false) } }
        stopInternal()
        scope.cancel()
    }

    private companion object {
        const val PAGE = 30
        const val TYPING_THROTTLE_MS = 4_000L
    }
}
