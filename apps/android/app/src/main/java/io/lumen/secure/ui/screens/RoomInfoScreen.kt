package io.lumen.secure.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import io.lumen.secure.ui.components.RowEnd
import io.lumen.secure.ui.components.SettingsGroup
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.lumen.secure.AppGraph
import io.lumen.secure.R
import io.lumen.secure.core.matrix.MatrixIds
import io.lumen.secure.log.LumenLog
import io.lumen.secure.matrix.DirectChats
import io.lumen.secure.matrix.MatrixSession
import io.lumen.secure.ui.components.Avatar
import io.lumen.secure.ui.components.Banner
import io.lumen.secure.ui.components.BannerKind
import io.lumen.secure.ui.components.SettingRow
import io.lumen.secure.ui.nav.NavViewModel
import io.lumen.secure.ui.nav.Screen
import io.lumen.secure.ui.theme.lumenColors
import kotlinx.coroutines.launch
import org.matrix.rustcomponents.sdk.MembershipState
import org.matrix.rustcomponents.sdk.RoomMember

data class MemberUi(val userId: String, val name: String, val invited: Boolean, val ignored: Boolean, val verified: Boolean?)

@Composable
fun RoomInfoScreen(graph: AppGraph, session: MatrixSession, nav: NavViewModel, roomId: String) {
    val scope = rememberCoroutineScope()
    val c = MaterialTheme.lumenColors
    var members by remember { mutableStateOf<List<MemberUi>?>(null) }
    var roomName by remember { mutableStateOf("") }
    var topic by remember { mutableStateOf<String?>(null) }
    var encrypted by remember { mutableStateOf(true) }
    var inviteOpen by remember { mutableStateOf(false) }
    var confirmLeave by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf(false) }
    var reload by remember { mutableIntStateOf(0) }
    val encryption by graph.encryption.collectAsState()

    LaunchedEffect(roomId, reload) {
        try {
            val room = session.client.getRoom(roomId) ?: return@LaunchedEffect
            val info = room.roomInfo()
            roomName = info.displayName ?: ""
            topic = info.topic
            encrypted = info.encryptionState == uniffi.matrix_sdk_base.EncryptionState.ENCRYPTED
            val it = room.members()
            val all = mutableListOf<RoomMember>()
            while (true) {
                val chunk = it.nextChunk(100u) ?: break
                all += chunk
            }
            val enc = session.client.encryption()
            members = all.filter { it.membership == MembershipState.Join || it.membership == MembershipState.Invite }
                .map { m ->
                    val verified = try { enc.userIdentity(m.userId, false)?.isVerified() } catch (_: Exception) { null }
                    MemberUi(m.userId, m.displayName ?: m.userId, m.membership == MembershipState.Invite, m.isIgnored, verified)
                }
                .sortedBy { it.name.lowercase() }
        } catch (e: Exception) {
            LumenLog.w("roominfo", "members failed", e)
            error = true
        }
    }

    RoomInfoContent(
        name = roomName, topic = topic, encrypted = encrypted, error = error, members = members, selfUserId = session.userId,
        actions = RoomInfoActions(
            onBack = { nav.pop() },
            onInvite = { inviteOpen = true },
            onLeave = { confirmLeave = true },
            onVerify = { m -> encryption?.verifyUser(m.userId) },
            onMessage = { m -> scope.launch { try { nav.openRoom(DirectChats.open(session, m.userId)) } catch (e: Exception) { error = true } } },
            onIgnore = { m ->
                scope.launch {
                    try {
                        if (m.ignored) session.client.unignoreUser(m.userId) else session.client.ignoreUser(m.userId)
                        reload++
                    } catch (e: Exception) {
                        error = true
                    }
                }
            },
        ),
    )

    if (inviteOpen) {
        var userId by remember { mutableStateOf("") }
        AlertDialog(
            onDismissRequest = { inviteOpen = false },
            title = { Text(stringResource(R.string.room_invite)) },
            text = {
                OutlinedTextField(userId, { userId = it.trim() }, singleLine = true, label = { Text(stringResource(R.string.new_chat_user_id)) },
                    isError = userId.isNotEmpty() && !MatrixIds.isUserId(userId))
            },
            confirmButton = {
                TextButton(enabled = MatrixIds.isUserId(userId), onClick = {
                    inviteOpen = false
                    scope.launch {
                        try { session.client.getRoom(roomId)?.inviteUserById(userId); reload++ } catch (e: Exception) { error = true }
                    }
                }) { Text(stringResource(R.string.room_invite_send)) }
            },
            dismissButton = { TextButton(onClick = { inviteOpen = false }) { Text(stringResource(R.string.action_cancel)) } },
        )
    }
    if (confirmLeave) {
        AlertDialog(
            onDismissRequest = { confirmLeave = false },
            title = { Text(stringResource(R.string.room_leave)) },
            text = { Text(stringResource(R.string.room_leave_body)) },
            confirmButton = {
                TextButton(onClick = {
                    confirmLeave = false
                    scope.launch {
                        try {
                            session.client.getRoom(roomId)?.leave()
                            nav.reset()
                        } catch (e: Exception) {
                            error = true
                        }
                    }
                }) { Text(stringResource(R.string.room_leave), color = c.danger) }
            },
            dismissButton = { TextButton(onClick = { confirmLeave = false }) { Text(stringResource(R.string.action_cancel)) } },
        )
    }
}

class RoomInfoActions(
    val onBack: () -> Unit = {},
    val onInvite: () -> Unit = {},
    val onLeave: () -> Unit = {},
    val onVerify: (MemberUi) -> Unit = {},
    val onMessage: (MemberUi) -> Unit = {},
    val onIgnore: (MemberUi) -> Unit = {},
)

@Composable
fun RoomInfoContent(
    name: String,
    topic: String?,
    encrypted: Boolean,
    error: Boolean,
    members: List<MemberUi>?,
    selfUserId: String,
    actions: RoomInfoActions,
) {
    val c = MaterialTheme.lumenColors
    DetailScaffold(stringResource(R.string.room_info_title), onBack = actions.onBack) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 8.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Avatar(name.ifEmpty { "?" }, size = 88.dp, ring = true)
            Spacer(Modifier.height(12.dp))
            Text(name, style = MaterialTheme.typography.headlineSmall, color = c.text, textAlign = TextAlign.Center, maxLines = 3, overflow = TextOverflow.Ellipsis)
            topic?.let {
                Spacer(Modifier.height(4.dp))
                Text(it, style = MaterialTheme.typography.bodyMedium, color = c.textMuted, textAlign = TextAlign.Center, maxLines = 4, overflow = TextOverflow.Ellipsis)
            }
        }
        if (error) Banner(stringResource(R.string.room_action_failed), BannerKind.DANGER, R.drawable.ic_lucide_circle_alert)
        SettingsGroup {
            if (encrypted) {
                SettingRow(stringResource(R.string.room_encrypted_matrix), stringResource(R.string.room_encrypted_matrix_desc), R.drawable.ic_lucide_lock, tint = c.success)
            } else {
                SettingRow(stringResource(R.string.room_not_encrypted), stringResource(R.string.room_not_encrypted_warning), R.drawable.ic_lucide_shield_alert, tint = c.warning)
            }
        }
        SettingsGroup {
            SettingRow(stringResource(R.string.room_invite), icon = R.drawable.ic_lucide_user_plus, onClick = actions.onInvite)
            SettingRow(stringResource(R.string.room_leave), icon = R.drawable.ic_lucide_log_out, onClick = actions.onLeave, tint = c.danger, end = RowEnd.NONE)
        }
        SettingsGroup(stringResource(R.string.room_members, members?.size ?: 0)) {
            if (members == null) {
                val label = stringResource(R.string.room_loading)
                Box(Modifier.fillMaxWidth().padding(24.dp), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(color = c.accent, strokeWidth = 3.dp, modifier = Modifier.size(28.dp).semantics { contentDescription = label })
                }
            } else {
                members.forEach { m ->
                    MemberRow(
                        m, isSelf = m.userId == selfUserId,
                        onVerify = { actions.onVerify(m) },
                        onMessage = { actions.onMessage(m) },
                        onIgnore = { actions.onIgnore(m) },
                    )
                }
            }
        }
    }
}

@Composable
private fun MemberRow(m: MemberUi, isSelf: Boolean, onVerify: () -> Unit, onMessage: () -> Unit, onIgnore: () -> Unit) {
    val c = MaterialTheme.lumenColors
    var menu by remember { mutableStateOf(false) }
    Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(start = 16.dp, end = 4.dp, top = 6.dp, bottom = 6.dp), verticalAlignment = Alignment.CenterVertically) {
        Avatar(m.name, size = 40.dp)
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(m.name, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium, color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(
                listOfNotNull(
                    m.userId,
                    if (m.invited) stringResource(R.string.member_invited) else null,
                    if (m.ignored) stringResource(R.string.member_blocked) else null,
                ).joinToString(" · "),
                style = MaterialTheme.typography.labelMedium, color = c.textMuted, maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
        }
        when (m.verified) {
            true -> Row(
                Modifier.clip(CircleShape).background(c.successSoft).padding(horizontal = 8.dp, vertical = 3.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(painterResource(R.drawable.ic_lucide_shield_check), null, tint = c.success, modifier = Modifier.size(14.dp))
                Spacer(Modifier.width(4.dp))
                Text(stringResource(R.string.member_verified), style = MaterialTheme.typography.labelSmall, color = c.success)
            }
            false -> Icon(painterResource(R.drawable.ic_lucide_shield), stringResource(R.string.member_not_verified), tint = c.textSubtle, modifier = Modifier.size(18.dp))
            null -> Unit
        }
        if (isSelf) {
            Spacer(Modifier.width(12.dp))
        } else {
            IconButton(onClick = { menu = true }) { Icon(painterResource(R.drawable.ic_lucide_more_horizontal), stringResource(R.string.member_actions, m.name)) }
            DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                DropdownMenuItem(text = { Text(stringResource(R.string.member_message)) }, onClick = { menu = false; onMessage() })
                if (m.verified == false) DropdownMenuItem(text = { Text(stringResource(R.string.member_verify)) }, onClick = { menu = false; onVerify() })
                DropdownMenuItem(
                    text = { Text(stringResource(if (m.ignored) R.string.member_unblock else R.string.member_block)) },
                    onClick = { menu = false; onIgnore() },
                )
            }
        }
    }
}
