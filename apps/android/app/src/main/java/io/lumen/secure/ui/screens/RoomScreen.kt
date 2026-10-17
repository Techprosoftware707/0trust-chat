package io.lumen.secure.ui.screens

import android.content.ClipData
import android.content.ClipboardManager
import android.os.Build
import android.text.format.DateFormat
import android.text.format.DateUtils
import android.view.HapticFeedbackConstants
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SmallFloatingActionButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withLink
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import io.lumen.secure.AppGraph
import io.lumen.secure.R
import io.lumen.secure.calls.CallActivity
import io.lumen.secure.core.messaging.DeliveryState
import io.lumen.secure.matrix.FileKind
import io.lumen.secure.matrix.IdentityWarning
import io.lumen.secure.matrix.MatrixSession
import io.lumen.secure.matrix.RoomController
import io.lumen.secure.matrix.RoomHeader
import io.lumen.secure.matrix.RowContent
import io.lumen.secure.matrix.ShieldUi
import io.lumen.secure.matrix.TimelineRow
import io.lumen.secure.ui.Attachments
import io.lumen.secure.ui.LocalMediaHost
import io.lumen.secure.ui.SessionMediaHost
import io.lumen.secure.ui.components.Avatar
import io.lumen.secure.ui.components.Banner
import io.lumen.secure.ui.components.BannerKind
import io.lumen.secure.ui.components.CenteredState
import io.lumen.secure.ui.components.Illustration
import io.lumen.secure.ui.components.PrimaryButton
import io.lumen.secure.ui.components.SearchField
import io.lumen.secure.ui.components.TimelineSkeleton
import io.lumen.secure.ui.nav.NavViewModel
import io.lumen.secure.ui.nav.Screen
import io.lumen.secure.ui.theme.LumenBrand
import io.lumen.secure.ui.theme.LumenEase
import io.lumen.secure.ui.theme.brandWash
import io.lumen.secure.ui.theme.isDark
import io.lumen.secure.ui.theme.lumenColors
import java.util.Date
import kotlin.math.abs
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.matrix.rustcomponents.sdk.Membership
import uniffi.matrix_sdk_crypto.IdentityState

private val QUICK_REACTIONS = listOf("👍", "❤️", "😂", "😮", "😢", "🎉")

/** What the room screen shows (plain data; [RoomScreen] collects it from the SDK). */
data class RoomData(
    val header: RoomHeader?,
    val rows: List<TimelineRow>,
    val typing: List<String> = emptyList(),
    val warnings: List<IdentityWarning> = emptyList(),
    val atStart: Boolean = false,
    val paginating: Boolean = false,
    val error: Boolean = false,
    val callsAvailable: Boolean = false,
)

class RoomActions(
    val onBack: () -> Unit = {},
    val onInfo: () -> Unit = {},
    val onCall: (video: Boolean) -> Unit = {},
    val onAcknowledge: (IdentityWarning) -> Unit = {},
    val onClearError: () -> Unit = {},
    val onJoin: () -> Unit = {},
    val onDecline: () -> Unit = {},
    val onBlockInviter: () -> Unit = {},
    val onReact: (TimelineRow.Event, String) -> Unit = { _, _ -> },
    val onRetry: (TimelineRow.Event) -> Unit = {},
    val onCancelSend: (TimelineRow.Event) -> Unit = {},
    val onRedact: (TimelineRow.Event) -> Unit = {},
    val onSend: (text: String, replyTo: TimelineRow.Event?, editing: TimelineRow.Event?) -> Unit = { _, _, _ -> },
    val onTyping: (Boolean) -> Unit = {},
    /** Copies and sends a picked file; false when it could not be read. */
    val onAttach: suspend (android.net.Uri, TimelineRow.Event?) -> Boolean = { _, _ -> true },
    val onPaginateBack: () -> Unit = {},
    val onMarkRead: () -> Unit = {},
    val onSearch: (String) -> List<TimelineRow.Event> = { emptyList() },
)

/** UI-only state of the room screen: search, the message the composer refers to, open dialogs. */
@Stable
class RoomUiState(
    /** Drafts and search survive configuration changes per room. */
    val roomKey: String = "",
    searching: Boolean = false,
    searchQuery: String = "",
    replyTo: TimelineRow.Event? = null,
    editing: TimelineRow.Event? = null,
    menuFor: TimelineRow.Event? = null,
    deleteFor: TimelineRow.Event? = null,
    composerText: String = "",
) {
    var searching by mutableStateOf(searching)
    var searchQuery by mutableStateOf(searchQuery)
    var replyTo by mutableStateOf(replyTo)
    var editing by mutableStateOf(editing)
    var menuFor by mutableStateOf(menuFor)
    var deleteFor by mutableStateOf(deleteFor)
    var composerText by mutableStateOf(composerText)

    companion object {
        val Saver: Saver<RoomUiState, Any> = listSaver(
            save = { listOf(it.roomKey, it.searching, it.searchQuery) },
            restore = { RoomUiState(roomKey = it[0] as String, searching = it[1] as Boolean, searchQuery = it[2] as String) },
        )
    }
}

@Composable
fun RoomScreen(graph: AppGraph, session: MatrixSession, nav: NavViewModel, roomId: String, showBack: Boolean) {
    val controller = remember(roomId) { RoomController(session, roomId, graph.timelineStrings) }
    DisposableEffect(controller) {
        controller.start()
        graph.notifier.visibleRoomId = roomId
        graph.notifier.clearRoom(roomId)
        onDispose {
            if (graph.notifier.visibleRoomId == roomId) graph.notifier.visibleRoomId = null
            controller.stop()
        }
    }
    val rows by controller.rows.collectAsState()
    val header by controller.header.collectAsState()
    val typing by controller.typing.collectAsState()
    val warnings by controller.warnings.collectAsState()
    val atStart by controller.atStart.collectAsState()
    val paginating by controller.paginating.collectAsState()
    val error by controller.error.collectAsState()
    val settings by graph.settings.state.collectAsState()
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val ui = rememberSaveable(roomId, saver = RoomUiState.Saver) { RoomUiState(roomKey = roomId) }
    // Calls: the widget must be bundled and the server must advertise an RTC transport (raw check).
    var serverCalls by remember { mutableStateOf<Boolean?>(null) }
    LaunchedEffect(session) { serverCalls = graph.callSupport.available(session) }
    val mediaHost = remember(session) { SessionMediaHost(session) }

    CompositionLocalProvider(LocalMediaHost provides mediaHost) {
        RoomContent(
            data = RoomData(
                header = header, rows = rows, typing = typing, warnings = warnings, atStart = atStart, paginating = paginating,
                error = error != null, callsAvailable = graph.calls.widgetBundled && serverCalls != false,
            ),
            ui = ui,
            showBack = showBack,
            actions = RoomActions(
                onBack = { nav.pop() },
                onInfo = { nav.push(Screen.RoomInfo(roomId)) },
                onCall = { video -> context.startActivity(CallActivity.startIntent(context, roomId, video = video)) },
                onAcknowledge = controller::acknowledgeIdentity,
                onClearError = controller::clearError,
                onJoin = { controller.join() },
                onDecline = { controller.leave { nav.pop() } },
                onBlockInviter = {
                    scope.launch {
                        try {
                            session.client.getRoom(roomId)?.inviter()?.userId?.let { session.client.ignoreUser(it) }
                        } catch (_: Exception) {
                        }
                        controller.leave { nav.pop() }
                    }
                },
                onReact = { row, key -> controller.toggleReaction(row, key) },
                onRetry = { controller.retry(it) },
                onCancelSend = { controller.cancelSend(it) },
                onRedact = { controller.redact(it) },
                onSend = { text, replyTo, editing -> controller.sendText(text, replyTo, editing) },
                onTyping = { controller.setTyping(it, enabled = settings.typing) },
                onAttach = { uri, replyTo ->
                    val picked = Attachments.copy(context, uri)
                    if (picked != null) controller.sendAttachment(picked.file, picked.name, picked.mimeType, picked.size, picked.imageSize, replyTo)
                    picked != null
                },
                onPaginateBack = { controller.paginateBack() },
                onMarkRead = {
                    controller.markRead(settings.receipts)
                    graph.notifier.clearRoom(roomId)
                },
                onSearch = { controller.search(it) },
            ),
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RoomContent(data: RoomData, ui: RoomUiState, showBack: Boolean, actions: RoomActions) {
    val rows = data.rows
    val header = data.header
    val typing = data.typing
    val warnings = data.warnings
    val c = MaterialTheme.lumenColors
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val listState = rememberLazyListState()
    val newestFirst = remember(rows) { rows.asReversed() }
    val groups = remember(rows) { bubbleGroups(rows) }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val mediaHost = LocalMediaHost.current

    // Read receipts per the privacy setting, only while the newest message is on screen and the app is visible.
    val atBottom by remember { derivedStateOf { listState.firstVisibleItemIndex <= 1 } }
    LaunchedEffect(rows.size, atBottom) {
        if (atBottom && rows.isNotEmpty()) {
            lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
                delay(800)
                actions.onMarkRead()
                return@repeatOnLifecycle
            }
        }
    }
    // Back-paginate when the oldest loaded message comes into view.
    val nearTop by remember { derivedStateOf { listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index?.let { it >= listState.layoutInfo.totalItemsCount - 5 } ?: false } }
    LaunchedEffect(nearTop, data.atStart, data.paginating) { if (nearTop && !data.atStart && !data.paginating) actions.onPaginateBack() }
    val showJump by remember { derivedStateOf { listState.firstVisibleItemIndex > 3 } }
    BackHandler(enabled = ui.searching) { ui.searching = false }

    Scaffold(
        containerColor = c.bg,
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
        topBar = { RoomTopBar(header, showBack, data.callsAvailable, ui, actions) },
    ) { padding ->
        Column(
            Modifier.fillMaxSize().padding(padding).consumeWindowInsets(padding)
                .windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Horizontal)),
        ) {
            Column(Modifier.animateContentSize(LumenEase.med())) {
                warnings.forEach { w -> IdentityBanner(w) { actions.onAcknowledge(w) } }
                if (data.error) {
                    Banner(
                        stringResource(R.string.room_action_failed), BannerKind.DANGER, R.drawable.ic_lucide_circle_alert,
                        actionLabel = stringResource(R.string.action_dismiss), onAction = actions.onClearError,
                    )
                }
            }
            val h = header
            when {
                h == null -> Box(Modifier.weight(1f)) { TimelineSkeleton(stringResource(R.string.room_loading)) }
                h.membership == Membership.INVITED -> Box(Modifier.weight(1f)) {
                    InvitePanel(h.inviterName, onAccept = actions.onJoin, onDecline = actions.onDecline, onBlock = actions.onBlockInviter)
                }
                h.membership != Membership.JOINED -> Box(Modifier.weight(1f)) { CenteredState(stringResource(R.string.room_not_member), icon = R.drawable.ic_lucide_ban) }
                ui.searching -> Column(Modifier.weight(1f).windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Bottom))) {
                    SearchField(
                        ui.searchQuery, { ui.searchQuery = it }, stringResource(R.string.room_search_placeholder),
                        Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
                    )
                    Text(
                        stringResource(R.string.room_search_scope), style = MaterialTheme.typography.bodySmall, color = c.textMuted,
                        modifier = Modifier.padding(horizontal = 20.dp, vertical = 4.dp),
                    )
                    val results = remember(ui.searchQuery, rows) { if (ui.searchQuery.isBlank()) emptyList() else actions.onSearch(ui.searchQuery) }
                    if (ui.searchQuery.isNotBlank() && results.isEmpty()) {
                        Box(Modifier.weight(1f)) { CenteredState(stringResource(R.string.room_search_none), icon = R.drawable.ic_lucide_search) }
                    }
                    LazyColumn(Modifier.weight(1f), contentPadding = PaddingValues(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        items(results, key = { "s" + it.key }) { r ->
                            Surface(
                                shape = MaterialTheme.shapes.medium, color = c.surface,
                                border = if (MaterialTheme.isDark) null else BorderStroke(1.dp, c.border),
                                modifier = Modifier.fillMaxWidth(),
                            ) {
                                Column(
                                    Modifier.clickable {
                                        ui.searching = false
                                        val idx = newestFirst.indexOfFirst { it.key == r.key }
                                        if (idx >= 0) scope.launch { listState.scrollToItem(idx) }
                                    }.padding(horizontal = 16.dp, vertical = 12.dp),
                                ) {
                                    Row(verticalAlignment = Alignment.CenterVertically) {
                                        Text(r.senderName, style = MaterialTheme.typography.labelLarge, color = c.accent, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                                        Text(
                                            DateUtils.formatDateTime(context, r.timestamp, DateUtils.FORMAT_SHOW_DATE or DateUtils.FORMAT_SHOW_TIME or DateUtils.FORMAT_ABBREV_MONTH),
                                            style = MaterialTheme.typography.labelMedium, color = c.textSubtle,
                                        )
                                    }
                                    Spacer(Modifier.height(2.dp))
                                    Text(r.content.searchableText ?: "", style = MaterialTheme.typography.bodyMedium, color = c.text, maxLines = 3, overflow = TextOverflow.Ellipsis)
                                }
                            }
                        }
                    }
                }
                else -> Column(Modifier.weight(1f).brandWash(if (MaterialTheme.isDark) 0.5f else 0.8f)) {
                    Box(Modifier.weight(1f)) {
                        if (rows.isEmpty()) {
                            CenteredState(
                                stringResource(R.string.room_empty),
                                stringResource(if (h.encrypted) R.string.room_empty_body_encrypted else R.string.room_empty_body_plain),
                                icon = R.drawable.ic_lucide_message_circle,
                            )
                        }
                        LazyColumn(
                            Modifier.fillMaxSize().testTag("timeline"),
                            state = listState,
                            reverseLayout = true,
                            contentPadding = PaddingValues(top = 8.dp, bottom = 12.dp),
                        ) {
                            items(newestFirst, key = { it.key }) { row ->
                                when (row) {
                                    is TimelineRow.Event -> {
                                        val g = groups[row.key] ?: Grouping(first = true, last = true)
                                        MessageRow(
                                            row, isDirect = h.isDirect, first = g.first, last = g.last,
                                            onLongPress = { ui.menuFor = row },
                                            onReact = { key -> actions.onReact(row, key) },
                                            onRetry = { actions.onRetry(row) },
                                        )
                                    }
                                    is TimelineRow.DateDivider -> DateDivider(row.millis)
                                    is TimelineRow.ReadMarker -> ReadMarker()
                                    is TimelineRow.Start -> Text(
                                        stringResource(R.string.room_start), style = MaterialTheme.typography.labelMedium, color = c.textSubtle,
                                        modifier = Modifier.fillMaxWidth().padding(16.dp), textAlign = TextAlign.Center,
                                    )
                                }
                            }
                            if (data.paginating) {
                                item {
                                    Box(Modifier.fillMaxWidth().padding(8.dp), contentAlignment = Alignment.Center) {
                                        CircularProgressIndicator(Modifier.size(20.dp), color = c.accent, strokeWidth = 2.dp)
                                    }
                                }
                            }
                        }
                        androidx.compose.animation.AnimatedVisibility(
                            visible = showJump,
                            enter = fadeIn(LumenEase.fast()) + scaleIn(LumenEase.fast(), initialScale = 0.8f),
                            exit = fadeOut(LumenEase.fast()) + scaleOut(LumenEase.fast(), targetScale = 0.8f),
                            modifier = Modifier.align(Alignment.BottomEnd).padding(16.dp),
                        ) {
                            SmallFloatingActionButton(
                                onClick = { scope.launch { listState.animateScrollToItem(0) } },
                                containerColor = c.surface, contentColor = c.accent, shape = CircleShape,
                            ) { Icon(painterResource(R.drawable.ic_lucide_chevron_down), stringResource(R.string.room_jump_latest)) }
                        }
                    }
                    AnimatedVisibility(
                        visible = typing.isNotEmpty(),
                        enter = fadeIn(LumenEase.fast()) + expandVertically(LumenEase.fast()),
                        exit = fadeOut(LumenEase.fast()) + shrinkVertically(LumenEase.fast()),
                    ) {
                        TypingIndicator(
                            if (typing.size == 1) {
                                stringResource(R.string.room_typing_one, typing.firstOrNull() ?: "")
                            } else {
                                pluralStringResource(R.plurals.room_typing_many, typing.size, typing.size)
                            },
                        )
                    }
                    Composer(ui = ui, actions = actions)
                }
            }
        }
    }

    ui.menuFor?.let { row ->
        MessageActions(
            row = row,
            onDismiss = { ui.menuFor = null },
            onReply = { ui.replyTo = row; ui.editing = null },
            onEdit = { ui.editing = row; ui.replyTo = null },
            onReact = { actions.onReact(row, it) },
            onCopy = {
                val text = row.content.searchableText ?: return@MessageActions
                context.getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("message", text))
            },
            onDelete = { ui.deleteFor = row },
            onRetry = { actions.onRetry(row) },
            onCancelSend = { actions.onCancelSend(row) },
            onOpenFile = {
                scope.launch {
                    when (val ct = row.content) {
                        is RowContent.File -> mediaHost.open(context, ct.source, ct.filename, ct.mimeType)
                        is RowContent.Image -> mediaHost.open(context, ct.source, ct.filename, ct.mimeType)
                        else -> Unit
                    }
                }
            },
        )
    }
    ui.deleteFor?.let { row ->
        AlertDialog(
            onDismissRequest = { ui.deleteFor = null },
            icon = { Icon(painterResource(R.drawable.ic_lucide_trash_2), null, tint = c.danger) },
            title = { Text(stringResource(R.string.message_delete_title)) },
            text = { Text(stringResource(R.string.message_delete_body)) },
            confirmButton = { TextButton(onClick = { actions.onRedact(row); ui.deleteFor = null }) { Text(stringResource(R.string.action_delete), color = c.danger) } },
            dismissButton = { TextButton(onClick = { ui.deleteFor = null }) { Text(stringResource(R.string.action_cancel)) } },
        )
    }
}

/**
 * The room bar: who you are talking to and the chat's real encryption state on one line each.
 * Compact windows keep the voice call and move the rest into the overflow menu.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun RoomTopBar(header: RoomHeader?, showBack: Boolean, callsAvailable: Boolean, ui: RoomUiState, actions: RoomActions) {
    val c = MaterialTheme.lumenColors
    var menu by remember { mutableStateOf(false) }
    BoxWithConstraints {
        val wide = maxWidth >= 600.dp
        val roomy = maxWidth >= 380.dp
        val h = header
        val canCall = h != null && h.membership == Membership.JOINED && callsAvailable
        TopAppBar(
            navigationIcon = {
                if (showBack) IconButton(onClick = actions.onBack) { Icon(painterResource(R.drawable.ic_lucide_arrow_left), stringResource(R.string.action_back)) }
            },
            title = {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier.clip(MaterialTheme.shapes.small).clickable(onClick = actions.onInfo).padding(vertical = 4.dp, horizontal = 4.dp),
                ) {
                    // Small phones give the name and the encryption state the room instead of the avatar.
                    if (roomy) {
                        Avatar(h?.name ?: "?", size = 38.dp)
                        Spacer(Modifier.width(10.dp))
                    }
                    Column {
                        Text(h?.name ?: "", maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.titleMedium)
                        if (h != null) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Icon(
                                    painterResource(if (h.encrypted) R.drawable.ic_lucide_lock else R.drawable.ic_lucide_shield_alert), null,
                                    tint = if (h.encrypted) c.success else c.warning, modifier = Modifier.size(12.dp),
                                )
                                Spacer(Modifier.width(4.dp))
                                Text(
                                    stringResource(if (h.encrypted) R.string.room_encrypted else R.string.room_not_encrypted),
                                    style = MaterialTheme.typography.labelMedium, color = if (h.encrypted) c.success else c.warning,
                                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                                )
                            }
                        }
                    }
                }
            },
            actions = {
                if (canCall) {
                    IconButton(onClick = { actions.onCall(false) }) {
                        Icon(painterResource(R.drawable.ic_lucide_phone), stringResource(if (h?.hasCall == true) R.string.call_join_voice else R.string.call_start_voice))
                    }
                    if (wide) {
                        IconButton(onClick = { actions.onCall(true) }) {
                            Icon(painterResource(R.drawable.ic_lucide_video), stringResource(if (h?.hasCall == true) R.string.call_join_video else R.string.call_start_video))
                        }
                    }
                }
                if (wide) {
                    IconButton(onClick = {
                        ui.searching = !ui.searching
                        ui.searchQuery = ""
                    }) { Icon(painterResource(R.drawable.ic_lucide_search), stringResource(R.string.room_search)) }
                }
                Box {
                    IconButton(onClick = { menu = true }) { Icon(painterResource(R.drawable.ic_lucide_more_horizontal), stringResource(R.string.room_more)) }
                    DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                        if (canCall && !wide) {
                            DropdownMenuItem(
                                text = { Text(stringResource(if (h?.hasCall == true) R.string.call_join_video else R.string.call_start_video)) },
                                leadingIcon = { Icon(painterResource(R.drawable.ic_lucide_video), null) },
                                onClick = { menu = false; actions.onCall(true) },
                            )
                        }
                        if (!wide) {
                            DropdownMenuItem(
                                text = { Text(stringResource(R.string.room_search)) },
                                leadingIcon = { Icon(painterResource(R.drawable.ic_lucide_search), null) },
                                onClick = {
                                    menu = false
                                    ui.searching = true
                                    ui.searchQuery = ""
                                },
                            )
                        }
                        DropdownMenuItem(
                            text = { Text(stringResource(R.string.room_info_title)) },
                            leadingIcon = { Icon(painterResource(R.drawable.ic_lucide_info), null) },
                            onClick = { menu = false; actions.onInfo() },
                        )
                    }
                }
            },
            colors = TopAppBarDefaults.topAppBarColors(containerColor = c.bgElevated),
        )
    }
}

@Composable
private fun IdentityBanner(w: IdentityWarning, onAcknowledge: () -> Unit) {
    val who = w.displayName ?: w.userId
    if (w.state == IdentityState.VERIFICATION_VIOLATION) {
        Banner(
            stringResource(R.string.identity_violation_verified, who), BannerKind.DANGER, R.drawable.ic_lucide_shield_alert,
            actionLabel = stringResource(R.string.identity_withdraw), onAction = onAcknowledge,
        )
    } else {
        Banner(
            stringResource(R.string.identity_changed, who), BannerKind.WARNING, R.drawable.ic_lucide_shield_alert,
            actionLabel = stringResource(R.string.identity_acknowledge), onAction = onAcknowledge,
        )
    }
}

@Composable
private fun InvitePanel(inviter: String?, onAccept: () -> Unit, onDecline: () -> Unit, onBlock: () -> Unit) {
    val c = MaterialTheme.lumenColors
    BoxWithConstraints(Modifier.fillMaxSize()) {
        Column(
            Modifier.verticalScroll(rememberScrollState()).heightIn(min = maxHeight).fillMaxWidth().padding(32.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            Illustration(R.drawable.ic_lucide_user_plus)
            Spacer(Modifier.height(16.dp))
            Text(stringResource(R.string.rooms_invited_by, inviter ?: "?"), style = MaterialTheme.typography.titleLarge, color = c.text, textAlign = TextAlign.Center)
            Spacer(Modifier.height(8.dp))
            Text(stringResource(R.string.room_invite_body), style = MaterialTheme.typography.bodyMedium, color = c.textMuted, textAlign = TextAlign.Center)
            Spacer(Modifier.height(24.dp))
            Column(Modifier.widthIn(max = 320.dp).fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                PrimaryButton(stringResource(R.string.invite_accept), onAccept, Modifier.fillMaxWidth())
                OutlinedButton(onClick = onDecline, shape = MaterialTheme.shapes.medium, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
                    Text(stringResource(R.string.invite_decline))
                }
                TextButton(onClick = onBlock, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.invite_block), color = c.danger) }
            }
        }
    }
}

@Composable
private fun DateDivider(millis: Long) {
    val c = MaterialTheme.lumenColors
    val context = LocalContext.current
    val label = when {
        DateUtils.isToday(millis) -> stringResource(R.string.timeline_today)
        DateUtils.isToday(millis + DateUtils.DAY_IN_MILLIS) -> stringResource(R.string.timeline_yesterday)
        else -> DateUtils.formatDateTime(context, millis, DateUtils.FORMAT_SHOW_DATE or DateUtils.FORMAT_SHOW_WEEKDAY or DateUtils.FORMAT_ABBREV_MONTH)
    }
    Box(Modifier.fillMaxWidth().padding(vertical = 12.dp), contentAlignment = Alignment.Center) {
        Text(
            label, style = MaterialTheme.typography.labelMedium, color = c.textMuted,
            modifier = Modifier.clip(CircleShape).background(c.surface2).padding(horizontal = 12.dp, vertical = 4.dp),
        )
    }
}

@Composable
private fun ReadMarker() {
    val c = MaterialTheme.lumenColors
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        HorizontalDivider(Modifier.weight(1f), color = c.accent.copy(alpha = 0.4f))
        Text(
            stringResource(R.string.room_new_messages), style = MaterialTheme.typography.labelMedium, color = c.accent,
            modifier = Modifier.padding(horizontal = 10.dp),
        )
        HorizontalDivider(Modifier.weight(1f), color = c.accent.copy(alpha = 0.4f))
    }
}

@Composable
private fun TypingIndicator(label: String) {
    val c = MaterialTheme.lumenColors
    Row(Modifier.fillMaxWidth().padding(horizontal = 18.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        val pulse = rememberInfiniteTransition(label = "typing")
        repeat(3) { i ->
            val a by pulse.animateFloat(
                initialValue = 0.3f, targetValue = 1f,
                animationSpec = infiniteRepeatable(tween(600, delayMillis = i * 150), RepeatMode.Reverse),
                label = "dot$i",
            )
            Box(Modifier.padding(end = 3.dp).size(6.dp).graphicsLayer { alpha = a }.clip(CircleShape).background(c.accent))
        }
        Spacer(Modifier.width(8.dp))
        Text(label, style = MaterialTheme.typography.labelMedium, color = c.textMuted, fontStyle = FontStyle.Italic, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/** Whether a message continues the bubble run before it and after it (same sender, within 5 minutes). */
private data class Grouping(val first: Boolean, val last: Boolean)

private const val GROUP_GAP_MILLIS = 5 * 60_000L

private fun TimelineRow.Event.isBubble() = content !is RowContent.StateText && content !is RowContent.Call

private fun bubbleGroups(rows: List<TimelineRow>): Map<String, Grouping> {
    fun joins(a: TimelineRow?, b: TimelineRow?) = a is TimelineRow.Event && b is TimelineRow.Event && a.isBubble() && b.isBubble() &&
        a.senderId == b.senderId && abs(b.timestamp - a.timestamp) < GROUP_GAP_MILLIS
    val out = HashMap<String, Grouping>(rows.size)
    rows.forEachIndexed { i, r ->
        if (r is TimelineRow.Event) out[r.key] = Grouping(first = !joins(rows.getOrNull(i - 1), r), last = !joins(r, rows.getOrNull(i + 1)))
    }
    return out
}

private val URL_PATTERN = Regex("""https?://[^\s<>"]+""")

/** Message text with web links made tappable (opened in the browser). */
@Composable
private fun linkified(body: String): AnnotatedString {
    val color = MaterialTheme.lumenColors.accent
    return remember(body, color) {
        buildAnnotatedString {
            var last = 0
            URL_PATTERN.findAll(body).forEach { m ->
                val url = m.value.trimEnd('.', ',', ';', ':', '!', '?', ')', ']', '\'', '"')
                append(body.substring(last, m.range.first))
                withLink(LinkAnnotation.Url(url, TextLinkStyles(SpanStyle(color = color, textDecoration = TextDecoration.Underline)))) { append(url) }
                last = m.range.first + url.length
            }
            append(body.substring(last))
        }
    }
}

@OptIn(ExperimentalFoundationApi::class, ExperimentalLayoutApi::class)
@Composable
private fun MessageRow(
    row: TimelineRow.Event,
    isDirect: Boolean,
    first: Boolean,
    last: Boolean,
    onLongPress: () -> Unit,
    onReact: (String) -> Unit,
    onRetry: () -> Unit,
) {
    val c = MaterialTheme.lumenColors
    val context = LocalContext.current
    val content = row.content
    when (content) {
        is RowContent.StateText -> {
            Text(
                content.text, style = MaterialTheme.typography.labelMedium, color = c.textSubtle,
                modifier = Modifier.fillMaxWidth().padding(horizontal = 32.dp, vertical = 4.dp), textAlign = TextAlign.Center,
            )
            return
        }
        is RowContent.Call -> {
            Box(Modifier.fillMaxWidth().padding(vertical = 6.dp), contentAlignment = Alignment.Center) {
                Row(
                    Modifier.clip(CircleShape).background(if (content.active) c.successSoft else c.surface2).padding(horizontal = 12.dp, vertical = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(painterResource(R.drawable.ic_lucide_phone), null, tint = if (content.active) c.success else c.textMuted, modifier = Modifier.size(14.dp))
                    Spacer(Modifier.width(6.dp))
                    val time = DateFormat.getTimeFormat(context).format(Date(row.timestamp))
                    Text(
                        stringResource(if (content.active) R.string.timeline_call_active else R.string.timeline_call_ended) + " · " + time,
                        style = MaterialTheme.typography.labelMedium, color = if (content.active) c.success else c.textMuted,
                    )
                }
            }
            return
        }
        else -> Unit
    }
    val time = DateFormat.getTimeFormat(context).format(Date(row.timestamp))
    val deliveryLabel = when (row.delivery) {
        DeliveryState.SENDING -> stringResource(R.string.delivery_sending)
        DeliveryState.SENT -> stringResource(R.string.delivery_sent)
        DeliveryState.READ -> stringResource(R.string.delivery_read)
        DeliveryState.FAILED -> stringResource(R.string.delivery_failed)
        DeliveryState.NONE -> null
    }
    val failed = row.delivery == DeliveryState.FAILED
    val big = 18.dp
    val small = 6.dp
    val shape = if (row.isOwn) {
        RoundedCornerShape(topStart = big, topEnd = if (first) big else small, bottomEnd = small, bottomStart = big)
    } else {
        RoundedCornerShape(topStart = if (first) big else small, topEnd = big, bottomEnd = big, bottomStart = small)
    }
    val media = content is RowContent.Image
    Column(
        Modifier.fillMaxWidth().padding(start = 12.dp, end = 12.dp, top = if (first) 8.dp else 2.dp),
        horizontalAlignment = if (row.isOwn) Alignment.End else Alignment.Start,
    ) {
        Box(Modifier.fillMaxWidth(0.84f), contentAlignment = if (row.isOwn) Alignment.CenterEnd else Alignment.CenterStart) {
            Surface(
                color = if (row.isOwn) c.bubbleOwn else c.bubbleOther,
                shape = shape,
                border = when {
                    failed -> BorderStroke(1.dp, c.danger)
                    !row.isOwn && !MaterialTheme.isDark -> BorderStroke(1.dp, c.border)
                    else -> null
                },
                modifier = Modifier.widthIn(max = 480.dp).clip(shape)
                    .combinedClickable(onClick = {}, onLongClick = onLongPress, onLongClickLabel = stringResource(R.string.message_actions)),
            ) {
                Column(Modifier.padding(if (media) 4.dp else 0.dp)) {
                    val pad = if (media) Modifier.padding(horizontal = 10.dp) else Modifier.padding(horizontal = 14.dp)
                    if (first && !row.isOwn && !isDirect) {
                        Text(
                            row.senderName, style = MaterialTheme.typography.labelLarge, color = c.accent, maxLines = 1, overflow = TextOverflow.Ellipsis,
                            modifier = pad.padding(top = if (media) 4.dp else 8.dp),
                        )
                    }
                    row.replyTo?.let { r ->
                        Row(
                            Modifier.padding(start = if (media) 0.dp else 8.dp, end = if (media) 0.dp else 8.dp, top = 8.dp)
                                .height(IntrinsicSize.Min).clip(RoundedCornerShape(10.dp))
                                .background(if (row.isOwn) c.accentSoft else c.surface2),
                        ) {
                            Box(Modifier.width(3.dp).fillMaxHeight().background(c.accent))
                            Column(Modifier.padding(horizontal = 10.dp, vertical = 6.dp)) {
                                Text(r.senderName ?: stringResource(R.string.reply_unknown), style = MaterialTheme.typography.labelMedium, color = c.accent, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                Text(r.text ?: "…", style = MaterialTheme.typography.bodySmall, color = c.textMuted, maxLines = 2, overflow = TextOverflow.Ellipsis)
                            }
                        }
                    }
                    val bodyPad = pad.padding(top = if (media) 0.dp else 8.dp)
                    when (content) {
                        is RowContent.Text -> Text(linkified(content.body), style = MaterialTheme.typography.bodyLarge, color = c.text, modifier = bodyPad)
                        is RowContent.Notice -> Text(linkified(content.body), style = MaterialTheme.typography.bodyLarge, color = c.textMuted, modifier = bodyPad)
                        is RowContent.Emote -> Text("* ${row.senderName} ${content.body}", style = MaterialTheme.typography.bodyLarge, color = c.text, fontStyle = FontStyle.Italic, modifier = bodyPad)
                        is RowContent.Image -> {
                            val ratio = ((content.width ?: 4L).toFloat() / (content.height ?: 3L).toFloat().coerceAtLeast(1f)).coerceIn(0.6f, 1.8f)
                            LocalMediaHost.current.Image(
                                content.thumbnail ?: content.source, contentDescription = content.caption ?: content.filename,
                                modifier = Modifier.width(264.dp).aspectRatio(ratio).clip(RoundedCornerShape(14.dp)),
                            )
                            content.caption?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = c.text, modifier = pad.padding(top = 6.dp)) }
                        }
                        is RowContent.File -> Box(if (media) Modifier else Modifier.padding(start = 6.dp, end = 6.dp, top = 6.dp)) { FileChip(content, row.isOwn) }
                        RowContent.Redacted -> Row(bodyPad, verticalAlignment = Alignment.CenterVertically) {
                            Icon(painterResource(R.drawable.ic_lucide_trash_2), null, tint = c.textSubtle, modifier = Modifier.size(14.dp))
                            Spacer(Modifier.width(6.dp))
                            Text(stringResource(R.string.timeline_deleted), style = MaterialTheme.typography.bodyMedium, color = c.textSubtle, fontStyle = FontStyle.Italic)
                        }
                        RowContent.UnableToDecrypt -> Row(bodyPad, verticalAlignment = Alignment.Top) {
                            Icon(painterResource(R.drawable.ic_lucide_clock), null, tint = c.textMuted, modifier = Modifier.padding(top = 2.dp).size(16.dp))
                            Spacer(Modifier.width(8.dp))
                            Text(stringResource(R.string.timeline_utd_long), style = MaterialTheme.typography.bodyMedium, color = c.textMuted)
                        }
                        is RowContent.Unsupported -> Text(content.text, style = MaterialTheme.typography.bodyMedium, color = c.textMuted, fontStyle = FontStyle.Italic, modifier = bodyPad)
                        is RowContent.StateText, is RowContent.Call -> Unit
                    }
                    Row(
                        Modifier.align(Alignment.End).padding(start = 14.dp, end = if (media) 8.dp else 12.dp, top = 2.dp, bottom = if (media) 4.dp else 6.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        if (row.shield != ShieldUi.NONE) {
                            Icon(
                                painterResource(R.drawable.ic_lucide_shield_alert), stringResource(R.string.shield_warning),
                                tint = if (row.shield == ShieldUi.ALERT) c.danger else c.textSubtle, modifier = Modifier.size(12.dp),
                            )
                            Spacer(Modifier.width(4.dp))
                        }
                        if (row.edited) {
                            Text(stringResource(R.string.message_edited), style = MaterialTheme.typography.labelSmall, color = c.textSubtle)
                            Spacer(Modifier.width(4.dp))
                        }
                        Text(time, style = MaterialTheme.typography.labelSmall, color = c.textSubtle)
                        if (deliveryLabel != null) {
                            Spacer(Modifier.width(4.dp))
                            val icon = when (row.delivery) {
                                DeliveryState.SENDING -> R.drawable.ic_lucide_clock
                                DeliveryState.SENT -> R.drawable.ic_lucide_check
                                DeliveryState.READ -> R.drawable.ic_lucide_check_check
                                else -> R.drawable.ic_lucide_circle_alert
                            }
                            Icon(
                                painterResource(icon), deliveryLabel,
                                tint = when (row.delivery) {
                                    DeliveryState.FAILED -> c.danger
                                    DeliveryState.READ -> c.accent
                                    else -> c.textSubtle
                                },
                                modifier = Modifier.size(14.dp),
                            )
                        }
                    }
                }
            }
        }
        if (failed) {
            TextButton(onClick = onRetry, contentPadding = PaddingValues(horizontal = 10.dp)) {
                Icon(painterResource(R.drawable.ic_lucide_refresh_cw), null, tint = c.danger, modifier = Modifier.size(14.dp))
                Spacer(Modifier.width(6.dp))
                Text(stringResource(R.string.delivery_failed) + " · " + stringResource(R.string.delivery_retry), color = c.danger, style = MaterialTheme.typography.labelMedium)
            }
        }
        if (row.reactions.isNotEmpty()) {
            FlowRow(Modifier.padding(top = 4.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                row.reactions.forEach { r ->
                    val desc = stringResource(R.string.cd_reaction, r.key, r.count)
                    Surface(
                        shape = CircleShape,
                        color = if (r.mine) c.accentSoft else c.surface,
                        border = BorderStroke(1.dp, if (r.mine) c.accent.copy(alpha = 0.6f) else c.border),
                        modifier = Modifier.heightIn(min = 32.dp).clip(CircleShape).clickable(role = Role.Button) { onReact(r.key) }.semantics { contentDescription = desc },
                    ) {
                        Row(Modifier.padding(horizontal = 10.dp, vertical = 5.dp), verticalAlignment = Alignment.CenterVertically) {
                            Text(r.key, fontSize = 15.sp)
                            Spacer(Modifier.width(5.dp))
                            Text(r.count.toString(), style = MaterialTheme.typography.labelMedium, color = if (r.mine) c.accent else c.textMuted, fontWeight = FontWeight.SemiBold)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun FileChip(f: RowContent.File, own: Boolean) {
    val mediaHost = LocalMediaHost.current
    val c = MaterialTheme.lumenColors
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var failed by remember { mutableStateOf(false) }
    val saver = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument(f.mimeType ?: "application/octet-stream")) { uri ->
        if (uri != null) scope.launch { failed = !mediaHost.save(context, f.source, uri) }
    }
    Column {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.clip(MaterialTheme.shapes.small).background(if (own) c.accentSoft else c.surface2)
                .clickable { scope.launch { failed = !mediaHost.open(context, f.source, f.filename, f.mimeType) } }
                .padding(start = 10.dp, top = 6.dp, bottom = 6.dp),
        ) {
            Box(Modifier.size(40.dp).clip(CircleShape).background(c.surface), contentAlignment = Alignment.Center) {
                Icon(
                    painterResource(
                        when (f.kind) {
                            FileKind.VIDEO -> R.drawable.ic_lucide_video
                            FileKind.AUDIO -> R.drawable.ic_lucide_headphones
                            FileKind.FILE -> R.drawable.ic_lucide_file
                        },
                    ),
                    null, tint = c.accent, modifier = Modifier.size(20.dp),
                )
            }
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f, fill = false)) {
                Text(f.filename, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium, color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                f.size?.let { Text(android.text.format.Formatter.formatShortFileSize(context, it), style = MaterialTheme.typography.labelSmall, color = c.textSubtle) }
            }
            IconButton(onClick = { saver.launch(f.filename) }) { Icon(painterResource(R.drawable.ic_lucide_download), stringResource(R.string.file_save), tint = c.textMuted) }
        }
        f.caption?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = c.text, modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp)) }
        if (failed) Text(stringResource(R.string.media_load_failed), style = MaterialTheme.typography.labelSmall, color = c.danger, modifier = Modifier.padding(horizontal = 8.dp))
    }
}

/** Long-press actions as a bottom sheet: quick reactions first, then what you can do with the message. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun MessageActions(
    row: TimelineRow.Event,
    onDismiss: () -> Unit,
    onReply: () -> Unit,
    onEdit: () -> Unit,
    onReact: (String) -> Unit,
    onCopy: () -> Unit,
    onDelete: () -> Unit,
    onRetry: () -> Unit,
    onCancelSend: () -> Unit,
    onOpenFile: () -> Unit,
) {
    val c = MaterialTheme.lumenColors
    val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val scope = rememberCoroutineScope()
    fun close(then: () -> Unit) {
        then()
        scope.launch { sheet.hide() }.invokeOnCompletion { onDismiss() }
    }
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheet, containerColor = c.surface) {
        Column(Modifier.fillMaxWidth().padding(bottom = 12.dp)) {
            if (row.eventId != null) {
                Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp), horizontalArrangement = Arrangement.SpaceEvenly) {
                    QUICK_REACTIONS.forEach { e ->
                        val desc = stringResource(R.string.cd_react_with, e)
                        val mine = row.reactions.any { it.key == e && it.mine }
                        Box(
                            Modifier.size(48.dp).clip(CircleShape).background(if (mine) c.accentSoft else c.surface2)
                                .clickable(role = Role.Button) { close { onReact(e) } }.semantics { contentDescription = desc },
                            contentAlignment = Alignment.Center,
                        ) { Text(e, fontSize = 22.sp) }
                    }
                }
                HorizontalDivider(Modifier.padding(vertical = 8.dp), color = c.border)
            }
            @Composable
            fun item(label: Int, icon: Int, danger: Boolean = false, action: () -> Unit) = Row(
                Modifier.fillMaxWidth().heightIn(min = 52.dp).clickable(role = Role.Button) { close(action) }.padding(horizontal = 24.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(painterResource(icon), null, tint = if (danger) c.danger else c.textMuted, modifier = Modifier.size(20.dp))
                Spacer(Modifier.width(18.dp))
                Text(stringResource(label), style = MaterialTheme.typography.bodyLarge, color = if (danger) c.danger else c.text)
            }
            if (row.canReply && row.eventId != null) item(R.string.message_reply, R.drawable.ic_lucide_reply, action = onReply)
            if (row.isOwn && row.editable && row.content is RowContent.Text) item(R.string.message_edit, R.drawable.ic_lucide_pencil, action = onEdit)
            if (row.content.searchableText != null && row.content !is RowContent.File && row.content !is RowContent.Image) {
                item(R.string.message_copy, R.drawable.ic_lucide_copy, action = onCopy)
            }
            if (row.content is RowContent.File || row.content is RowContent.Image) item(R.string.file_open, R.drawable.ic_lucide_external_link, action = onOpenFile)
            if (row.delivery == DeliveryState.FAILED) {
                item(R.string.delivery_retry, R.drawable.ic_lucide_refresh_cw, action = onRetry)
                item(R.string.message_cancel_send, R.drawable.ic_lucide_x, action = onCancelSend)
            }
            if (row.isOwn && row.eventId != null && row.content != RowContent.Redacted) item(R.string.action_delete, R.drawable.ic_lucide_trash_2, danger = true, action = onDelete)
        }
    }
}

@Composable
private fun Composer(ui: RoomUiState, actions: RoomActions) {
    val c = MaterialTheme.lumenColors
    val dark = MaterialTheme.isDark
    val scope = rememberCoroutineScope()
    val view = LocalView.current
    val replyTo = ui.replyTo
    val editing = ui.editing
    var text by rememberSaveable(ui.roomKey) { mutableStateOf(ui.composerText) }
    var attachMenu by remember { mutableStateOf(false) }
    var attachError by remember { mutableStateOf(false) }
    val onCancelContext = { ui.replyTo = null; ui.editing = null }
    val onSent = { ui.replyTo = null; ui.editing = null }
    LaunchedEffect(editing) { if (editing != null) text = (editing.content as? RowContent.Text)?.body ?: text }

    fun sendPicked(uri: android.net.Uri?) {
        uri ?: return
        scope.launch {
            if (!actions.onAttach(uri, replyTo)) {
                attachError = true
                return@launch
            }
            attachError = false
            onSent()
        }
    }
    val pickMedia = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { sendPicked(it) }
    val pickFile = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { sendPicked(it) }
    val canSend = text.isNotBlank()

    Surface(color = c.bgElevated, modifier = Modifier.fillMaxWidth()) {
        Column(
            Modifier.windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Bottom))
                .padding(horizontal = 8.dp, vertical = 8.dp)
                .animateContentSize(LumenEase.fast()),
        ) {
            if (replyTo != null || editing != null) {
                Row(
                    Modifier.fillMaxWidth().padding(start = 4.dp, bottom = 6.dp).height(IntrinsicSize.Min)
                        .clip(MaterialTheme.shapes.small).background(c.surface2),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Box(Modifier.width(3.dp).fillMaxHeight().background(c.accent))
                    Column(Modifier.weight(1f).padding(horizontal = 12.dp, vertical = 6.dp)) {
                        Text(
                            if (editing != null) stringResource(R.string.composer_editing) else stringResource(R.string.composer_replying_to, replyTo!!.senderName),
                            style = MaterialTheme.typography.labelLarge, color = c.accent, maxLines = 1, overflow = TextOverflow.Ellipsis,
                        )
                        val preview = (editing ?: replyTo)?.content?.searchableText
                        if (preview != null) Text(preview, style = MaterialTheme.typography.bodySmall, color = c.textMuted, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    IconButton(onClick = {
                        if (editing != null) text = ""
                        onCancelContext()
                    }) { Icon(painterResource(R.drawable.ic_lucide_x), stringResource(R.string.action_cancel), tint = c.textMuted) }
                }
            }
            if (attachError) {
                Text(stringResource(R.string.attach_failed), color = c.danger, style = MaterialTheme.typography.labelMedium, modifier = Modifier.padding(start = 12.dp, bottom = 4.dp))
            }
            Row(verticalAlignment = Alignment.Bottom) {
                Row(
                    Modifier.weight(1f).heightIn(min = 48.dp).clip(RoundedCornerShape(24.dp)).background(c.surface2),
                    verticalAlignment = Alignment.Bottom,
                ) {
                    Box {
                        IconButton(onClick = { attachMenu = true }, enabled = editing == null) {
                            Icon(painterResource(R.drawable.ic_lucide_paperclip), stringResource(R.string.composer_attach), tint = c.textMuted)
                        }
                        DropdownMenu(expanded = attachMenu, onDismissRequest = { attachMenu = false }) {
                            DropdownMenuItem(
                                text = { Text(stringResource(R.string.composer_attach_media)) },
                                leadingIcon = { Icon(painterResource(R.drawable.ic_lucide_image), null) },
                                onClick = {
                                    attachMenu = false
                                    pickMedia.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageAndVideo))
                                },
                            )
                            DropdownMenuItem(
                                text = { Text(stringResource(R.string.composer_attach_file)) },
                                leadingIcon = { Icon(painterResource(R.drawable.ic_lucide_file), null) },
                                onClick = {
                                    attachMenu = false
                                    pickFile.launch(arrayOf("*/*"))
                                },
                            )
                        }
                    }
                    BasicTextField(
                        value = text,
                        onValueChange = {
                            text = it
                            actions.onTyping(it.isNotEmpty())
                        },
                        textStyle = MaterialTheme.typography.bodyLarge.copy(color = c.text),
                        cursorBrush = SolidColor(c.accent),
                        maxLines = 6,
                        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
                        modifier = Modifier.weight(1f).padding(top = 12.dp, bottom = 12.dp, end = 16.dp).testTag("composer_input"),
                        decorationBox = { field ->
                            Box {
                                if (text.isEmpty()) Text(stringResource(R.string.composer_placeholder), style = MaterialTheme.typography.bodyLarge, color = c.textMuted)
                                field()
                            }
                        },
                    )
                }
                Spacer(Modifier.width(8.dp))
                // Always present (and reachable); it lights up with the brand gradient once there is something to send.
                val lift by animateFloatAsState(if (canSend) 1f else 0f, LumenEase.fast(), label = "send")
                val pop by animateFloatAsState(if (canSend) 1f else 0.9f, spring(dampingRatio = 0.5f, stiffness = 700f), label = "pop")
                Box(
                    Modifier.size(48.dp)
                        .graphicsLayer { scaleX = pop; scaleY = pop }
                        .clip(CircleShape)
                        .background(c.surface3)
                        .testTag("composer_send")
                        .clickable(enabled = canSend, role = Role.Button) {
                            actions.onSend(text.trim(), replyTo, editing)
                            text = ""
                            onSent()
                            view.performHapticFeedback(if (Build.VERSION.SDK_INT >= 30) HapticFeedbackConstants.CONFIRM else HapticFeedbackConstants.VIRTUAL_KEY)
                        },
                    contentAlignment = Alignment.Center,
                ) {
                    Box(Modifier.matchParentSize().graphicsLayer { alpha = lift }.background(LumenBrand.action(dark)))
                    Icon(
                        painterResource(R.drawable.ic_lucide_send), stringResource(R.string.composer_send),
                        tint = if (canSend) LumenBrand.onAction(dark) else c.textSubtle, modifier = Modifier.size(20.dp),
                    )
                }
            }
        }
    }
}
