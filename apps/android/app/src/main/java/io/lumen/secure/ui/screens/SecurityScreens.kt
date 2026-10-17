package io.lumen.secure.ui.screens

import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.os.Build
import android.os.PersistableBundle
import android.text.format.DateUtils
import android.view.HapticFeedbackConstants
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.FilledTonalButton
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.sp
import io.lumen.secure.ui.components.IconTile
import io.lumen.secure.ui.components.Illustration
import io.lumen.secure.ui.components.PrimaryButton
import io.lumen.secure.ui.components.SettingsGroup
import io.lumen.secure.ui.theme.LumenEase
import io.lumen.secure.ui.theme.LumenMotion
import io.lumen.secure.ui.theme.brandHero
import io.lumen.secure.ui.theme.brandWash
import io.lumen.secure.ui.theme.isDark
import io.lumen.secure.ui.theme.lumenFonts
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
import io.lumen.secure.ui.components.SettingRow
import io.lumen.secure.ui.nav.NavViewModel
import io.lumen.secure.ui.theme.lumenColors
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.matrix.rustcomponents.sdk.BackupState
import org.matrix.rustcomponents.sdk.RecoveryState
import org.matrix.rustcomponents.sdk.VerificationState

/** What the app protects and what it does not (no post-quantum claims; threat-model.md). */
@Composable
fun SecurityScreen(graph: AppGraph, nav: NavViewModel) = SecurityContent(graph.keyWrapper.strongBoxBacked) { nav.pop() }

@Composable
fun SecurityContent(strongBox: Boolean?, onBack: () -> Unit) {
    val c = MaterialTheme.lumenColors
    DetailScaffold(stringResource(R.string.security_title), onBack = onBack) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            listOf(
                Triple(R.string.security_e2ee_title, R.string.security_e2ee_body, R.drawable.ic_lucide_lock),
                Triple(R.string.security_server_title, R.string.security_server_body, R.drawable.ic_lucide_server),
                Triple(R.string.security_devices_title, R.string.security_devices_body, R.drawable.ic_lucide_shield_check),
                Triple(R.string.security_storage_title, R.string.security_storage_body, R.drawable.ic_lucide_smartphone),
                Triple(R.string.security_calls_title, R.string.security_calls_body, R.drawable.ic_lucide_phone),
                Triple(R.string.security_push_title, R.string.security_push_body, R.drawable.ic_lucide_bell),
                Triple(R.string.security_lock_title, R.string.security_lock_body, R.drawable.ic_lucide_fingerprint),
                Triple(R.string.security_limits_title, R.string.security_limits_body, R.drawable.ic_lucide_info),
            ).forEach { (t, b, icon) ->
                InfoCard(icon, stringResource(t), stringResource(b))
            }
            Text(
                stringResource(
                    when (strongBox) {
                        true -> R.string.security_keystore_strongbox
                        false -> R.string.security_keystore_tee
                        null -> R.string.security_keystore_unknown
                    },
                ),
                style = MaterialTheme.typography.bodySmall, color = c.textMuted, modifier = Modifier.padding(horizontal = 4.dp),
            )
        }
    }
}

/** A titled explanation on a card, with an icon tile. */
@Composable
private fun InfoCard(icon: Int, title: String, body: String) {
    val c = MaterialTheme.lumenColors
    Surface(
        shape = MaterialTheme.shapes.large, color = c.surface,
        border = if (MaterialTheme.isDark) null else BorderStroke(1.dp, c.border),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Row(Modifier.padding(16.dp), verticalAlignment = Alignment.Top) {
            IconTile(icon)
            Spacer(Modifier.width(14.dp))
            Column(Modifier.weight(1f)) {
                Text(title, style = MaterialTheme.typography.titleMedium, color = c.text, modifier = Modifier.semantics { heading() })
                Spacer(Modifier.height(4.dp))
                Text(body, style = MaterialTheme.typography.bodyMedium, color = c.textMuted)
            }
        }
    }
}

/** The headline state of an encryption feature: an illustration, a short title, what it means. */
@Composable
private fun StatusCard(icon: Int, tint: Color, title: String, body: String?, content: @Composable ColumnScope.() -> Unit = {}) {
    val c = MaterialTheme.lumenColors
    Surface(
        shape = MaterialTheme.shapes.large, color = c.surface,
        border = if (MaterialTheme.isDark) null else BorderStroke(1.dp, c.border),
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
    ) {
        Column(Modifier.brandWash().padding(20.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Illustration(icon, size = 88.dp, tint = tint)
            Spacer(Modifier.height(8.dp))
            Text(title, style = MaterialTheme.typography.titleLarge, color = c.text, textAlign = TextAlign.Center)
            if (body != null) {
                Spacer(Modifier.height(4.dp))
                Text(body, style = MaterialTheme.typography.bodyMedium, color = c.textMuted, textAlign = TextAlign.Center)
            }
            content()
        }
    }
}

class EncryptionActions(
    val onBack: () -> Unit = {},
    val onVerifyThisDevice: () -> Unit = {},
    val onEnableRecovery: () -> Unit = {},
    val onResetRecoveryKey: () -> Unit = {},
    val onKeyStored: () -> Unit = {},
    /** Restores secrets with a recovery key; throws when the key is wrong. */
    val onRecover: suspend (String) -> Unit = {},
)

@Composable
fun EncryptionScreen(graph: AppGraph, nav: NavViewModel) {
    val enc by graph.encryption.collectAsState()
    val e = enc ?: return
    val recovery by e.recovery.collectAsState()
    val backup by e.backup.collectAsState()
    val verification by e.verification.collectAsState()
    val setup by e.setup.collectAsState()
    EncryptionContent(
        verification = verification, recovery = recovery, backup = backup, setup = setup,
        actions = EncryptionActions(
            onBack = { nav.pop() },
            onVerifyThisDevice = e::verifyThisDevice,
            onEnableRecovery = e::enableRecovery,
            onResetRecoveryKey = e::resetRecoveryKey,
            onKeyStored = e::keyStored,
            onRecover = { key -> e.recover(key) },
        ),
    )
}

@Composable
fun EncryptionContent(
    verification: VerificationState,
    recovery: RecoveryState,
    backup: BackupState,
    setup: RecoverySetup,
    actions: EncryptionActions,
    initiallyRecovering: Boolean = false,
) {
    val c = MaterialTheme.lumenColors
    var recoverOpen by remember { mutableStateOf(initiallyRecovering) }

    DetailScaffold(stringResource(R.string.encryption_title), onBack = actions.onBack) {
        when (verification) {
            VerificationState.VERIFIED -> StatusCard(
                R.drawable.ic_lucide_shield_check, c.success,
                stringResource(R.string.encryption_status_verified), stringResource(R.string.encryption_status_verified_desc),
            )
            VerificationState.UNVERIFIED -> StatusCard(
                R.drawable.ic_lucide_shield_alert, c.warning,
                stringResource(R.string.encryption_status_unverified), stringResource(R.string.encryption_device_unverified_desc),
            ) {
                Spacer(Modifier.height(16.dp))
                Column(Modifier.widthIn(max = 360.dp).fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    PrimaryButton(stringResource(R.string.encryption_verify_with_device), actions.onVerifyThisDevice, Modifier.fillMaxWidth(), icon = R.drawable.ic_lucide_smartphone)
                    OutlinedButton(onClick = { recoverOpen = true }, shape = MaterialTheme.shapes.medium, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
                        Text(stringResource(R.string.encryption_use_recovery_key))
                    }
                }
            }
            VerificationState.UNKNOWN -> StatusCard(R.drawable.ic_lucide_shield, c.textMuted, stringResource(R.string.encryption_device_unknown), null)
        }

        SettingsGroup(stringResource(R.string.encryption_recovery)) {
            Text(
                stringResource(R.string.encryption_recovery_explain), style = MaterialTheme.typography.bodyMedium, color = c.textMuted,
                modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 12.dp, bottom = 4.dp),
            )
            SettingRow(
                stringResource(
                    when (recovery) {
                        RecoveryState.ENABLED -> R.string.recovery_enabled
                        RecoveryState.DISABLED -> R.string.recovery_disabled
                        RecoveryState.INCOMPLETE -> R.string.recovery_incomplete
                        RecoveryState.UNKNOWN -> R.string.recovery_unknown
                    },
                ),
                listOfNotNull(
                    if (recovery == RecoveryState.ENABLED) stringResource(R.string.recovery_enabled_desc) else null,
                    stringResource(if (backup == BackupState.ENABLED) R.string.backup_enabled else R.string.backup_not_enabled),
                ).joinToString("\n"),
                if (recovery == RecoveryState.ENABLED) R.drawable.ic_lucide_circle_check else R.drawable.ic_lucide_key_round,
                tint = when (recovery) {
                    RecoveryState.ENABLED -> c.success
                    RecoveryState.DISABLED, RecoveryState.INCOMPLETE -> c.warning
                    RecoveryState.UNKNOWN -> c.textMuted
                },
            )
            when (val st = setup) {
                is RecoverySetup.Working -> Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                    CircularProgressIndicator(Modifier.size(20.dp), color = c.accent, strokeWidth = 2.5.dp)
                    Spacer(Modifier.width(12.dp))
                    Text(
                        if (st.total != null && st.total > 0) stringResource(R.string.recovery_backing_up, st.backedUp ?: 0, st.total) else stringResource(R.string.recovery_working),
                        color = c.textMuted,
                    )
                }
                is RecoverySetup.Error -> Banner(stringResource(R.string.recovery_error), BannerKind.DANGER, R.drawable.ic_lucide_circle_alert)
                else -> Unit
            }
            Box(Modifier.padding(start = 16.dp, end = 16.dp, top = 4.dp, bottom = 16.dp)) {
                when (recovery) {
                    RecoveryState.DISABLED -> PrimaryButton(stringResource(R.string.recovery_set_up), actions.onEnableRecovery, Modifier.fillMaxWidth(), icon = R.drawable.ic_lucide_key_round)
                    RecoveryState.INCOMPLETE -> PrimaryButton(stringResource(R.string.encryption_use_recovery_key), { recoverOpen = true }, Modifier.fillMaxWidth())
                    RecoveryState.ENABLED -> OutlinedButton(onClick = actions.onResetRecoveryKey, shape = MaterialTheme.shapes.medium, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
                        Text(stringResource(R.string.recovery_change_key))
                    }
                    RecoveryState.UNKNOWN -> Unit
                }
            }
        }
    }

    (setup as? RecoverySetup.ShowKey)?.let { RecoveryKeyDialog(it.key, actions.onKeyStored) }
    if (recoverOpen) RecoverDialog(actions.onRecover) { recoverOpen = false }
}

/** The recovery key is shown once; the user confirms by typing its last four characters. */
@Composable
fun RecoveryKeyDialog(key: String, onStored: () -> Unit) {
    val context = LocalContext.current
    var confirm by remember { mutableStateOf("") }
    val tail = key.filter { !it.isWhitespace() }.takeLast(4)
    val c = MaterialTheme.lumenColors
    AlertDialog(
        onDismissRequest = {},
        icon = { Icon(painterResource(R.drawable.ic_lucide_key_round), null, tint = c.accent) },
        title = { Text(stringResource(R.string.recovery_key_title)) },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(stringResource(R.string.recovery_key_body))
                Surface(color = c.surface2, shape = MaterialTheme.shapes.medium, border = BorderStroke(1.dp, c.border), modifier = Modifier.fillMaxWidth()) {
                    Text(
                        key, fontFamily = MaterialTheme.lumenFonts.mono, fontWeight = FontWeight.Medium, color = c.text,
                        style = MaterialTheme.typography.bodyLarge, textAlign = TextAlign.Center,
                        modifier = Modifier.padding(horizontal = 12.dp, vertical = 14.dp),
                    )
                }
                FilledTonalButton(onClick = {
                    val clip = ClipData.newPlainText("recovery key", key)
                    // Android 13+: mark as sensitive so the clipboard preview does not show it.
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                        clip.description.extras = PersistableBundle().apply { putBoolean(ClipDescription.EXTRA_IS_SENSITIVE, true) }
                    }
                    context.getSystemService(ClipboardManager::class.java).setPrimaryClip(clip)
                }, modifier = Modifier.fillMaxWidth()) {
                    Icon(painterResource(R.drawable.ic_lucide_copy), null, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(8.dp))
                    Text(stringResource(R.string.recovery_key_copy))
                }
                OutlinedTextField(
                    confirm, { confirm = it.trim() }, singleLine = true, shape = MaterialTheme.shapes.medium,
                    label = { Text(stringResource(R.string.recovery_key_confirm)) }, modifier = Modifier.fillMaxWidth(),
                )
            }
        },
        confirmButton = {
            Button(enabled = confirm.equals(tail, ignoreCase = false), onClick = onStored) { Text(stringResource(R.string.recovery_key_saved)) }
        },
    )
}

@Composable
private fun RecoverDialog(recover: suspend (String) -> Unit, onDone: () -> Unit) {
    val scope = rememberCoroutineScope()
    var key by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var failed by remember { mutableStateOf(false) }
    AlertDialog(
        onDismissRequest = onDone,
        icon = { Icon(painterResource(R.drawable.ic_lucide_key_round), null, tint = MaterialTheme.lumenColors.accent) },
        title = { Text(stringResource(R.string.encryption_use_recovery_key)) },
        text = {
            Column {
                Text(stringResource(R.string.recover_body))
                Spacer(Modifier.height(12.dp))
                OutlinedTextField(key, { key = it }, label = { Text(stringResource(R.string.recover_key_label)) }, isError = failed,
                    shape = MaterialTheme.shapes.medium, modifier = Modifier.fillMaxWidth(),
                    supportingText = if (failed) { { Text(stringResource(R.string.recover_failed)) } } else null)
            }
        },
        confirmButton = {
            TextButton(enabled = !busy && key.isNotBlank(), onClick = {
                busy = true
                scope.launch {
                    try {
                        recover(key)
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
@Composable
fun VerificationDialog(e: EncryptionController) {
    val state by e.sas.collectAsState()
    VerificationContent(
        state,
        VerificationActions(
            onCancel = e::cancel, onAccept = e::acceptIncoming, onMatch = e::confirmMatch, onMismatch = e::reportMismatch, onDismiss = e::dismiss,
        ),
    )
}

class VerificationActions(
    val onCancel: () -> Unit = {},
    val onAccept: (VerificationUi.IncomingRequest) -> Unit = {},
    val onMatch: () -> Unit = {},
    val onMismatch: () -> Unit = {},
    val onDismiss: () -> Unit = {},
)

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun VerificationContent(state: VerificationUi, a: VerificationActions) {
    val c = MaterialTheme.lumenColors
    when (val s = state) {
        VerificationUi.Idle -> Unit
        is VerificationUi.IncomingRequest -> AlertDialog(
            onDismissRequest = { a.onCancel() },
            icon = { Icon(painterResource(R.drawable.ic_lucide_shield_check), null, tint = c.accent) },
            title = { Text(stringResource(R.string.verify_incoming_title)) },
            text = { Text(stringResource(R.string.verify_incoming_body, s.fromName ?: s.fromUserId, s.deviceName ?: s.deviceId)) },
            confirmButton = { Button(onClick = { a.onAccept(s) }) { Text(stringResource(R.string.action_verify)) } },
            dismissButton = { TextButton(onClick = { a.onCancel() }) { Text(stringResource(R.string.action_ignore)) } },
        )
        is VerificationUi.Waiting, VerificationUi.Starting -> AlertDialog(
            onDismissRequest = {},
            icon = { Icon(painterResource(R.drawable.ic_lucide_smartphone), null, tint = c.accent) },
            title = { Text(stringResource(R.string.verify_title)) },
            text = {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    CircularProgressIndicator(Modifier.size(20.dp), color = c.accent, strokeWidth = 2.5.dp)
                    Spacer(Modifier.width(12.dp))
                    Text(stringResource(if (s is VerificationUi.Waiting) R.string.verify_waiting else R.string.verify_starting))
                }
            },
            confirmButton = { TextButton(onClick = { a.onCancel() }) { Text(stringResource(R.string.action_cancel)) } },
        )
        is VerificationUi.Emojis -> AlertDialog(
            onDismissRequest = {},
            title = { Text(stringResource(R.string.verify_compare_title)) },
            text = {
                Column(Modifier.verticalScroll(rememberScrollState())) {
                    Text(stringResource(R.string.verify_compare_body))
                    Spacer(Modifier.height(16.dp))
                    FlowRow(
                        Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterHorizontally),
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        s.emojis.forEach { em ->
                            // Tiles grow with the text size instead of breaking a word across lines.
                            Column(
                                Modifier.widthIn(min = 68.dp).clip(MaterialTheme.shapes.medium).background(c.surface3).padding(vertical = 10.dp, horizontal = 8.dp),
                                horizontalAlignment = Alignment.CenterHorizontally,
                            ) {
                                Text(em.symbol, fontSize = 30.sp, lineHeight = 36.sp)
                                Spacer(Modifier.height(4.dp))
                                Text(em.description, style = MaterialTheme.typography.labelSmall, color = c.textMuted, textAlign = TextAlign.Center, maxLines = 1, softWrap = false)
                            }
                        }
                    }
                }
            },
            confirmButton = { Button(onClick = { a.onMatch() }) { Text(stringResource(R.string.verify_match)) } },
            dismissButton = { TextButton(onClick = { a.onMismatch() }) { Text(stringResource(R.string.verify_no_match), color = c.danger) } },
        )
        is VerificationUi.Decimals -> AlertDialog(
            onDismissRequest = {},
            title = { Text(stringResource(R.string.verify_compare_title)) },
            text = {
                Text(
                    s.values.joinToString("  "), style = MaterialTheme.typography.headlineSmall, fontFamily = MaterialTheme.lumenFonts.mono,
                    textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth(),
                )
            },
            confirmButton = { Button(onClick = { a.onMatch() }) { Text(stringResource(R.string.verify_match)) } },
            dismissButton = { TextButton(onClick = { a.onMismatch() }) { Text(stringResource(R.string.verify_no_match), color = c.danger) } },
        )
        VerificationUi.Done -> {
            // A small moment of delight: the success mark settles in with a gentle overshoot, plus a confirm haptic.
            val view = LocalView.current
            var shown by remember { mutableStateOf(false) }
            LaunchedEffect(Unit) {
                shown = true
                view.performHapticFeedback(if (Build.VERSION.SDK_INT >= 30) HapticFeedbackConstants.CONFIRM else HapticFeedbackConstants.VIRTUAL_KEY)
            }
            val scale by animateFloatAsState(if (shown) 1f else 0.6f, tween(LumenMotion.durSlowMillis, easing = LumenEase.Spring), label = "done")
            AlertDialog(
                onDismissRequest = { a.onDismiss() },
                icon = { Illustration(R.drawable.ic_lucide_circle_check, Modifier.graphicsLayer { scaleX = scale; scaleY = scale }, size = 88.dp, tint = c.success) },
                title = { Text(stringResource(R.string.verify_done_title), textAlign = TextAlign.Center) },
                text = { Text(stringResource(R.string.verify_done_body), textAlign = TextAlign.Center) },
                confirmButton = { Button(onClick = { a.onDismiss() }) { Text(stringResource(R.string.action_close)) } },
            )
        }
        is VerificationUi.Cancelled, VerificationUi.Failed -> AlertDialog(
            onDismissRequest = { a.onDismiss() },
            icon = { Icon(painterResource(R.drawable.ic_lucide_circle_alert), null, tint = c.warning) },
            title = { Text(stringResource(R.string.verify_failed_title)) },
            text = { Text(stringResource(R.string.verify_failed_body)) },
            confirmButton = { TextButton(onClick = { a.onDismiss() }) { Text(stringResource(R.string.action_close)) } },
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

    DevicesContent(
        devices = devices, loading = loading, failed = failed, pending = pending, currentDeviceId = session.deviceId, thisDevice = thisVerified,
        actions = DevicesActions(
            onBack = { nav.pop() },
            onRetry = { reload++ },
            onContinueAuth = { d, ch -> delete(d, ch.session) },
            onCancelAuth = { pending = null },
            onRemove = { d -> delete(d, null) },
        ),
    )
}

class DevicesActions(
    val onBack: () -> Unit = {},
    val onRetry: () -> Unit = {},
    val onContinueAuth: (DeviceInfo, UiaChallenge) -> Unit = { _, _ -> },
    val onCancelAuth: () -> Unit = {},
    val onRemove: (DeviceInfo) -> Unit = {},
)

@Composable
fun DevicesContent(
    devices: List<DeviceInfo>,
    loading: Boolean,
    failed: Boolean,
    pending: Pair<DeviceInfo, UiaChallenge>?,
    currentDeviceId: String,
    thisDevice: VerificationState,
    actions: DevicesActions,
) {
    val c = MaterialTheme.lumenColors
    var confirm by remember { mutableStateOf<DeviceInfo?>(null) }
    DetailScaffold(stringResource(R.string.devices_title), onBack = actions.onBack) {
        Text(stringResource(R.string.devices_explain), style = MaterialTheme.typography.bodyMedium, color = c.textMuted, modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp))
        if (failed) Banner(stringResource(R.string.devices_failed), BannerKind.DANGER, R.drawable.ic_lucide_circle_alert, stringResource(R.string.action_try_again), actions.onRetry)
        pending?.let { (d, ch) ->
            Banner(
                stringResource(if (ch.ssoFallback) R.string.devices_confirm_browser else R.string.devices_password_needed, d.displayName ?: d.deviceId),
                BannerKind.INFO, R.drawable.ic_lucide_external_link,
                actionLabel = if (ch.ssoFallback) stringResource(R.string.action_continue) else null,
                onAction = if (ch.ssoFallback) ({ actions.onContinueAuth(d, ch) }) else null,
                secondaryLabel = stringResource(R.string.action_cancel), onSecondary = actions.onCancelAuth,
            )
        }
        if (loading && devices.isEmpty()) {
            val label = stringResource(R.string.devices_loading)
            Box(Modifier.fillMaxWidth().padding(32.dp), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(color = c.accent, strokeWidth = 3.dp, modifier = Modifier.size(32.dp).semantics { contentDescription = label })
            }
        }
        val (mine, others) = devices.partition { it.deviceId == currentDeviceId }
        if (mine.isNotEmpty()) {
            SettingsGroup(stringResource(R.string.devices_this_section)) {
                mine.forEach { d -> DeviceRow(d, current = true, thisDevice = thisDevice, onRemove = {}) }
            }
        }
        if (others.isNotEmpty()) {
            SettingsGroup(stringResource(R.string.devices_other_section)) {
                others.forEach { d -> DeviceRow(d, current = false, thisDevice = thisDevice, onRemove = { confirm = d }) }
            }
        }
    }
    confirm?.let { d ->
        AlertDialog(
            onDismissRequest = { confirm = null },
            icon = { Icon(painterResource(R.drawable.ic_lucide_log_out), null, tint = c.danger) },
            title = { Text(stringResource(R.string.devices_remove_title)) },
            text = { Text(stringResource(R.string.devices_remove_body, d.displayName ?: d.deviceId)) },
            confirmButton = { TextButton(onClick = { confirm = null; actions.onRemove(d) }) { Text(stringResource(R.string.devices_remove), color = c.danger) } },
            dismissButton = { TextButton(onClick = { confirm = null }) { Text(stringResource(R.string.action_cancel)) } },
        )
    }
}

@Composable
private fun DeviceRow(d: DeviceInfo, current: Boolean, thisDevice: VerificationState, onRemove: () -> Unit) {
    val c = MaterialTheme.lumenColors
    val lastSeen = d.lastSeenTs?.let { DateUtils.getRelativeTimeSpanString(it).toString() }
    val name = d.displayName ?: d.deviceId
    val desktop = listOf("web", "desktop", "windows", "linux", "mac", "firefox", "chrome").any { name.contains(it, ignoreCase = true) }
    SettingRow(
        title = name,
        subtitle = listOfNotNull(
            d.deviceId,
            lastSeen?.let { stringResource(R.string.devices_last_seen, it) },
            if (current) stringResource(
                when (thisDevice) {
                    VerificationState.VERIFIED -> R.string.encryption_device_verified
                    VerificationState.UNVERIFIED -> R.string.encryption_device_unverified
                    VerificationState.UNKNOWN -> R.string.encryption_device_unknown
                },
            ) else stringResource(R.string.devices_verification_unavailable),
        ).joinToString(" · "),
        icon = if (desktop) R.drawable.ic_lucide_laptop else R.drawable.ic_lucide_smartphone,
        tint = if (current && thisDevice == VerificationState.VERIFIED) c.success else if (current && thisDevice == VerificationState.UNVERIFIED) c.warning else null,
        trailing = if (!current) ({
            TextButton(onClick = onRemove) { Text(stringResource(R.string.devices_remove), color = c.danger) }
        }) else null,
    )
}

@Composable
fun BlockedUsersScreen(session: MatrixSession, nav: NavViewModel) {
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
    BlockedUsersContent(users, onBack = { nav.pop() }) { u ->
        scope.launch { try { session.client.unignoreUser(u); reload++ } catch (_: Exception) {} }
    }
}

@Composable
fun BlockedUsersContent(users: List<String>, onBack: () -> Unit, onUnblock: (String) -> Unit) {
    val c = MaterialTheme.lumenColors
    DetailScaffold(stringResource(R.string.blocked_title), onBack = onBack) {
        Text(stringResource(R.string.blocked_explain), style = MaterialTheme.typography.bodyMedium, color = c.textMuted, modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp))
        if (users.isEmpty()) {
            CenteredState(stringResource(R.string.blocked_empty), icon = R.drawable.ic_lucide_shield_check)
        } else {
            SettingsGroup {
                users.forEach { u ->
                    SettingRow(u, null, R.drawable.ic_lucide_user_x, tint = c.textMuted, trailing = {
                        TextButton(onClick = { onUnblock(u) }) { Text(stringResource(R.string.member_unblock)) }
                    })
                }
            }
        }
    }
}

@Composable
fun LockScreen(onUnlock: () -> Unit) {
    val c = MaterialTheme.lumenColors
    val dark = MaterialTheme.isDark
    Surface(Modifier.fillMaxSize(), color = c.bg) {
        Box(Modifier.fillMaxSize().then(if (dark) Modifier.brandHero() else Modifier.brandWash(1.6f))) {
            BoxWithConstraints(Modifier.fillMaxSize().safeDrawingPadding()) {
                Column(
                    Modifier.verticalScroll(rememberScrollState()).heightIn(min = maxHeight).fillMaxWidth().padding(32.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.Center,
                ) {
                    LogoMark(64.dp, glow = true)
                    Spacer(Modifier.height(12.dp))
                    Text(stringResource(R.string.lock_welcome), style = MaterialTheme.typography.headlineMedium, color = c.text, textAlign = TextAlign.Center)
                    Spacer(Modifier.height(8.dp))
                    Text(stringResource(R.string.lock_body), style = MaterialTheme.typography.bodyLarge, color = c.textMuted, textAlign = TextAlign.Center)
                    Spacer(Modifier.height(32.dp))
                    PrimaryButton(
                        stringResource(R.string.lock_unlock), onUnlock, Modifier.widthIn(min = 240.dp),
                        icon = R.drawable.ic_lucide_fingerprint,
                    )
                    Spacer(Modifier.height(48.dp))
                    Row(verticalAlignment = Alignment.Top, modifier = Modifier.widthIn(max = 420.dp)) {
                        Icon(painterResource(R.drawable.ic_lucide_lock), null, tint = c.textSubtle, modifier = Modifier.padding(top = 2.dp).size(14.dp))
                        Spacer(Modifier.width(8.dp))
                        Text(stringResource(R.string.lock_limits), style = MaterialTheme.typography.bodySmall, color = c.textMuted)
                    }
                }
            }
        }
    }
}
