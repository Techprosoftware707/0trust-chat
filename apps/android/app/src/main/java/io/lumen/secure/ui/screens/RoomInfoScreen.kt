package io.lumen.secure.ui.screens

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
import io.lumen.secure.ui.components.CenteredState
import io.lumen.secure.ui.components.SectionHeader
import io.lumen.secure.ui.components.SettingRow
import io.lumen.secure.ui.nav.NavViewModel
import io.lumen.secure.ui.nav.Screen
import io.lumen.secure.ui.theme.lumenColors
import kotlinx.coroutines.launch
import org.matrix.rustcomponents.sdk.MembershipState
import org.matrix.rustcomponents.sdk.RoomMember

private data class MemberUi(val userId: String, val name: String, val invited: Boolean, val ignored: Boolean, val verified: Boolean?)

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

    DetailScaffold(stringResource(R.string.room_info_title), onBack = { nav.pop() }) {
        Column(Modifier.fillMaxWidth().padding(16.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Avatar(roomName.ifEmpty { "?" }, size = 64.dp)
            Spacer(Modifier.width(8.dp))
            Text(roomName, style = MaterialTheme.typography.titleLarge, color = c.text)
            topic?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = c.textMuted) }
        }
        if (!encrypted) Banner(stringResource(R.string.room_not_encrypted_warning), BannerKind.WARNING, R.drawable.ic_lucide_shield_alert)
        if (error) Banner(stringResource(R.string.room_action_failed), BannerKind.DANGER, R.drawable.ic_lucide_circle_alert)
        SettingRow(stringResource(R.string.room_invite), icon = R.drawable.ic_lucide_user_plus, onClick = { inviteOpen = true })
        SettingRow(stringResource(R.string.room_leave), icon = R.drawable.ic_lucide_log_out, onClick = { confirmLeave = true })
        SectionHeader(stringResource(R.string.room_members, members?.size ?: 0))
        val list = members
        if (list == null) {
            CenteredState(stringResource(R.string.room_loading), loading = true)
        } else {
            list.forEach { m ->
                MemberRow(
                    m, isSelf = m.userId == session.userId,
                    onVerify = { encryption?.verifyUser(m.userId) },
                    onMessage = { scope.launch { try { nav.openRoom(DirectChats.open(session, m.userId)) } catch (e: Exception) { error = true } } },
                    onIgnore = {
                        scope.launch {
                            try {
                                if (m.ignored) session.client.unignoreUser(m.userId) else session.client.ignoreUser(m.userId)
                                reload++
                            } catch (e: Exception) {
                                error = true
                            }
                        }
                    },
                )
            }
        }
    }

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

@Composable
private fun MemberRow(m: MemberUi, isSelf: Boolean, onVerify: () -> Unit, onMessage: () -> Unit, onIgnore: () -> Unit) {
    val c = MaterialTheme.lumenColors
    var menu by remember { mutableStateOf(false) }
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        Avatar(m.name, size = 36.dp)
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(m.name, style = MaterialTheme.typography.bodyLarge, color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
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
            true -> Icon(painterResource(R.drawable.ic_lucide_shield_check), stringResource(R.string.member_verified), tint = c.success)
            false -> Icon(painterResource(R.drawable.ic_lucide_shield), stringResource(R.string.member_not_verified), tint = c.textSubtle)
            null -> Unit
        }
        if (!isSelf) {
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
