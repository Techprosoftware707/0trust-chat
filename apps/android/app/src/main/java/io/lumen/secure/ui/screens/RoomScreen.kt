package io.lumen.secure.ui.screens

import android.content.ClipData
import android.content.ClipboardManager
import android.text.format.DateFormat
import android.text.format.DateUtils
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import io.lumen.secure.AppGraph
import io.lumen.secure.R
import io.lumen.secure.calls.CallActivity
import io.lumen.secure.core.messaging.DeliveryState
import io.lumen.secure.matrix.IdentityWarning
import io.lumen.secure.matrix.MatrixSession
import io.lumen.secure.matrix.RoomController
import io.lumen.secure.matrix.RowContent
import io.lumen.secure.matrix.ShieldUi
import io.lumen.secure.matrix.TimelineRow
import io.lumen.secure.ui.Attachments
import io.lumen.secure.ui.EncryptedImage
import io.lumen.secure.ui.MediaLoader
import io.lumen.secure.ui.components.Avatar
import io.lumen.secure.ui.components.Banner
import io.lumen.secure.ui.components.BannerKind
import io.lumen.secure.ui.components.CenteredState
import io.lumen.secure.ui.nav.NavViewModel
import io.lumen.secure.ui.nav.Screen
import io.lumen.secure.ui.theme.lumenColors
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.matrix.rustcomponents.sdk.Membership
import uniffi.matrix_sdk_crypto.IdentityState
import java.util.Date

private val QUICK_REACTIONS = listOf("👍", "❤️", "😂", "😮", "😢", "🎉")

@OptIn(ExperimentalMaterial3Api::class)
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
    val c = MaterialTheme.lumenColors
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var searching by rememberSaveable(roomId) { mutableStateOf(false) }
    var searchQuery by rememberSaveable(roomId) { mutableStateOf("") }
    var replyTo by remember(roomId) { mutableStateOf<TimelineRow.Event?>(null) }
    var editing by remember(roomId) { mutableStateOf<TimelineRow.Event?>(null) }
    var menuFor by remember(roomId) { mutableStateOf<TimelineRow.Event?>(null) }
    var deleteFor by remember(roomId) { mutableStateOf<TimelineRow.Event?>(null) }
    val listState = rememberLazyListState()
    val newestFirst = remember(rows) { rows.asReversed() }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    // Calls: the widget must be bundled and the server must advertise an RTC transport (raw check).
    var serverCalls by remember { mutableStateOf<Boolean?>(null) }
    LaunchedEffect(session) { serverCalls = graph.callSupport.available(session) }

    // Read receipts per the privacy setting, only while the newest message is on screen and the app is visible.
    val atBottom by remember { derivedStateOf { listState.firstVisibleItemIndex <= 1 } }
    LaunchedEffect(rows.size, atBottom) {
        if (atBottom && rows.isNotEmpty()) {
            lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
                delay(800)
                controller.markRead(settings.receipts)
                graph.notifier.clearRoom(roomId)
                return@repeatOnLifecycle
            }
        }
    }
    // Back-paginate when the oldest loaded message comes into view.
    val nearTop by remember { derivedStateOf { listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index?.let { it >= listState.layoutInfo.totalItemsCount - 5 } ?: false } }
    LaunchedEffect(nearTop, atStart, paginating) { if (nearTop && !atStart && !paginating) controller.paginateBack() }

    Scaffold(
        containerColor = c.bg,
        topBar = {
            TopAppBar(
                navigationIcon = {
                    if (showBack) IconButton(onClick = { nav.pop() }) { Icon(painterResource(R.drawable.ic_lucide_arrow_left), stringResource(R.string.action_back)) }
                },
                title = {
                    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.clickable { nav.push(Screen.RoomInfo(roomId)) }) {
                        Avatar(header?.name ?: "?", size = 32.dp)
                        Spacer(Modifier.width(10.dp))
                        Column {
                            Text(header?.name ?: "", maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.titleMedium)
                            val h = header
                            if (h != null) {
                                Text(
                                    stringResource(if (h.encrypted) R.string.room_encrypted else R.string.room_not_encrypted),
                                    style = MaterialTheme.typography.labelMedium, color = if (h.encrypted) c.success else c.warning,
                                )
                            }
                        }
                    }
                },
                actions = {
                    val h = header
                    if (h != null && h.membership == Membership.JOINED && graph.calls.widgetBundled && serverCalls != false) {
                        IconButton(onClick = { context.startActivity(CallActivity.startIntent(context, roomId, video = false)) }) {
                            Icon(painterResource(R.drawable.ic_lucide_phone), stringResource(if (h.hasCall) R.string.call_join_voice else R.string.call_start_voice))
                        }
                        IconButton(onClick = { context.startActivity(CallActivity.startIntent(context, roomId, video = true)) }) {
                            Icon(painterResource(R.drawable.ic_lucide_video), stringResource(if (h.hasCall) R.string.call_join_video else R.string.call_start_video))
                        }
                    }
                    IconButton(onClick = {
                        searching = !searching
                        searchQuery = ""
                    }) { Icon(painterResource(R.drawable.ic_lucide_search), stringResource(R.string.room_search)) }
                    IconButton(onClick = { nav.push(Screen.RoomInfo(roomId)) }) { Icon(painterResource(R.drawable.ic_lucide_info), stringResource(R.string.room_info_title)) }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = c.bgElevated),
            )
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).imePadding()) {
            warnings.forEach { w -> IdentityBanner(w) { controller.acknowledgeIdentity(w) } }
            error?.let {
                Banner(
                    stringResource(R.string.room_action_failed), BannerKind.DANGER, R.drawable.ic_lucide_circle_alert,
                    actionLabel = stringResource(R.string.action_dismiss), onAction = controller::clearError,
                )
            }
            val h = header
            when {
                h == null -> Box(Modifier.weight(1f)) { CenteredState(stringResource(R.string.room_loading), loading = true) }
                h.membership == Membership.INVITED -> Box(Modifier.weight(1f)) {
                    InvitePanel(h.inviterName, onAccept = { controller.join() }, onDecline = { controller.leave { nav.pop() } }, onBlock = {
                        scope.launch {
                            try {
                                session.client.getRoom(roomId)?.inviter()?.userId?.let { session.client.ignoreUser(it) }
                            } catch (_: Exception) {
                            }
                            controller.leave { nav.pop() }
                        }
                    })
                }
                h.membership != Membership.JOINED -> Box(Modifier.weight(1f)) { CenteredState(stringResource(R.string.room_not_member), icon = R.drawable.ic_lucide_ban) }
                searching -> {
                    OutlinedTextField(
                        value = searchQuery, onValueChange = { searchQuery = it }, singleLine = true,
                        placeholder = { Text(stringResource(R.string.room_search_placeholder)) },
                        leadingIcon = { Icon(painterResource(R.drawable.ic_lucide_search), null) },
                        modifier = Modifier.fillMaxWidth().padding(12.dp),
                    )
                    Text(stringResource(R.string.room_search_scope), style = MaterialTheme.typography.bodySmall, color = c.textMuted, modifier = Modifier.padding(horizontal = 16.dp))
                    val results = remember(searchQuery, rows) { if (searchQuery.isBlank()) emptyList() else controller.search(searchQuery) }
                    LazyColumn(Modifier.weight(1f)) {
                        items(results, key = { "s" + it.key }) { r ->
                            Column(Modifier.fillMaxWidth().clickable {
                                searching = false
                                val idx = newestFirst.indexOfFirst { it.key == r.key }
                                if (idx >= 0) scope.launch { listState.scrollToItem(idx) }
                            }.padding(16.dp)) {
                                Text(r.senderName, style = MaterialTheme.typography.labelLarge, color = c.accent)
                                Text(r.content.searchableText ?: "", style = MaterialTheme.typography.bodyMedium, color = c.text, maxLines = 3, overflow = TextOverflow.Ellipsis)
                                Text(DateUtils.formatDateTime(context, r.timestamp, DateUtils.FORMAT_SHOW_DATE or DateUtils.FORMAT_SHOW_TIME), style = MaterialTheme.typography.labelMedium, color = c.textSubtle)
                            }
                            HorizontalDivider(color = c.border)
                        }
                    }
                }
                else -> {
                    Box(Modifier.weight(1f)) {
                        if (rows.isEmpty()) {
                            CenteredState(stringResource(R.string.room_empty), icon = R.drawable.ic_lucide_message_circle)
                        }
                        LazyColumn(Modifier.fillMaxSize(), state = listState, reverseLayout = true, contentPadding = androidx.compose.foundation.layout.PaddingValues(vertical = 8.dp)) {
                            items(newestFirst, key = { it.key }) { row ->
                                when (row) {
                                    is TimelineRow.Event -> MessageRow(
                                        graph, session, row, isDirect = h.isDirect,
                                        onLongPress = { menuFor = row },
                                        onReact = { key -> controller.toggleReaction(row, key) },
                                        onRetry = { controller.retry(row) },
                                    )
                                    is TimelineRow.DateDivider -> DateDivider(row.millis)
                                    is TimelineRow.ReadMarker -> ReadMarker()
                                    is TimelineRow.Start -> Text(
                                        stringResource(R.string.room_start), style = MaterialTheme.typography.labelMedium, color = c.textSubtle,
                                        modifier = Modifier.fillMaxWidth().padding(12.dp), textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                                    )
                                }
                            }
                            if (paginating) item { Box(Modifier.fillMaxWidth().padding(8.dp), contentAlignment = Alignment.Center) { androidx.compose.material3.CircularProgressIndicator(Modifier.size(20.dp)) } }
                        }
                    }
                    if (typing.isNotEmpty()) {
                        Text(
                            if (typing.size == 1) stringResource(R.string.room_typing_one, typing[0]) else pluralStringResource(R.plurals.room_typing_many, typing.size, typing.size),
                            style = MaterialTheme.typography.labelMedium, color = c.textMuted, fontStyle = FontStyle.Italic,
                            modifier = Modifier.padding(horizontal = 16.dp, vertical = 2.dp),
                        )
                    }
                    Composer(
                        graph = graph, controller = controller, typingEnabled = settings.typing,
                        replyTo = replyTo, editing = editing,
                        onCancelContext = { replyTo = null; editing = null },
                        onSent = { replyTo = null; editing = null },
                    )
                }
            }
        }
    }

    menuFor?.let { row ->
        MessageActions(
            row = row,
            onDismiss = { menuFor = null },
            onReply = { replyTo = row; editing = null },
            onEdit = { editing = row; replyTo = null },
            onReact = { controller.toggleReaction(row, it) },
            onCopy = {
                val text = row.content.searchableText ?: return@MessageActions
                context.getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("message", text))
            },
            onDelete = { deleteFor = row },
            onRetry = { controller.retry(row) },
            onCancelSend = { controller.cancelSend(row) },
            onOpenFile = {
                scope.launch {
                    when (val ct = row.content) {
                        is RowContent.File -> MediaLoader.open(context, session, ct.source, ct.filename, ct.mimeType)
                        is RowContent.Image -> MediaLoader.open(context, session, ct.source, ct.filename, ct.mimeType)
                        else -> Unit
                    }
                }
            },
        )
    }
    deleteFor?.let { row ->
        AlertDialog(
            onDismissRequest = { deleteFor = null },
            title = { Text(stringResource(R.string.message_delete_title)) },
            text = { Text(stringResource(R.string.message_delete_body)) },
            confirmButton = { TextButton(onClick = { controller.redact(row); deleteFor = null }) { Text(stringResource(R.string.action_delete), color = c.danger) } },
            dismissButton = { TextButton(onClick = { deleteFor = null }) { Text(stringResource(R.string.action_cancel)) } },
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
    Column(Modifier.fillMaxSize().padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
        Icon(painterResource(R.drawable.ic_lucide_user_plus), null, tint = c.accent, modifier = Modifier.size(40.dp))
        Spacer(Modifier.height(12.dp))
        Text(stringResource(R.string.rooms_invited_by, inviter ?: "?"), style = MaterialTheme.typography.titleMedium, color = c.text)
        Spacer(Modifier.height(16.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            androidx.compose.material3.Button(onClick = onAccept) { Text(stringResource(R.string.invite_accept)) }
            androidx.compose.material3.OutlinedButton(onClick = onDecline) { Text(stringResource(R.string.invite_decline)) }
        }
        TextButton(onClick = onBlock) { Text(stringResource(R.string.invite_block), color = c.danger) }
    }
}

@Composable
private fun DateDivider(millis: Long) {
    val c = MaterialTheme.lumenColors
    val context = LocalContext.current
    Text(
        DateUtils.formatDateTime(context, millis, DateUtils.FORMAT_SHOW_DATE or DateUtils.FORMAT_SHOW_WEEKDAY),
        style = MaterialTheme.typography.labelMedium, color = c.textSubtle,
        modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp), textAlign = androidx.compose.ui.text.style.TextAlign.Center,
    )
}

@Composable
private fun ReadMarker() {
    val c = MaterialTheme.lumenColors
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        HorizontalDivider(Modifier.weight(1f), color = c.accent)
        Text(stringResource(R.string.room_new_messages), style = MaterialTheme.typography.labelMedium, color = c.accent, modifier = Modifier.padding(horizontal = 8.dp))
        HorizontalDivider(Modifier.weight(1f), color = c.accent)
    }
}

@OptIn(ExperimentalFoundationApi::class, ExperimentalLayoutApi::class)
@Composable
private fun MessageRow(
    graph: AppGraph,
    session: MatrixSession,
    row: TimelineRow.Event,
    isDirect: Boolean,
    onLongPress: () -> Unit,
    onReact: (String) -> Unit,
    onRetry: () -> Unit,
) {
    val c = MaterialTheme.lumenColors
    val context = LocalContext.current
    val content = row.content
    when (content) {
        is RowContent.StateText, is RowContent.Call -> {
            val text = (content as? RowContent.StateText)?.text ?: stringResource(if ((content as RowContent.Call).active) R.string.timeline_call_active else R.string.timeline_call_ended)
            Text(
                text, style = MaterialTheme.typography.labelMedium, color = c.textSubtle,
                modifier = Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 4.dp), textAlign = androidx.compose.ui.text.style.TextAlign.Center,
            )
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
    Column(
        Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 3.dp),
        horizontalAlignment = if (row.isOwn) Alignment.End else Alignment.Start,
    ) {
        Surface(
            color = if (row.isOwn) c.bubbleOwn else c.bubbleOther,
            shape = RoundedCornerShape(16.dp),
            tonalElevation = 0.dp,
            shadowElevation = if (row.isOwn) 0.dp else 1.dp,
            modifier = Modifier.widthIn(max = 420.dp).clip(RoundedCornerShape(16.dp))
                .combinedClickable(onClick = {}, onLongClick = onLongPress, onLongClickLabel = stringResource(R.string.message_actions)),
        ) {
            Column(Modifier.padding(horizontal = 12.dp, vertical = 8.dp)) {
                if (!row.isOwn && !isDirect) {
                    Text(row.senderName, style = MaterialTheme.typography.labelLarge, color = c.accent, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                row.replyTo?.let { r ->
                    Row(Modifier.padding(vertical = 4.dp).background(c.surface3, RoundedCornerShape(8.dp)).padding(8.dp)) {
                        Icon(painterResource(R.drawable.ic_lucide_reply), null, tint = c.textMuted, modifier = Modifier.size(14.dp))
                        Spacer(Modifier.width(6.dp))
                        Column {
                            Text(r.senderName ?: stringResource(R.string.reply_unknown), style = MaterialTheme.typography.labelMedium, color = c.textMuted)
                            Text(r.text ?: "…", style = MaterialTheme.typography.bodySmall, color = c.textMuted, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        }
                    }
                }
                when (content) {
                    is RowContent.Text -> Text(content.body, style = MaterialTheme.typography.bodyLarge, color = c.text)
                    is RowContent.Notice -> Text(content.body, style = MaterialTheme.typography.bodyLarge, color = c.textMuted)
                    is RowContent.Emote -> Text("* ${row.senderName} ${content.body}", style = MaterialTheme.typography.bodyLarge, color = c.text, fontStyle = FontStyle.Italic)
                    is RowContent.Image -> {
                        EncryptedImage(session, content.thumbnail ?: content.source, contentDescription = content.caption ?: content.filename)
                        content.caption?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = c.text) }
                    }
                    is RowContent.File -> FileChip(graph, session, content)
                    RowContent.Redacted -> Text(stringResource(R.string.timeline_deleted), style = MaterialTheme.typography.bodyMedium, color = c.textSubtle, fontStyle = FontStyle.Italic)
                    RowContent.UnableToDecrypt -> Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(painterResource(R.drawable.ic_lucide_lock), null, tint = c.warning, modifier = Modifier.size(14.dp))
                        Spacer(Modifier.width(6.dp))
                        Text(stringResource(R.string.timeline_utd_long), style = MaterialTheme.typography.bodyMedium, color = c.textMuted, fontStyle = FontStyle.Italic)
                    }
                    is RowContent.Unsupported -> Text(content.text, style = MaterialTheme.typography.bodyMedium, color = c.textMuted, fontStyle = FontStyle.Italic)
                }
                Row(Modifier.align(Alignment.End), verticalAlignment = Alignment.CenterVertically) {
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
                if (row.delivery == DeliveryState.FAILED) {
                    TextButton(onClick = onRetry) { Text(stringResource(R.string.delivery_retry), color = c.danger) }
                }
            }
        }
        if (row.reactions.isNotEmpty()) {
            FlowRow(Modifier.padding(top = 2.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                row.reactions.forEach { r ->
                    val desc = stringResource(R.string.cd_reaction, r.key, r.count)
                    Surface(
                        shape = RoundedCornerShape(12.dp),
                        color = if (r.mine) c.accentSoft else c.surface2,
                        modifier = Modifier.clip(RoundedCornerShape(12.dp)).clickable { onReact(r.key) }.semantics { contentDescription = desc },
                    ) {
                        Text("${r.key} ${r.count}", style = MaterialTheme.typography.labelMedium, modifier = Modifier.padding(horizontal = 8.dp, vertical = 3.dp))
                    }
                }
            }
        }
    }
}

@Composable
private fun FileChip(graph: AppGraph, session: MatrixSession, f: RowContent.File) {
    val c = MaterialTheme.lumenColors
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var failed by remember { mutableStateOf(false) }
    val saver = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument(f.mimeType ?: "application/octet-stream")) { uri ->
        if (uri != null) scope.launch { failed = !MediaLoader.saveTo(context, session, f.source, uri) }
    }
    Column {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.clickable { scope.launch { failed = !MediaLoader.open(context, session, f.source, f.filename, f.mimeType) } }) {
            Icon(painterResource(R.drawable.ic_lucide_file), null, tint = c.accent)
            Spacer(Modifier.width(8.dp))
            Column(Modifier.weight(1f, fill = false)) {
                Text(f.filename, style = MaterialTheme.typography.bodyMedium, color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                f.size?.let { Text(android.text.format.Formatter.formatShortFileSize(context, it), style = MaterialTheme.typography.labelSmall, color = c.textSubtle) }
            }
            IconButton(onClick = { saver.launch(f.filename) }) { Icon(painterResource(R.drawable.ic_lucide_download), stringResource(R.string.file_save)) }
        }
        f.caption?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = c.text) }
        if (failed) Text(stringResource(R.string.media_load_failed), style = MaterialTheme.typography.labelSmall, color = c.danger)
    }
}

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
    AlertDialog(
        onDismissRequest = onDismiss,
        confirmButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.action_close)) } },
        text = {
            Column {
                if (row.eventId != null) {
                    Row(horizontalArrangement = Arrangement.SpaceEvenly, modifier = Modifier.fillMaxWidth()) {
                        QUICK_REACTIONS.forEach { e ->
                            val desc = stringResource(R.string.cd_react_with, e)
                            Text(e, style = MaterialTheme.typography.headlineSmall, modifier = Modifier.clip(RoundedCornerShape(8.dp))
                                .clickable { onReact(e); onDismiss() }.padding(6.dp).semantics { contentDescription = desc })
                        }
                    }
                    Spacer(Modifier.height(8.dp))
                }
                @Composable
                fun item(label: Int, icon: Int, action: () -> Unit) = Row(
                    Modifier.fillMaxWidth().clickable { action(); onDismiss() }.padding(vertical = 12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(painterResource(icon), null)
                    Spacer(Modifier.width(16.dp))
                    Text(stringResource(label))
                }
                if (row.canReply && row.eventId != null) item(R.string.message_reply, R.drawable.ic_lucide_reply, onReply)
                if (row.isOwn && row.editable && row.content is RowContent.Text) item(R.string.message_edit, R.drawable.ic_lucide_pencil, onEdit)
                if (row.content.searchableText != null && row.content !is RowContent.File && row.content !is RowContent.Image) {
                    item(R.string.message_copy, R.drawable.ic_lucide_copy, onCopy)
                }
                if (row.content is RowContent.File || row.content is RowContent.Image) item(R.string.file_open, R.drawable.ic_lucide_external_link, onOpenFile)
                if (row.delivery == DeliveryState.FAILED) {
                    item(R.string.delivery_retry, R.drawable.ic_lucide_refresh_cw, onRetry)
                    item(R.string.message_cancel_send, R.drawable.ic_lucide_x, onCancelSend)
                }
                if (row.isOwn && row.eventId != null && row.content != RowContent.Redacted) item(R.string.action_delete, R.drawable.ic_lucide_trash_2, onDelete)
            }
        },
    )
}

@Composable
private fun Composer(
    graph: AppGraph,
    controller: RoomController,
    typingEnabled: Boolean,
    replyTo: TimelineRow.Event?,
    editing: TimelineRow.Event?,
    onCancelContext: () -> Unit,
    onSent: () -> Unit,
) {
    val c = MaterialTheme.lumenColors
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var text by rememberSaveable(controller.roomId) { mutableStateOf("") }
    var attachMenu by remember { mutableStateOf(false) }
    var attachError by remember { mutableStateOf(false) }
    LaunchedEffect(editing) { if (editing != null) text = (editing.content as? RowContent.Text)?.body ?: text }

    fun sendPicked(uri: android.net.Uri?) {
        uri ?: return
        scope.launch {
            val picked = Attachments.copy(context, uri)
            if (picked == null) {
                attachError = true
                return@launch
            }
            controller.sendAttachment(picked.file, picked.name, picked.mimeType, picked.size, picked.imageSize, replyTo)
            onSent()
        }
    }
    val pickMedia = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { sendPicked(it) }
    val pickFile = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { sendPicked(it) }

    Surface(color = c.bgElevated, modifier = Modifier.fillMaxWidth().navigationBarsPadding()) {
        Column {
            if (replyTo != null || editing != null) {
                Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 4.dp, top = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                    Icon(painterResource(if (editing != null) R.drawable.ic_lucide_pencil else R.drawable.ic_lucide_reply), null, tint = c.accent, modifier = Modifier.size(16.dp))
                    Spacer(Modifier.width(8.dp))
                    Text(
                        if (editing != null) stringResource(R.string.composer_editing) else stringResource(R.string.composer_replying_to, replyTo!!.senderName),
                        style = MaterialTheme.typography.labelLarge, color = c.textMuted, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis,
                    )
                    IconButton(onClick = {
                        if (editing != null) text = ""
                        onCancelContext()
                    }) { Icon(painterResource(R.drawable.ic_lucide_x), stringResource(R.string.action_cancel)) }
                }
            }
            if (attachError) Text(stringResource(R.string.attach_failed), color = c.danger, style = MaterialTheme.typography.labelMedium, modifier = Modifier.padding(horizontal = 16.dp))
            Row(Modifier.fillMaxWidth().padding(8.dp), verticalAlignment = Alignment.Bottom) {
                Box {
                    IconButton(onClick = { attachMenu = true }, enabled = editing == null) {
                        Icon(painterResource(R.drawable.ic_lucide_paperclip), stringResource(R.string.composer_attach))
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
                OutlinedTextField(
                    value = text,
                    onValueChange = {
                        text = it
                        controller.setTyping(it.isNotEmpty(), enabled = typingEnabled)
                    },
                    placeholder = { Text(stringResource(R.string.composer_placeholder)) },
                    maxLines = 6,
                    modifier = Modifier.weight(1f),
                )
                IconButton(
                    enabled = text.isNotBlank(),
                    onClick = {
                        controller.sendText(text.trim(), replyTo, editing)
                        text = ""
                        onSent()
                    },
                ) { Icon(painterResource(R.drawable.ic_lucide_send), stringResource(R.string.composer_send), tint = if (text.isNotBlank()) c.accent else c.textSubtle) }
            }
        }
    }
}
