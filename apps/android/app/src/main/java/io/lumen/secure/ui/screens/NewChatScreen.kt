package io.lumen.secure.ui.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.InputChip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import io.lumen.secure.ui.components.PrimaryButton
import io.lumen.secure.ui.components.SearchField
import io.lumen.secure.ui.components.SettingsGroup
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Icon
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

data class UserHit(val userId: String, val displayName: String?)

class NewChatActions(
    val onBack: () -> Unit = {},
    val onOpenDirect: (userId: String) -> Unit = {},
    val onCreateGroup: (name: String, invites: List<String>) -> Unit = { _, _ -> },
    /** Searches the server's user directory (the caller filters out the signed-in user). */
    val search: suspend (String) -> List<UserHit> = { emptyList() },
)

@Composable
fun NewChatScreen(graph: AppGraph, session: MatrixSession, nav: NavViewModel) {
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    NewChatContent(
        busy = busy,
        error = error,
        actions = NewChatActions(
            onBack = { nav.pop() },
            onOpenDirect = { userId ->
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
            },
            onCreateGroup = { name, invites ->
                busy = true
                scope.launch {
                    try {
                        nav.openRoom(DirectChats.createGroup(session, name, null, invites))
                    } catch (e: Exception) {
                        LumenLog.w("newchat", "group failed", e)
                        error = true
                    } finally {
                        busy = false
                    }
                }
            },
            search = { term ->
                try {
                    session.client.searchUsers(term, 20u).results.filter { it.userId != session.userId }.map { UserHit(it.userId, it.displayName) }
                } catch (e: Exception) {
                    LumenLog.w("newchat", "user search failed", e)
                    emptyList()
                }
            },
        ),
    )
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun NewChatContent(busy: Boolean, error: Boolean, actions: NewChatActions, initialGroup: Boolean = false, initialTerm: String = "") {
    var group by rememberSaveable { mutableStateOf(initialGroup) }
    val c = MaterialTheme.lumenColors
    DetailScaffold(stringResource(R.string.new_chat_title), onBack = actions.onBack) {
        SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)) {
            SegmentedButton(selected = !group, onClick = { group = false }, shape = SegmentedButtonDefaults.itemShape(0, 2)) { Text(stringResource(R.string.new_chat_direct)) }
            SegmentedButton(selected = group, onClick = { group = true }, shape = SegmentedButtonDefaults.itemShape(1, 2)) { Text(stringResource(R.string.new_chat_group)) }
        }
        Row(Modifier.padding(horizontal = 20.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(painterResource(R.drawable.ic_lucide_lock), null, tint = c.success, modifier = Modifier.size(14.dp))
            Spacer(Modifier.width(8.dp))
            Text(stringResource(R.string.new_chat_encrypted_note), style = MaterialTheme.typography.bodySmall, color = c.textMuted)
        }
        if (error) Banner(stringResource(R.string.new_chat_failed), BannerKind.DANGER, R.drawable.ic_lucide_circle_alert)
        if (!group) {
            UserPicker(actions.search, initialTerm) { userId -> actions.onOpenDirect(userId) }
        } else {
            var name by rememberSaveable { mutableStateOf("") }
            val invites = remember { mutableStateListOf<String>() }
            OutlinedTextField(
                name, { name = it }, singleLine = true, shape = MaterialTheme.shapes.medium,
                label = { Text(stringResource(R.string.new_chat_group_name)) },
                modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
            )
            if (invites.isNotEmpty()) {
                FlowRow(Modifier.padding(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    invites.forEach { id ->
                        InputChip(
                            selected = false, onClick = { invites.remove(id) },
                            label = { Text(id, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                            avatar = { Avatar(id, size = 24.dp) },
                            trailingIcon = { Icon(painterResource(R.drawable.ic_lucide_x), stringResource(R.string.action_remove), modifier = Modifier.size(16.dp)) },
                            shape = CircleShape,
                        )
                    }
                }
            }
            UserPicker(actions.search, initialTerm) { if (it !in invites) invites += it }
            PrimaryButton(
                text = stringResource(R.string.new_chat_create_group),
                onClick = { actions.onCreateGroup(name, invites.toList()) },
                enabled = busy || name.isNotBlank(),
                loading = busy,
                icon = R.drawable.ic_lucide_lock,
                modifier = Modifier.fillMaxWidth().padding(16.dp),
            )
        }
    }
}

/** Search the server's user directory, or enter a full Matrix ID. */
@Composable
private fun UserPicker(search: suspend (String) -> List<UserHit>, initialTerm: String, onPick: (String) -> Unit) {
    val c = MaterialTheme.lumenColors
    var term by rememberSaveable { mutableStateOf(initialTerm) }
    var results by remember { mutableStateOf<List<UserHit>>(emptyList()) }
    LaunchedEffect(term) {
        results = emptyList()
        if (term.trim().length < 2) return@LaunchedEffect
        delay(300)
        results = search(term.trim())
    }
    SearchField(
        term, { term = it }, stringResource(R.string.new_chat_search_users),
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
    )
    val typed = term.trim()
    val showTyped = MatrixIds.isUserId(typed) && results.none { it.userId == typed }
    if (showTyped || results.isNotEmpty()) {
        SettingsGroup {
            if (showTyped) UserRow(typed, null) { onPick(typed) }
            results.forEach { u -> UserRow(u.userId, u.displayName) { onPick(u.userId) } }
        }
    }
    if (typed.length >= 2 && results.isEmpty() && !MatrixIds.isUserId(typed)) {
        Text(stringResource(R.string.new_chat_no_users), style = MaterialTheme.typography.bodySmall, color = c.textMuted, modifier = Modifier.padding(horizontal = 20.dp, vertical = 12.dp))
    }
}

@Composable
private fun UserRow(userId: String, name: String?, onClick: () -> Unit) {
    val c = MaterialTheme.lumenColors
    Row(
        Modifier.fillMaxWidth().heightIn(min = 56.dp).clickable(onClick = onClick).padding(horizontal = 16.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Avatar(name ?: userId, size = 40.dp)
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(name ?: userId, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium, color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (name != null) Text(userId, style = MaterialTheme.typography.labelMedium, color = c.textMuted, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        Icon(painterResource(R.drawable.ic_lucide_chevron_right), null, tint = c.textSubtle, modifier = Modifier.size(18.dp))
    }
}
