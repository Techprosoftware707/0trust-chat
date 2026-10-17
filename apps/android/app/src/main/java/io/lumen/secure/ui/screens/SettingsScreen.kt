package io.lumen.secure.ui.screens

import android.content.Intent
import androidx.core.net.toUri
import android.os.Build
import android.provider.Settings as SystemSettings
import androidx.biometric.BiometricManager
import androidx.compose.foundation.clickable
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Icon
import androidx.compose.material3.Surface
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.style.TextOverflow
import io.lumen.secure.ui.components.Avatar
import io.lumen.secure.ui.components.RowEnd
import io.lumen.secure.ui.components.SettingsGroup
import io.lumen.secure.ui.theme.brandWash
import io.lumen.secure.ui.theme.isDark
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import io.lumen.secure.AppGraph
import io.lumen.secure.BuildConfig
import io.lumen.secure.R
import io.lumen.secure.core.notifications.NotificationPreview
import io.lumen.secure.core.security.AutoLockTimeout
import io.lumen.secure.data.ReceiptMode
import io.lumen.secure.data.UserSettings
import io.lumen.secure.matrix.MatrixSession
import io.lumen.secure.push.PushStatus
import io.lumen.secure.sync.KeepConnectedService
import io.lumen.secure.ui.MainActivity
import io.lumen.secure.ui.components.SettingRow
import io.lumen.secure.ui.components.SwitchRow
import io.lumen.secure.ui.nav.NavViewModel
import io.lumen.secure.ui.nav.Screen
import io.lumen.secure.ui.theme.lumenColors
import kotlinx.coroutines.launch

data class SettingsUiState(
    val userId: String,
    val deviceId: String,
    val settings: UserSettings = UserSettings(),
    val push: PushStatus = PushStatus.NOT_IN_BUILD,
    val accountUrl: String? = null,
    val privacyUrl: String? = null,
    val helpUrl: String? = null,
    val accountDeleteUrl: String? = null,
    val lockAvailable: Boolean = true,
    val askFullScreenIntent: Boolean = false,
)

class SettingsActions(
    val onBack: () -> Unit = {},
    val onOpenUrl: (String) -> Unit = {},
    val onNavigate: (Screen) -> Unit = {},
    /** Applies a settings change (and its side effects: app lock, the stay-connected service). */
    val onChange: (UserSettings) -> Unit = {},
    val onFullScreenIntentSettings: () -> Unit = {},
    val onSystemNotificationSettings: () -> Unit = {},
    val onSignOut: () -> Unit = {},
)

@Composable
fun SettingsScreen(graph: AppGraph, session: MatrixSession, nav: NavViewModel) {
    val context = LocalContext.current
    val s by graph.settings.state.collectAsState()
    val push by graph.push.status.collectAsState()
    val scope = rememberCoroutineScope()
    val server = remember { graph.serverInfo.load() }
    val lockAvailable = BiometricManager.from(context).canAuthenticate(MainActivity.lockAuthenticators()) == BiometricManager.BIOMETRIC_SUCCESS
    SettingsContent(
        state = SettingsUiState(
            userId = session.userId, deviceId = session.deviceId, settings = s, push = push,
            accountUrl = server?.lumen?.accountUrl, privacyUrl = server?.lumen?.privacyUrl, helpUrl = server?.lumen?.helpUrl,
            accountDeleteUrl = server?.lumen?.accountDeleteUrl, lockAvailable = lockAvailable,
            askFullScreenIntent = Build.VERSION.SDK_INT >= 34 && !graph.calls.canUseFullScreenIntent,
        ),
        actions = SettingsActions(
            onBack = { nav.pop() },
            onOpenUrl = { openInBrowser(context, it) },
            onNavigate = { nav.push(it) },
            onChange = { next ->
                val before = graph.settings.current
                graph.settings.update { next }
                if (next.keepConnected != before.keepConnected) {
                    if (next.keepConnected) KeepConnectedService.start(context) else KeepConnectedService.stop(context)
                }
                if (next.appLock != before.appLock || next.autoLock != before.autoLock) graph.appLock.applySettings()
            },
            onFullScreenIntentSettings = {
                context.startActivity(Intent(SystemSettings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, "package:${BuildConfig.APPLICATION_ID}".toUri()))
            },
            onSystemNotificationSettings = {
                context.startActivity(Intent(SystemSettings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(SystemSettings.EXTRA_APP_PACKAGE, context.packageName))
            },
            onSignOut = { scope.launch { graph.sessions.signOut() } },
        ),
    )
}

@Composable
fun SettingsContent(state: SettingsUiState, actions: SettingsActions) {
    val s = state.settings
    val c = MaterialTheme.lumenColors
    var confirmSignOut by remember { mutableStateOf(false) }
    var pickPreview by remember { mutableStateOf(false) }
    var pickReceipts by remember { mutableStateOf(false) }
    var pickTimeout by remember { mutableStateOf(false) }
    val lockAvailable = state.lockAvailable

    DetailScaffold(stringResource(R.string.settings_title), onBack = actions.onBack) {
        ProfileCard(state.userId, state.deviceId)
        SettingsGroup(stringResource(R.string.settings_account)) {
            state.accountUrl?.let { url ->
                SettingRow(
                    stringResource(R.string.settings_manage_account), stringResource(R.string.settings_manage_account_desc), R.drawable.ic_lucide_user,
                    onClick = { actions.onOpenUrl(url) }, end = RowEnd.EXTERNAL,
                )
            }
            SettingRow(stringResource(R.string.devices_title), stringResource(R.string.settings_devices_desc), R.drawable.ic_lucide_laptop, onClick = { actions.onNavigate(Screen.Devices) })
        }

        SettingsGroup(stringResource(R.string.settings_notifications)) {
            SettingRow(
                stringResource(R.string.settings_delivery),
                stringResource(
                    when (state.push) {
                        PushStatus.REGISTERED -> R.string.push_registered
                        PushStatus.REGISTERING -> R.string.push_registering
                        PushStatus.FAILED -> R.string.push_failed
                        PushStatus.NOT_IN_BUILD, PushStatus.NO_GATEWAY -> R.string.push_only_while_running
                    },
                ),
                R.drawable.ic_lucide_bell,
            )
            SettingRow(stringResource(R.string.settings_preview), stringResource(previewLabel(s.preview)), R.drawable.ic_lucide_eye_off, onClick = { pickPreview = true })
            SwitchRow(
                stringResource(R.string.settings_keep_connected), stringResource(R.string.settings_keep_connected_desc), s.keepConnected,
                icon = R.drawable.ic_lucide_refresh_cw,
            ) { on -> actions.onChange(s.copy(keepConnected = on)) }
            if (state.askFullScreenIntent) {
                SettingRow(
                    stringResource(R.string.settings_fsi), stringResource(R.string.settings_fsi_desc), R.drawable.ic_lucide_phone_incoming,
                    onClick = actions.onFullScreenIntentSettings, end = RowEnd.EXTERNAL,
                )
            }
            SettingRow(stringResource(R.string.settings_system_notifications), null, R.drawable.ic_lucide_settings, onClick = actions.onSystemNotificationSettings, end = RowEnd.EXTERNAL)
        }

        SettingsGroup(stringResource(R.string.settings_privacy)) {
            SettingRow(stringResource(R.string.settings_receipts), stringResource(receiptLabel(s.receipts)), R.drawable.ic_lucide_check_check, onClick = { pickReceipts = true })
            SwitchRow(stringResource(R.string.settings_typing), stringResource(R.string.settings_typing_desc), s.typing, icon = R.drawable.ic_lucide_message_circle) { on ->
                actions.onChange(s.copy(typing = on))
            }
            SettingRow(stringResource(R.string.blocked_title), null, R.drawable.ic_lucide_ban, onClick = { actions.onNavigate(Screen.Blocked) })
        }

        SettingsGroup(stringResource(R.string.settings_security)) {
            SettingRow(stringResource(R.string.encryption_title), stringResource(R.string.settings_encryption_desc), R.drawable.ic_lucide_key_round, onClick = { actions.onNavigate(Screen.Encryption) })
            SwitchRow(
                stringResource(R.string.settings_app_lock),
                stringResource(if (lockAvailable) R.string.settings_app_lock_desc else R.string.settings_app_lock_unavailable),
                s.appLock, enabled = lockAvailable || s.appLock, icon = R.drawable.ic_lucide_fingerprint,
            ) { on -> actions.onChange(s.copy(appLock = on)) }
            if (s.appLock) {
                SettingRow(stringResource(R.string.settings_auto_lock), stringResource(timeoutLabel(s.autoLock)), R.drawable.ic_lucide_clock, onClick = { pickTimeout = true })
            }
            SwitchRow(
                stringResource(R.string.settings_secure_screen), stringResource(R.string.settings_secure_screen_desc), s.secureScreen,
                icon = R.drawable.ic_lucide_smartphone,
            ) { on -> actions.onChange(s.copy(secureScreen = on)) }
            SettingRow(stringResource(R.string.security_title), stringResource(R.string.settings_security_desc), R.drawable.ic_lucide_shield, onClick = { actions.onNavigate(Screen.Security) })
        }

        SettingsGroup(stringResource(R.string.settings_about)) {
            SettingRow(stringResource(R.string.about_title), stringResource(R.string.about_version_short, BuildConfig.VERSION_NAME), R.drawable.ic_lucide_info, onClick = { actions.onNavigate(Screen.About) })
            state.privacyUrl?.let { u -> SettingRow(stringResource(R.string.link_privacy), null, R.drawable.ic_lucide_lock, onClick = { actions.onOpenUrl(u) }, end = RowEnd.EXTERNAL) }
            state.helpUrl?.let { u -> SettingRow(stringResource(R.string.link_help), null, R.drawable.ic_lucide_message_circle, onClick = { actions.onOpenUrl(u) }, end = RowEnd.EXTERNAL) }
        }

        SettingsGroup {
            SettingRow(
                stringResource(R.string.settings_sign_out), null, R.drawable.ic_lucide_log_out, onClick = { confirmSignOut = true },
                modifier = Modifier.testTag("sign_out_row"), tint = c.danger, end = RowEnd.NONE,
            )
            // Account deletion is a portal function (Play's account-deletion requirement): opened in the browser.
            state.accountDeleteUrl?.let { url ->
                SettingRow(
                    stringResource(R.string.settings_delete_account), stringResource(R.string.settings_delete_account_desc),
                    R.drawable.ic_lucide_user_x, onClick = { actions.onOpenUrl(url) }, tint = c.danger, end = RowEnd.EXTERNAL,
                )
            }
        }
    }

    if (confirmSignOut) {
        AlertDialog(
            onDismissRequest = { confirmSignOut = false },
            icon = { Icon(painterResource(R.drawable.ic_lucide_log_out), null, tint = c.danger) },
            title = { Text(stringResource(R.string.settings_sign_out)) },
            text = { Text(stringResource(R.string.sign_out_body)) },
            confirmButton = {
                TextButton(modifier = Modifier.testTag("sign_out_confirm"), onClick = {
                    confirmSignOut = false
                    actions.onSignOut()
                }) { Text(stringResource(R.string.settings_sign_out), color = c.danger) }
            },
            dismissButton = { TextButton(onClick = { confirmSignOut = false }) { Text(stringResource(R.string.action_cancel)) } },
        )
    }
    if (pickPreview) {
        ChoiceDialog(stringResource(R.string.settings_preview), NotificationPreview.entries, s.preview, { previewLabel(it) }, { pickPreview = false }) { v ->
            actions.onChange(s.copy(preview = v))
        }
    }
    if (pickReceipts) {
        ChoiceDialog(stringResource(R.string.settings_receipts), ReceiptMode.entries, s.receipts, { receiptLabel(it) }, { pickReceipts = false }) { v ->
            actions.onChange(s.copy(receipts = v))
        }
    }
    if (pickTimeout) {
        ChoiceDialog(stringResource(R.string.settings_auto_lock), AutoLockTimeout.entries, s.autoLock, { timeoutLabel(it) }, { pickTimeout = false }) { v ->
            actions.onChange(s.copy(autoLock = v))
        }
    }
}

private fun previewLabel(p: NotificationPreview) = when (p) {
    NotificationPreview.HIDDEN -> R.string.preview_hidden
    NotificationPreview.SENDER -> R.string.preview_sender
    NotificationPreview.SENDER_AND_TEXT -> R.string.preview_sender_text
}

private fun receiptLabel(r: ReceiptMode) = when (r) {
    ReceiptMode.PUBLIC -> R.string.receipts_public
    ReceiptMode.PRIVATE -> R.string.receipts_private
    ReceiptMode.OFF -> R.string.receipts_off
}

private fun timeoutLabel(t: AutoLockTimeout) = when (t) {
    AutoLockTimeout.IMMEDIATELY -> R.string.lock_immediately
    AutoLockTimeout.SECONDS_30 -> R.string.lock_30s
    AutoLockTimeout.MINUTE_1 -> R.string.lock_1m
    AutoLockTimeout.MINUTES_5 -> R.string.lock_5m
    AutoLockTimeout.MINUTES_15 -> R.string.lock_15m
    AutoLockTimeout.HOUR_1 -> R.string.lock_1h
}

@Composable
fun <T> ChoiceDialog(title: String, options: List<T>, current: T, label: (T) -> Int, onDismiss: () -> Unit, onPick: (T) -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = {
            androidx.compose.foundation.layout.Column {
                options.forEach { o ->
                    Row(
                        Modifier.fillMaxWidth().heightIn(min = 48.dp).clip(MaterialTheme.shapes.small)
                            .clickable(role = Role.RadioButton) { onPick(o); onDismiss() }.padding(horizontal = 4.dp, vertical = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        RadioButton(selected = o == current, onClick = null)
                        Text(stringResource(label(o)), modifier = Modifier.padding(start = 8.dp))
                    }
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.action_close)) } },
    )
}

/** Who is signed in, on a soft brand wash. */
@Composable
private fun ProfileCard(userId: String, deviceId: String) {
    val c = MaterialTheme.lumenColors
    Surface(
        shape = MaterialTheme.shapes.large,
        color = c.surface,
        border = if (MaterialTheme.isDark) null else BorderStroke(1.dp, c.border),
        modifier = Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 8.dp),
    ) {
        Row(Modifier.brandWash(1.4f).padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
            Avatar(userId, size = 60.dp, ring = true)
            Spacer(Modifier.width(16.dp))
            Column(Modifier.weight(1f)) {
                Text(userId, style = MaterialTheme.typography.titleMedium, color = c.text, maxLines = 2, overflow = TextOverflow.Ellipsis)
                Spacer(Modifier.height(2.dp))
                Text(stringResource(R.string.settings_device_id, deviceId), style = MaterialTheme.typography.bodyMedium, color = c.textMuted)
            }
        }
    }
}
