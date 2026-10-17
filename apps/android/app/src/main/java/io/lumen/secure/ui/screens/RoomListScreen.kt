package io.lumen.secure.ui.screens

import android.Manifest
import android.os.Build
import android.text.format.DateUtils
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.runtime.derivedStateOf
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import io.lumen.secure.ui.components.LogoMark
import io.lumen.secure.ui.components.RoomListSkeleton
import io.lumen.secure.ui.components.SearchField
import io.lumen.secure.ui.theme.LumenDimens
import io.lumen.secure.ui.theme.LumenEase
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.lumen.secure.AppGraph
import io.lumen.secure.R
import io.lumen.secure.log.LumenLog
import io.lumen.secure.matrix.ConnectionState
import io.lumen.secure.matrix.MatrixSession
import io.lumen.secure.matrix.RoomCategory
import io.lumen.secure.matrix.RoomSummary
import io.lumen.secure.ui.components.Avatar
import io.lumen.secure.ui.components.Banner
import io.lumen.secure.ui.components.BannerKind
import io.lumen.secure.ui.components.CenteredState
import io.lumen.secure.ui.components.UnreadBadge
import io.lumen.secure.ui.nav.NavViewModel
import io.lumen.secure.ui.nav.Screen
import io.lumen.secure.ui.theme.lumenColors
import kotlinx.coroutines.launch
import org.matrix.rustcomponents.sdk.RecoveryState
import org.matrix.rustcomponents.sdk.VerificationState

/** What the room list shows (plain data; [RoomListScreen] collects it from the SDK). */
data class RoomListUiState(
    val brand: String,
    val loading: Boolean,
    val rooms: List<RoomSummary>,
    val category: RoomCategory = RoomCategory.ALL,
    val query: String = "",
    val invites: Int = 0,
    val connection: ConnectionState = ConnectionState.CONNECTED,
    val verification: VerificationState = VerificationState.VERIFIED,
    val recovery: RecoveryState = RecoveryState.ENABLED,
    val askNotifications: Boolean = false,
    val selectedRoomId: String? = null,
    val busyInvites: Set<String> = emptySet(),
)

enum class InviteAction { ACCEPT, DECLINE, BLOCK }

class RoomListActions(
    val onQuery: (String) -> Unit = {},
    val onCategory: (RoomCategory) -> Unit = {},
    val onOpenRoom: (String) -> Unit = {},
    val onNewChat: () -> Unit = {},
    val onSettings: () -> Unit = {},
    val onEncryption: () -> Unit = {},
    val onAllowNotifications: () -> Unit = {},
    val onInvite: (roomId: String, InviteAction) -> Unit = { _, _ -> },
)

@Composable
fun RoomListScreen(graph: AppGraph, session: MatrixSession, nav: NavViewModel, selectedRoomId: String?) {
    val controller by graph.roomList.collectAsState()
    val list = controller
    val emptyRooms = remember { kotlinx.coroutines.flow.MutableStateFlow(emptyList<RoomSummary>()) }
    val rooms by (list?.visible ?: emptyRooms).collectAsState()
    val loaded by (list?.loaded ?: remember { kotlinx.coroutines.flow.MutableStateFlow(false) }).collectAsState()
    val category by (list?.category ?: remember { kotlinx.coroutines.flow.MutableStateFlow(RoomCategory.ALL) }).collectAsState()
    val query by (list?.query ?: remember { kotlinx.coroutines.flow.MutableStateFlow("") }).collectAsState()
    val invites by (list?.inviteCount ?: remember { kotlinx.coroutines.flow.MutableStateFlow(0) }).collectAsState()
    val connection by session.connection.collectAsState()
    val encryption by graph.encryption.collectAsState()
    val verification by (encryption?.verification ?: remember { kotlinx.coroutines.flow.MutableStateFlow(VerificationState.UNKNOWN) }).collectAsState()
    val recovery by (encryption?.recovery ?: remember { kotlinx.coroutines.flow.MutableStateFlow(RecoveryState.UNKNOWN) }).collectAsState()
    var notificationsAllowed by remember { mutableStateOf(graph.notifier.canPost()) }
    val permissionLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { notificationsAllowed = it }
    val brand = graph.serverInfo.load()?.brandName ?: stringResource(R.string.app_name)
    val scope = rememberCoroutineScope()
    var busyInvites by remember { mutableStateOf(emptySet<String>()) }

    RoomListContent(
        state = RoomListUiState(
            brand = brand,
            loading = list == null || (!loaded && rooms.isEmpty()),
            rooms = rooms,
            category = category,
            query = query,
            invites = invites,
            connection = connection,
            verification = verification,
            recovery = recovery,
            askNotifications = !notificationsAllowed && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU,
            selectedRoomId = selectedRoomId,
            busyInvites = busyInvites,
        ),
        actions = RoomListActions(
            onQuery = { list?.query?.value = it },
            onCategory = { list?.category?.value = it },
            onOpenRoom = { nav.openRoom(it) },
            onNewChat = { nav.push(Screen.NewChat) },
            onSettings = { nav.push(Screen.Settings) },
            onEncryption = { nav.push(Screen.Encryption) },
            onAllowNotifications = { permissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS) },
            onInvite = { roomId, action ->
                busyInvites = busyInvites + roomId
                scope.launch {
                    try {
                        val room = session.client.getRoom(roomId)
                        when (action) {
                            InviteAction.ACCEPT -> room?.join()
                            InviteAction.DECLINE -> room?.leave()
                            InviteAction.BLOCK -> {
                                room?.inviter()?.userId?.let { session.client.ignoreUser(it) }
                                room?.leave()
                            }
                        }
                    } catch (e: Exception) {
                        LumenLog.w("invite", "invite action failed", e)
                    }
                    busyInvites = busyInvites - roomId
                }
            },
        ),
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RoomListContent(state: RoomListUiState, actions: RoomListActions) {
    val c = MaterialTheme.lumenColors
    val rooms = state.rooms
    val query = state.query
    val listState = rememberLazyListState()
    val atTop by remember { derivedStateOf { listState.firstVisibleItemIndex == 0 && listState.firstVisibleItemScrollOffset < 24 } }

    Scaffold(
        containerColor = c.bg,
        topBar = {
            TopAppBar(
                title = {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        LogoMark(28.dp)
                        Spacer(Modifier.width(10.dp))
                        Text(state.brand, style = MaterialTheme.typography.titleLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                },
                actions = {
                    IconButton(onClick = actions.onSettings, modifier = Modifier.testTag("settings_button")) {
                        Icon(painterResource(R.drawable.ic_lucide_settings), stringResource(R.string.settings_title))
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = c.bg),
            )
        },
        floatingActionButton = {
            // The empty state carries its own "Start a chat" action; one call to action is enough.
            if (state.loading || state.rooms.isNotEmpty() || state.query.isNotBlank() || state.category != RoomCategory.ALL) ExtendedFloatingActionButton(
                onClick = actions.onNewChat,
                expanded = atTop,
                icon = { Icon(painterResource(R.drawable.ic_lucide_plus), null) },
                text = { Text(stringResource(R.string.new_chat_title)) },
                containerColor = c.accent,
                contentColor = c.accentContrast,
                shape = RoundedCornerShape(LumenDimens.radiusLg),
            )
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
            Column(Modifier.animateContentSize(LumenEase.med())) {
                when (state.connection) {
                    ConnectionState.OFFLINE -> Banner(stringResource(R.string.banner_offline), BannerKind.WARNING, R.drawable.ic_lucide_wifi_off)
                    ConnectionState.RECONNECTING -> Banner(stringResource(R.string.banner_reconnecting), BannerKind.INFO, R.drawable.ic_lucide_refresh_cw)
                    else -> Unit
                }
                if (state.askNotifications) {
                    Banner(
                        stringResource(R.string.banner_notifications), BannerKind.INFO, R.drawable.ic_lucide_bell,
                        actionLabel = stringResource(R.string.action_allow),
                        onAction = actions.onAllowNotifications,
                    )
                }
                if (state.verification == VerificationState.UNVERIFIED) {
                    Banner(
                        stringResource(R.string.banner_verify_device), BannerKind.WARNING, R.drawable.ic_lucide_shield_alert,
                        actionLabel = stringResource(R.string.action_verify), onAction = actions.onEncryption,
                    )
                } else if (state.recovery == RecoveryState.DISABLED || state.recovery == RecoveryState.INCOMPLETE) {
                    Banner(
                        stringResource(R.string.banner_recovery), BannerKind.INFO, R.drawable.ic_lucide_key_round,
                        actionLabel = stringResource(R.string.action_set_up), onAction = actions.onEncryption,
                    )
                }
            }
            SearchField(
                value = query, onValueChange = actions.onQuery, placeholder = stringResource(R.string.rooms_search_placeholder),
                modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp),
            )
            Row(
                Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 4.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                listOf(
                    RoomCategory.ALL to R.string.filter_all,
                    RoomCategory.PEOPLE to R.string.filter_people,
                    RoomCategory.GROUPS to R.string.filter_groups,
                    RoomCategory.UNREAD to R.string.filter_unread,
                    RoomCategory.INVITES to R.string.filter_invites,
                ).forEach { (cat, label) ->
                    val selected = state.category == cat
                    FilterChip(
                        selected = selected,
                        onClick = { actions.onCategory(cat) },
                        label = { Text(stringResource(label) + if (cat == RoomCategory.INVITES && state.invites > 0) " ${state.invites}" else "") },
                        shape = CircleShape,
                        colors = FilterChipDefaults.filterChipColors(
                            containerColor = c.bg, labelColor = c.textMuted,
                            selectedContainerColor = c.accent, selectedLabelColor = c.accentContrast,
                        ),
                        border = FilterChipDefaults.filterChipBorder(
                            enabled = true, selected = selected, borderColor = c.border, selectedBorderColor = Color.Transparent,
                        ),
                        modifier = Modifier.semantics { this.selected = selected },
                    )
                }
            }
            Box(Modifier.weight(1f)) {
                when {
                    state.loading -> RoomListSkeleton(stringResource(R.string.rooms_loading))
                    rooms.isEmpty() && query.isNotBlank() -> CenteredState(
                        stringResource(R.string.rooms_no_match), stringResource(R.string.rooms_no_match_body), icon = R.drawable.ic_lucide_search,
                    )
                    rooms.isEmpty() && state.category != RoomCategory.ALL -> CenteredState(
                        stringResource(R.string.rooms_filter_empty), stringResource(R.string.rooms_filter_empty_body), icon = R.drawable.ic_lucide_messages_square,
                    )
                    rooms.isEmpty() -> CenteredState(
                        stringResource(R.string.rooms_empty_title), stringResource(R.string.rooms_empty_body),
                        icon = R.drawable.ic_lucide_messages_square,
                        actionLabel = stringResource(R.string.rooms_empty_action), onAction = actions.onNewChat,
                    )
                    else -> LazyColumn(
                        Modifier.fillMaxSize().testTag("room_list"),
                        state = listState,
                        contentPadding = PaddingValues(top = 4.dp, bottom = 96.dp),
                    ) {
                        items(rooms, key = { it.id }) { room ->
                            RoomRow(
                                room, selected = room.id == state.selectedRoomId, busy = room.id in state.busyInvites, actions = actions,
                                modifier = Modifier.animateItem(fadeInSpec = null, fadeOutSpec = null),
                            )
                        }
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun RoomRow(room: RoomSummary, selected: Boolean, busy: Boolean, actions: RoomListActions, modifier: Modifier = Modifier) {
    val c = MaterialTheme.lumenColors
    val onOpen = { actions.onOpenRoom(room.id) }
    val unread = room.hasUnread
    Column(
        modifier.fillMaxWidth()
            .padding(horizontal = 8.dp, vertical = 1.dp)
            .clip(MaterialTheme.shapes.medium)
            .then(if (selected) Modifier.background(c.accentSoft) else Modifier)
            .testTag("room_row")
            .clickable(enabled = !room.isInvite, onClick = onOpen)
            .padding(horizontal = 10.dp, vertical = 10.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Avatar(room.name, size = 52.dp, ring = selected)
            Spacer(Modifier.width(14.dp))
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            room.name, style = MaterialTheme.typography.titleMedium,
                            fontWeight = if (unread) FontWeight.Bold else FontWeight.SemiBold,
                            color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.weight(1f, fill = false),
                        )
                        if (room.hasCall) {
                            Spacer(Modifier.width(6.dp))
                            Icon(painterResource(R.drawable.ic_lucide_phone), stringResource(R.string.cd_call_active), tint = c.success, modifier = Modifier.size(16.dp))
                        }
                        if (!room.encrypted && !room.isInvite) {
                            Spacer(Modifier.width(6.dp))
                            Icon(painterResource(R.drawable.ic_lucide_shield_alert), stringResource(R.string.cd_not_encrypted), tint = c.warning, modifier = Modifier.size(16.dp))
                        }
                    }
                    room.lastTimestamp?.let { ts ->
                        Spacer(Modifier.width(8.dp))
                        Text(
                            DateUtils.getRelativeTimeSpanString(ts, System.currentTimeMillis(), DateUtils.MINUTE_IN_MILLIS, DateUtils.FORMAT_ABBREV_RELATIVE).toString(),
                            style = MaterialTheme.typography.labelMedium, color = if (unread) c.accent else c.textSubtle, maxLines = 1,
                        )
                    }
                }
                Spacer(Modifier.height(2.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    val subtitle = when {
                        room.isInvite -> stringResource(R.string.rooms_invited_by, room.inviterName ?: "?")
                        else -> room.lastMessage ?: ""
                    }
                    Text(
                        subtitle, style = MaterialTheme.typography.bodyMedium,
                        color = when {
                            room.isInvite -> c.accent
                            unread -> c.text
                            else -> c.textMuted
                        },
                        maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f),
                    )
                    if (unread) {
                        Spacer(Modifier.width(8.dp))
                        UnreadBadge(maxOf(room.unreadMessages, if (room.markedUnread) 1 else 0), mention = room.unreadMentions > 0)
                    }
                }
            }
        }
        if (room.isInvite) {
            FlowRow(
                Modifier.padding(start = 66.dp, top = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                FilledTonalButton(
                    enabled = !busy, modifier = Modifier.testTag("invite_accept"),
                    onClick = { actions.onInvite(room.id, InviteAction.ACCEPT) },
                ) { Text(stringResource(R.string.invite_accept)) }
                TextButton(enabled = !busy, onClick = { actions.onInvite(room.id, InviteAction.DECLINE) }) { Text(stringResource(R.string.invite_decline)) }
                TextButton(enabled = !busy, onClick = { actions.onInvite(room.id, InviteAction.BLOCK) }) { Text(stringResource(R.string.invite_block), color = c.danger) }
            }
        }
    }
}
