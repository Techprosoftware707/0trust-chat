package io.lumen.secure.ui.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
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
import io.lumen.secure.ui.nav.NavViewModel
import io.lumen.secure.ui.theme.lumenColors
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.matrix.rustcomponents.sdk.UserProfile

@Composable
fun NewChatScreen(graph: AppGraph, session: MatrixSession, nav: NavViewModel) {
    var group by rememberSaveable { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val c = MaterialTheme.lumenColors
    DetailScaffold(stringResource(R.string.new_chat_title), onBack = { nav.pop() }) {
        SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth().padding(16.dp)) {
            SegmentedButton(selected = !group, onClick = { group = false }, shape = SegmentedButtonDefaults.itemShape(0, 2)) { Text(stringResource(R.string.new_chat_direct)) }
            SegmentedButton(selected = group, onClick = { group = true }, shape = SegmentedButtonDefaults.itemShape(1, 2)) { Text(stringResource(R.string.new_chat_group)) }
        }
        Text(stringResource(R.string.new_chat_encrypted_note), style = MaterialTheme.typography.bodySmall, color = c.textMuted, modifier = Modifier.padding(horizontal = 16.dp))
        if (error) Banner(stringResource(R.string.new_chat_failed), BannerKind.DANGER, R.drawable.ic_lucide_circle_alert)
        if (!group) {
            UserPicker(session) { userId ->
                busy = true
                scope.launch {
                    try {
                        nav.openRoom(DirectChats.open(session, userId))
                    } catch (e: Exception) {
                        LumenLog.w("newchat", "DM failed", e)
                        error = true
                    } finally {
                        busy = false
                    }
                }
            }
        } else {
            var name by rememberSaveable { mutableStateOf("") }
            val invites = remember { mutableStateListOf<String>() }
            OutlinedTextField(name, { name = it }, singleLine = true, label = { Text(stringResource(R.string.new_chat_group_name)) },
                modifier = Modifier.fillMaxWidth().padding(16.dp))
            UserPicker(session) { if (it !in invites) invites += it }
            invites.forEach { id ->
                Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(id, modifier = Modifier.weight(1f), color = c.text)
                    IconButton(onClick = { invites.remove(id) }) { Icon(painterResource(R.drawable.ic_lucide_x), stringResource(R.string.action_remove)) }
                }
            }
            Button(
                enabled = !busy && name.isNotBlank(),
                onClick = {
                    busy = true
                    scope.launch {
                        try {
                            nav.openRoom(DirectChats.createGroup(session, name, null, invites.toList()))
                        } catch (e: Exception) {
                            LumenLog.w("newchat", "group failed", e)
                            error = true
                        } finally {
                            busy = false
                        }
                    }
                },
                modifier = Modifier.fillMaxWidth().padding(16.dp),
            ) { Text(stringResource(R.string.new_chat_create_group)) }
        }
    }
}

/** Search the server's user directory, or enter a full Matrix ID. */
@Composable
private fun UserPicker(session: MatrixSession, onPick: (String) -> Unit) {
    val c = MaterialTheme.lumenColors
    var term by rememberSaveable { mutableStateOf("") }
    var results by remember { mutableStateOf<List<UserProfile>>(emptyList()) }
    LaunchedEffect(term) {
        results = emptyList()
        if (term.trim().length < 2) return@LaunchedEffect
        delay(300)
        results = try {
            session.client.searchUsers(term.trim(), 20u).results.filter { it.userId != session.userId }
        } catch (e: Exception) {
            LumenLog.w("newchat", "user search failed", e)
            emptyList()
        }
    }
    OutlinedTextField(
        term, { term = it }, singleLine = true,
        label = { Text(stringResource(R.string.new_chat_search_users)) },
        placeholder = { Text("@name:example.com") },
        leadingIcon = { Icon(painterResource(R.drawable.ic_lucide_search), null) },
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp),
    )
    Column(verticalArrangement = Arrangement.spacedBy(0.dp)) {
        val typed = term.trim()
        if (MatrixIds.isUserId(typed) && results.none { it.userId == typed }) {
            UserRow(typed, null) { onPick(typed) }
        }
        results.forEach { u -> UserRow(u.userId, u.displayName) { onPick(u.userId) } }
        if (term.trim().length >= 2 && results.isEmpty() && !MatrixIds.isUserId(typed)) {
            Text(stringResource(R.string.new_chat_no_users), style = MaterialTheme.typography.bodySmall, color = c.textMuted, modifier = Modifier.padding(16.dp))
        }
    }
}

@Composable
private fun UserRow(userId: String, name: String?, onClick: () -> Unit) {
    val c = MaterialTheme.lumenColors
    Row(Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 16.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
        Avatar(name ?: userId, size = 36.dp)
        Spacer(Modifier.width(12.dp))
        Column {
            Text(name ?: userId, style = MaterialTheme.typography.bodyLarge, color = c.text)
            if (name != null) Text(userId, style = MaterialTheme.typography.labelMedium, color = c.textMuted)
        }
    }
}
