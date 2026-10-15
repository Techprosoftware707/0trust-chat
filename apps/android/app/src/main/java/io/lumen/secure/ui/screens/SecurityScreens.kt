package io.lumen.secure.ui.screens

import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.os.Build
import android.os.PersistableBundle
import android.text.format.DateUtils
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import io.lumen.secure.AppGraph
import io.lumen.secure.R
import io.lumen.secure.log.LumenLog
import io.lumen.secure.matrix.EncryptionController
import io.lumen.secure.matrix.MatrixSession
import io.lumen.secure.matrix.RecoverySetup
import io.lumen.secure.matrix.VerificationUi
import io.lumen.secure.net.DeleteResult
import io.lumen.secure.net.DeviceInfo
import io.lumen.secure.net.DevicesApi
import io.lumen.secure.net.UiaChallenge
import io.lumen.secure.ui.components.Banner
import io.lumen.secure.ui.components.BannerKind
import io.lumen.secure.ui.components.CenteredState
import io.lumen.secure.ui.components.LogoMark
import io.lumen.secure.ui.components.SectionHeader
import io.lumen.secure.ui.components.SettingRow
import io.lumen.secure.ui.nav.NavViewModel
import io.lumen.secure.ui.theme.MonoFamily
import io.lumen.secure.ui.theme.lumenColors
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.matrix.rustcomponents.sdk.BackupState
import org.matrix.rustcomponents.sdk.RecoveryState
import org.matrix.rustcomponents.sdk.VerificationState

/** What the app protects and what it does not (no post-quantum claims; threat-model.md). */
@Composable
fun SecurityScreen(graph: AppGraph, nav: NavViewModel) {
    val c = MaterialTheme.lumenColors
    val strongBox = graph.keyWrapper.strongBoxBacked
    DetailScaffold(stringResource(R.string.security_title), onBack = { nav.pop() }) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            listOf(
                R.string.security_e2ee_title to R.string.security_e2ee_body,
                R.string.security_server_title to R.string.security_server_body,
                R.string.security_devices_title to R.string.security_devices_body,
                R.string.security_storage_title to R.string.security_storage_body,
                R.string.security_calls_title to R.string.security_calls_body,
                R.string.security_push_title to R.string.security_push_body,
                R.string.security_lock_title to R.string.security_lock_body,
                R.string.security_limits_title to R.string.security_limits_body,
            ).forEach { (t, b) ->
                Text(stringResource(t), style = MaterialTheme.typography.titleMedium, color = c.text)
                Text(stringResource(b), style = MaterialTheme.typography.bodyMedium, color = c.textMuted)
            }
            Text(
                stringResource(
                    when (strongBox) {
                        true -> R.string.security_keystore_strongbox
                        false -> R.string.security_keystore_tee
                        null -> R.string.security_keystore_unknown
                    },
                ),
                style = MaterialTheme.typography.bodySmall, color = c.textSubtle,
            )
        }
    }
}

@Composable
fun EncryptionScreen(graph: AppGraph, nav: NavViewModel) {
    val enc by graph.encryption.collectAsState()
    val e = enc ?: return
    val c = MaterialTheme.lumenColors
    val recovery by e.recovery.collectAsState()
    val backup by e.backup.collectAsState()
    val verification by e.verification.collectAsState()
    val setup by e.setup.collectAsState()
    val scope = rememberCoroutineScope()
    var recoverOpen by remember { mutableStateOf(false) }

    DetailScaffold(stringResource(R.string.encryption_title), onBack = { nav.pop() }) {
        SectionHeader(stringResource(R.string.encryption_this_device))
        when (verification) {
            VerificationState.VERIFIED -> SettingRow(stringResource(R.string.encryption_device_verified), null, R.drawable.ic_lucide_shield_check)
            VerificationState.UNVERIFIED -> {
                SettingRow(stringResource(R.string.encryption_device_unverified), stringResource(R.string.encryption_device_unverified_desc), R.drawable.ic_lucide_shield_alert)
                Row(Modifier.padding(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(onClick = { e.verifyThisDevice() }) { Text(stringResource(R.string.encryption_verify_with_device)) }
                    OutlinedButton(onClick = { recoverOpen = true }) { Text(stringResource(R.string.encryption_use_recovery_key)) }
                }
            }
            VerificationState.UNKNOWN -> SettingRow(stringResource(R.string.encryption_device_unknown), null, R.drawable.ic_lucide_shield)
        }

        SectionHeader(stringResource(R.string.encryption_recovery))
        Text(stringResource(R.string.encryption_recovery_explain), style = MaterialTheme.typography.bodyMedium, color = c.textMuted, modifier = Modifier.padding(horizontal = 16.dp))
        SettingRow(
            stringResource(
                when (recovery) {
                    RecoveryState.ENABLED -> R.string.recovery_enabled
                    RecoveryState.DISABLED -> R.string.recovery_disabled
                    RecoveryState.INCOMPLETE -> R.string.recovery_incomplete
                    RecoveryState.UNKNOWN -> R.string.recovery_unknown
                },
            ),
            stringResource(if (backup == BackupState.ENABLED) R.string.backup_enabled else R.string.backup_not_enabled),
            R.drawable.ic_lucide_key_round,
        )
        when (val st = setup) {
            is RecoverySetup.Working -> Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                CircularProgressIndicator(Modifier.size(20.dp))
                Spacer(Modifier.width(12.dp))
                Text(
                    if (st.total != null && st.total > 0) stringResource(R.string.recovery_backing_up, st.backedUp ?: 0, st.total) else stringResource(R.string.recovery_working),
                    color = c.textMuted,
                )
            }
            is RecoverySetup.Error -> Banner(stringResource(R.string.recovery_error), BannerKind.DANGER, R.drawable.ic_lucide_circle_alert)
            else -> Unit
        }
        Row(Modifier.padding(16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            when (recovery) {
                RecoveryState.DISABLED -> Button(onClick = { e.enableRecovery() }) { Text(stringResource(R.string.recovery_set_up)) }
                RecoveryState.INCOMPLETE -> Button(onClick = { recoverOpen = true }) { Text(stringResource(R.string.encryption_use_recovery_key)) }
                RecoveryState.ENABLED -> OutlinedButton(onClick = { e.resetRecoveryKey() }) { Text(stringResource(R.string.recovery_change_key)) }
                RecoveryState.UNKNOWN -> Unit
            }
        }
    }

    (setup as? RecoverySetup.ShowKey)?.let { RecoveryKeyDialog(it.key) { e.keyStored() } }
    if (recoverOpen) RecoverDialog(e) { recoverOpen = false }
}

/** The recovery key is shown once; the user confirms by typing its last four characters. */
@Composable
private fun RecoveryKeyDialog(key: String, onStored: () -> Unit) {
    val context = LocalContext.current
    var confirm by remember { mutableStateOf("") }
    val tail = key.filter { !it.isWhitespace() }.takeLast(4)
    AlertDialog(
        onDismissRequest = {},
        title = { Text(stringResource(R.string.recovery_key_title)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(stringResource(R.string.recovery_key_body))
                Surface(color = MaterialTheme.lumenColors.surface2, shape = MaterialTheme.shapes.small) {
                    Text(key, fontFamily = MonoFamily, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(12.dp))
                }
                TextButton(onClick = {
                    val clip = ClipData.newPlainText("recovery key", key)
                    // Android 13+: mark as sensitive so the clipboard preview does not show it.
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                        clip.description.extras = PersistableBundle().apply { putBoolean(ClipDescription.EXTRA_IS_SENSITIVE, true) }
                    }
                    context.getSystemService(ClipboardManager::class.java).setPrimaryClip(clip)
                }) { Text(stringResource(R.string.recovery_key_copy)) }
                OutlinedTextField(confirm, { confirm = it.trim() }, singleLine = true, label = { Text(stringResource(R.string.recovery_key_confirm)) })
            }
        },
        confirmButton = {
            TextButton(enabled = confirm.equals(tail, ignoreCase = false), onClick = onStored) { Text(stringResource(R.string.recovery_key_saved)) }
        },
    )
}

@Composable
private fun RecoverDialog(e: EncryptionController, onDone: () -> Unit) {
    val scope = rememberCoroutineScope()
    var key by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var failed by remember { mutableStateOf(false) }
    AlertDialog(
        onDismissRequest = onDone,
        title = { Text(stringResource(R.string.encryption_use_recovery_key)) },
        text = {
            Column {
                Text(stringResource(R.string.recover_body))
                OutlinedTextField(key, { key = it }, label = { Text(stringResource(R.string.recover_key_label)) }, isError = failed,
                    supportingText = if (failed) { { Text(stringResource(R.string.recover_failed)) } } else null)
            }
        },
        confirmButton = {
            TextButton(enabled = !busy && key.isNotBlank(), onClick = {
                busy = true
                scope.launch {
                    try {
                        e.recover(key)
                        key = ""
                        onDone()
                    } catch (ex: Exception) {
                        LumenLog.w("crypto", "recover failed", ex)
                        failed = true
                    } finally {
                        busy = false
                    }
                }
            }) { Text(stringResource(R.string.action_continue)) }
        },
        dismissButton = { TextButton(onClick = onDone) { Text(stringResource(R.string.action_cancel)) } },
    )
}

/** SAS emoji verification (own devices and contacts), shown wherever the app is. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun VerificationDialog(e: EncryptionController) {
    val state by e.sas.collectAsState()
    val c = MaterialTheme.lumenColors
    when (val s = state) {
        VerificationUi.Idle -> Unit
        is VerificationUi.IncomingRequest -> AlertDialog(
            onDismissRequest = { e.cancel() },
            title = { Text(stringResource(R.string.verify_incoming_title)) },
            text = { Text(stringResource(R.string.verify_incoming_body, s.fromName ?: s.fromUserId, s.deviceName ?: s.deviceId)) },
            confirmButton = { TextButton(onClick = { e.acceptIncoming(s) }) { Text(stringResource(R.string.action_verify)) } },
            dismissButton = { TextButton(onClick = { e.cancel() }) { Text(stringResource(R.string.action_ignore)) } },
        )
        is VerificationUi.Waiting, VerificationUi.Starting -> AlertDialog(
            onDismissRequest = {},
            title = { Text(stringResource(R.string.verify_title)) },
            text = {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    CircularProgressIndicator(Modifier.size(20.dp))
                    Spacer(Modifier.width(12.dp))
                    Text(stringResource(if (s is VerificationUi.Waiting) R.string.verify_waiting else R.string.verify_starting))
                }
            },
            confirmButton = { TextButton(onClick = { e.cancel() }) { Text(stringResource(R.string.action_cancel)) } },
        )
        is VerificationUi.Emojis -> AlertDialog(
            onDismissRequest = {},
            title = { Text(stringResource(R.string.verify_compare_title)) },
            text = {
                Column {
                    Text(stringResource(R.string.verify_compare_body))
                    Spacer(Modifier.height(12.dp))
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        s.emojis.forEach { em ->
                            Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.width(64.dp)) {
                                Text(em.symbol, style = MaterialTheme.typography.headlineMedium)
                                Text(em.description, style = MaterialTheme.typography.labelSmall, color = c.textMuted, textAlign = TextAlign.Center)
                            }
                        }
                    }
                }
            },
            confirmButton = { TextButton(onClick = { e.confirmMatch() }) { Text(stringResource(R.string.verify_match)) } },
            dismissButton = { TextButton(onClick = { e.reportMismatch() }) { Text(stringResource(R.string.verify_no_match), color = c.danger) } },
        )
        is VerificationUi.Decimals -> AlertDialog(
            onDismissRequest = {},
            title = { Text(stringResource(R.string.verify_compare_title)) },
            text = { Text(s.values.joinToString("  "), style = MaterialTheme.typography.headlineSmall, fontFamily = MonoFamily) },
            confirmButton = { TextButton(onClick = { e.confirmMatch() }) { Text(stringResource(R.string.verify_match)) } },
            dismissButton = { TextButton(onClick = { e.reportMismatch() }) { Text(stringResource(R.string.verify_no_match), color = c.danger) } },
        )
        VerificationUi.Done -> AlertDialog(
            onDismissRequest = { e.dismiss() },
            title = { Text(stringResource(R.string.verify_done_title)) },
            text = { Text(stringResource(R.string.verify_done_body)) },
            confirmButton = { TextButton(onClick = { e.dismiss() }) { Text(stringResource(R.string.action_close)) } },
        )
        is VerificationUi.Cancelled, VerificationUi.Failed -> AlertDialog(
            onDismissRequest = { e.dismiss() },
            title = { Text(stringResource(R.string.verify_failed_title)) },
            text = { Text(stringResource(R.string.verify_failed_body)) },
            confirmButton = { TextButton(onClick = { e.dismiss() }) { Text(stringResource(R.string.action_close)) } },
        )
    }
}

/** Devices (GET /devices), removal with user-interactive auth through the SSO fallback page. */
@Composable
fun DevicesScreen(graph: AppGraph, session: MatrixSession, nav: NavViewModel) {
    val context = LocalContext.current
    val c = MaterialTheme.lumenColors
    val scope = rememberCoroutineScope()
    val api = remember(session) { DevicesApi(session.homeserverUrl.trimEnd('/')) { session.client.session().accessToken } }
    val devices = remember { mutableStateListOf<DeviceInfo>() }
    var loading by remember { mutableStateOf(true) }
    var failed by remember { mutableStateOf(false) }
    var reload by remember { mutableIntStateOf(0) }
    var pending by remember { mutableStateOf<Pair<DeviceInfo, UiaChallenge>?>(null) }
    var confirm by remember { mutableStateOf<DeviceInfo?>(null) }
    val enc by graph.encryption.collectAsState()
    val thisVerified by (enc?.verification ?: remember { kotlinx.coroutines.flow.MutableStateFlow(VerificationState.UNKNOWN) }).collectAsState()

    LaunchedEffect(reload) {
        loading = true
        failed = false
        try {
            val list = withContext(Dispatchers.IO) { api.list() }
            devices.clear()
            devices.addAll(list)
        } catch (e: Exception) {
            LumenLog.w("devices", "list failed", e)
            failed = true
        }
        loading = false
    }

    fun delete(d: DeviceInfo, session: String?) {
        scope.launch {
            val r = try {
                withContext(Dispatchers.IO) { api.delete(d.deviceId, session) }
            } catch (e: Exception) {
                DeleteResult.Failed(0)
            }
            when (r) {
                DeleteResult.Deleted -> { pending = null; reload++ }
                is DeleteResult.NeedsAuth -> {
                    pending = d to r.challenge
                    if (r.challenge.ssoFallback && session == null) openInBrowser(context, api.ssoFallbackUrl(r.challenge.session))
                }
                is DeleteResult.Failed -> { pending = null; failed = true }
            }
        }
    }

    DetailScaffold(stringResource(R.string.devices_title), onBack = { nav.pop() }) {
        Text(stringResource(R.string.devices_explain), style = MaterialTheme.typography.bodyMedium, color = c.textMuted, modifier = Modifier.padding(16.dp))
        if (failed) Banner(stringResource(R.string.devices_failed), BannerKind.DANGER, R.drawable.ic_lucide_circle_alert, stringResource(R.string.action_try_again), { reload++ })
        pending?.let { (d, ch) ->
            Banner(
                stringResource(if (ch.ssoFallback) R.string.devices_confirm_browser else R.string.devices_password_needed, d.displayName ?: d.deviceId),
                BannerKind.INFO, R.drawable.ic_lucide_external_link,
                actionLabel = if (ch.ssoFallback) stringResource(R.string.action_continue) else null,
                onAction = if (ch.ssoFallback) ({ delete(d, ch.session) }) else null,
                secondaryLabel = stringResource(R.string.action_cancel), onSecondary = { pending = null },
            )
        }
        if (loading) CenteredState(stringResource(R.string.devices_loading), loading = true)
        devices.forEach { d ->
            val current = d.deviceId == session.deviceId
            val lastSeen = d.lastSeenTs?.let { DateUtils.getRelativeTimeSpanString(it).toString() }
            SettingRow(
                title = (d.displayName ?: d.deviceId) + if (current) " · " + stringResource(R.string.devices_this) else "",
                subtitle = listOfNotNull(
                    d.deviceId,
                    lastSeen?.let { stringResource(R.string.devices_last_seen, it) },
                    if (current) stringResource(
                        when (thisVerified) {
                            VerificationState.VERIFIED -> R.string.encryption_device_verified
                            VerificationState.UNVERIFIED -> R.string.encryption_device_unverified
                            VerificationState.UNKNOWN -> R.string.encryption_device_unknown
                        },
                    ) else stringResource(R.string.devices_verification_unavailable),
                ).joinToString(" · "),
                icon = R.drawable.ic_lucide_smartphone,
                trailing = if (!current) ({
                    TextButton(onClick = { confirm = d }) { Text(stringResource(R.string.devices_remove), color = c.danger) }
                }) else null,
            )
        }
    }
    confirm?.let { d ->
        AlertDialog(
            onDismissRequest = { confirm = null },
            title = { Text(stringResource(R.string.devices_remove_title)) },
            text = { Text(stringResource(R.string.devices_remove_body, d.displayName ?: d.deviceId)) },
            confirmButton = { TextButton(onClick = { confirm = null; delete(d, null) }) { Text(stringResource(R.string.devices_remove), color = c.danger) } },
            dismissButton = { TextButton(onClick = { confirm = null }) { Text(stringResource(R.string.action_cancel)) } },
        )
    }
}

@Composable
fun BlockedUsersScreen(session: MatrixSession, nav: NavViewModel) {
    val c = MaterialTheme.lumenColors
    val scope = rememberCoroutineScope()
    val users = remember { mutableStateListOf<String>() }
    var reload by remember { mutableIntStateOf(0) }
    LaunchedEffect(reload) {
        try {
            val list = session.client.ignoredUsers()
            users.clear()
            users.addAll(list)
        } catch (e: Exception) {
            LumenLog.w("blocked", "list failed", e)
        }
    }
    DetailScaffold(stringResource(R.string.blocked_title), onBack = { nav.pop() }) {
        Text(stringResource(R.string.blocked_explain), style = MaterialTheme.typography.bodyMedium, color = c.textMuted, modifier = Modifier.padding(16.dp))
        if (users.isEmpty()) Text(stringResource(R.string.blocked_empty), color = c.textSubtle, modifier = Modifier.padding(16.dp))
        users.forEach { u ->
            SettingRow(u, null, R.drawable.ic_lucide_user_x, trailing = {
                TextButton(onClick = { scope.launch { try { session.client.unignoreUser(u); reload++ } catch (_: Exception) {} } }) {
                    Text(stringResource(R.string.member_unblock))
                }
            })
        }
    }
}

@Composable
fun LockScreen(onUnlock: () -> Unit) {
    val c = MaterialTheme.lumenColors
    Surface(Modifier.fillMaxSize(), color = c.bg) {
        Column(
            Modifier.fillMaxSize().safeDrawingPadding().padding(32.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            LogoMark(64.dp)
            Spacer(Modifier.height(24.dp))
            Icon(painterResource(R.drawable.ic_lucide_lock), null, tint = c.accent)
            Spacer(Modifier.height(8.dp))
            Text(stringResource(R.string.lock_title), style = MaterialTheme.typography.titleLarge, color = c.text)
            Spacer(Modifier.height(24.dp))
            Button(onClick = onUnlock) { Text(stringResource(R.string.lock_unlock)) }
            Spacer(Modifier.height(24.dp))
            Text(stringResource(R.string.lock_limits), style = MaterialTheme.typography.bodySmall, color = c.textSubtle, textAlign = TextAlign.Center)
        }
    }
}
