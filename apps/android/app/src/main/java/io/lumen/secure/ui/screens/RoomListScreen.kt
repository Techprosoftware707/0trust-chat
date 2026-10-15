package io.lumen.secure.ui.screens

import android.Manifest
import android.os.Build
import android.text.format.DateUtils
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
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
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
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
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
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

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RoomListScreen(graph: AppGraph, session: MatrixSession, nav: NavViewModel, selectedRoomId: String?) {
    val controller by graph.roomList.collectAsState()
    val list = controller ?: return
    val rooms by list.visible.collectAsState()
    val loaded by list.loaded.collectAsState()
    val category by list.category.collectAsState()
    val query by list.query.collectAsState()
    val invites by list.inviteCount.collectAsState()
    val connection by session.connection.collectAsState()
    val encryption by graph.encryption.collectAsState()
    val verification by (encryption?.verification ?: remember { kotlinx.coroutines.flow.MutableStateFlow(VerificationState.UNKNOWN) }).collectAsState()
    val recovery by (encryption?.recovery ?: remember { kotlinx.coroutines.flow.MutableStateFlow(RecoveryState.UNKNOWN) }).collectAsState()
    var searching by rememberSaveable { mutableStateOf(false) }
    val c = MaterialTheme.lumenColors
    val context = LocalContext.current
    var notificationsAllowed by remember { mutableStateOf(graph.notifier.canPost()) }
    val permissionLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { notificationsAllowed = it }
    val brand = graph.serverInfo.load()?.brandName ?: stringResource(R.string.app_name)

    Scaffold(
        containerColor = c.bg,
        topBar = {
            TopAppBar(
                title = { Text(brand) },
                actions = {
                    IconButton(onClick = {
                        searching = !searching
                        if (!searching) list.query.value = ""
                    }) { Icon(painterResource(R.drawable.ic_lucide_search), stringResource(R.string.cd_search_rooms)) }
                    IconButton(onClick = { nav.push(Screen.Settings) }, modifier = Modifier.testTag("settings_button")) {
                        Icon(painterResource(R.drawable.ic_lucide_settings), stringResource(R.string.settings_title))
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = c.bg),
            )
        },
        floatingActionButton = {
            FloatingActionButton(onClick = { nav.push(Screen.NewChat) }, containerColor = c.accent, contentColor = c.accentContrast) {
                Icon(painterResource(R.drawable.ic_lucide_plus), stringResource(R.string.new_chat_title))
            }
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
            when (connection) {
                ConnectionState.OFFLINE -> Banner(stringResource(R.string.banner_offline), BannerKind.WARNING, R.drawable.ic_lucide_wifi_off)
                ConnectionState.RECONNECTING -> Banner(stringResource(R.string.banner_reconnecting), BannerKind.INFO, R.drawable.ic_lucide_refresh_cw)
                else -> Unit
            }
            if (!notificationsAllowed && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                Banner(
                    stringResource(R.string.banner_notifications), BannerKind.INFO, R.drawable.ic_lucide_bell,
                    actionLabel = stringResource(R.string.action_allow),
                    onAction = { permissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS) },
                )
            }
            if (verification == VerificationState.UNVERIFIED) {
                Banner(
                    stringResource(R.string.banner_verify_device), BannerKind.WARNING, R.drawable.ic_lucide_shield_alert,
                    actionLabel = stringResource(R.string.action_verify), onAction = { nav.push(Screen.Encryption) },
                )
            } else if (recovery == RecoveryState.DISABLED || recovery == RecoveryState.INCOMPLETE) {
                Banner(
                    stringResource(R.string.banner_recovery), BannerKind.INFO, R.drawable.ic_lucide_key_round,
                    actionLabel = stringResource(R.string.action_set_up), onAction = { nav.push(Screen.Encryption) },
                )
            }
            if (searching) {
                OutlinedTextField(
                    value = query, onValueChange = { list.query.value = it }, singleLine = true,
                    placeholder = { Text(stringResource(R.string.rooms_search_placeholder)) },
                    leadingIcon = { Icon(painterResource(R.drawable.ic_lucide_search), null) },
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
                )
            }
            Row(
                Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp, vertical = 4.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                listOf(
                    RoomCategory.ALL to R.string.filter_all,
                    RoomCategory.PEOPLE to R.string.filter_people,
                    RoomCategory.GROUPS to R.string.filter_groups,
                    RoomCategory.UNREAD to R.string.filter_unread,
                    RoomCategory.INVITES to R.string.filter_invites,
                ).forEach { (cat, label) ->
                    FilterChip(
                        selected = category == cat,
                        onClick = { list.category.value = cat },
                        label = { Text(stringResource(label) + if (cat == RoomCategory.INVITES && invites > 0) " ($invites)" else "") },
                        modifier = Modifier.semantics { selected = category == cat },
                    )
                }
            }
            Box(Modifier.weight(1f)) {
                when {
                    !loaded && rooms.isEmpty() -> CenteredState(stringResource(R.string.rooms_loading), loading = true)
                    rooms.isEmpty() && query.isNotBlank() -> CenteredState(stringResource(R.string.rooms_no_match), icon = R.drawable.ic_lucide_search)
                    rooms.isEmpty() -> CenteredState(
                        stringResource(R.string.rooms_empty_title), stringResource(R.string.rooms_empty_body),
                        icon = R.drawable.ic_lucide_messages_square,
                        actionLabel = stringResource(R.string.new_chat_title), onAction = { nav.push(Screen.NewChat) },
                    )
                    else -> LazyColumn(Modifier.fillMaxSize().testTag("room_list")) {
                        items(rooms, key = { it.id }) { room ->
                            RoomRow(graph, session, room, selected = room.id == selectedRoomId) { nav.openRoom(room.id) }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun RoomRow(graph: AppGraph, session: MatrixSession, room: RoomSummary, selected: Boolean, onOpen: () -> Unit) {
    val c = MaterialTheme.lumenColors
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    val context = LocalContext.current
    Column(
        Modifier.fillMaxWidth()
            .then(if (selected) Modifier.padding(0.dp) else Modifier)
            .clickable(enabled = !room.isInvite, onClick = onOpen)
            .padding(horizontal = 16.dp, vertical = 10.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Avatar(room.name, size = 44.dp)
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        room.name, style = MaterialTheme.typography.titleMedium,
                        fontWeight = if (room.hasUnread) FontWeight.Bold else FontWeight.SemiBold,
                        color = if (selected) c.accent else c.text, maxLines = 1, overflow = TextOverflow.Ellipsis,
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
                val subtitle = when {
                    room.isInvite -> stringResource(R.string.rooms_invited_by, room.inviterName ?: "?")
                    else -> room.lastMessage ?: ""
                }
                Text(subtitle, style = MaterialTheme.typography.bodyMedium, color = c.textMuted, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            Spacer(Modifier.width(8.dp))
            Column(horizontalAlignment = Alignment.End) {
                room.lastTimestamp?.let { ts ->
                    Text(
                        DateUtils.getRelativeTimeSpanString(ts, System.currentTimeMillis(), DateUtils.MINUTE_IN_MILLIS, DateUtils.FORMAT_ABBREV_RELATIVE).toString(),
                        style = MaterialTheme.typography.labelMedium, color = c.textSubtle,
                    )
                }
                if (room.hasUnread) {
                    Spacer(Modifier.size(4.dp))
                    UnreadBadge(maxOf(room.unreadMessages, if (room.markedUnread) 1 else 0), mention = room.unreadMentions > 0)
                }
            }
        }
        if (room.isInvite) {
            Row(Modifier.padding(start = 56.dp, top = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(enabled = !busy, onClick = {
                    busy = true
                    scope.launch {
                        try { session.client.getRoom(room.id)?.join() } catch (e: Exception) { LumenLog.w("invite", "accept failed", e) }
                        busy = false
                    }
                }) { Text(stringResource(R.string.invite_accept)) }
                TextButton(enabled = !busy, onClick = {
                    busy = true
                    scope.launch {
                        try { session.client.getRoom(room.id)?.leave() } catch (e: Exception) { LumenLog.w("invite", "decline failed", e) }
                        busy = false
                    }
                }) { Text(stringResource(R.string.invite_decline)) }
                TextButton(enabled = !busy, onClick = {
                    busy = true
                    scope.launch {
                        try {
                            val r = session.client.getRoom(room.id)
                            r?.inviter()?.userId?.let { session.client.ignoreUser(it) }
                            r?.leave()
                        } catch (e: Exception) {
                            LumenLog.w("invite", "block failed", e)
                        }
                        busy = false
                    }
                }) { Text(stringResource(R.string.invite_block), color = c.danger) }
            }
        }
    }
}
