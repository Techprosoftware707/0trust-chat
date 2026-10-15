package io.lumen.secure.calls

import android.view.ViewGroup
import android.webkit.WebView
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import io.lumen.secure.R
import io.lumen.secure.core.calls.CallEncryptionLabel
import io.lumen.secure.core.calls.label
import io.lumen.secure.ui.theme.lumenColors

@Composable
fun CallScreen(
    stage: CallActivity.Stage,
    failure: CallWidgetHost.Failure?,
    pip: Boolean,
    calls: CallManager,
    webView: WebView?,
    onAnswer: (video: Boolean) -> Unit,
    onDecline: () -> Unit,
    onHangUp: () -> Unit,
    onClose: () -> Unit,
    onPip: () -> Unit,
) {
    val ring by calls.ringing.collectAsState()
    val active by calls.active.collectAsState()
    Surface(Modifier.fillMaxSize(), color = MaterialTheme.lumenColors.bg) {
        when (stage) {
            CallActivity.Stage.UNAVAILABLE -> Message(
                title = stringResource(R.string.call_unavailable_title),
                body = stringResource(R.string.call_unavailable_body),
                onClose = onClose,
            )
            CallActivity.Stage.PERMISSIONS_DENIED -> Message(
                title = stringResource(R.string.call_permission_title),
                body = stringResource(R.string.call_permission_body),
                onClose = onClose,
            )
            CallActivity.Stage.ENDED -> Message(stringResource(R.string.call_ended), null, onClose)
            CallActivity.Stage.FAILED -> Message(
                title = stringResource(R.string.call_failed),
                body = stringResource(
                    when (failure) {
                        CallWidgetHost.Failure.WEBVIEW_TOO_OLD -> R.string.call_failed_webview
                        CallWidgetHost.Failure.ROOM_NOT_FOUND -> R.string.call_failed_room
                        else -> R.string.call_failed_generic
                    },
                ),
                onClose = onClose,
            )
            CallActivity.Stage.INCOMING -> Incoming(
                caller = ring?.callerName ?: ring?.roomName,
                video = ring?.video == true,
                onAnswer = onAnswer,
                onDecline = onDecline,
            )
            CallActivity.Stage.CONNECTING, CallActivity.Stage.ACTIVE -> Box(Modifier.fillMaxSize()) {
                if (webView != null) {
                    AndroidView(
                        factory = {
                            (webView.parent as? ViewGroup)?.removeView(webView)
                            webView
                        },
                        modifier = Modifier.fillMaxSize(),
                    )
                }
                if (!pip) {
                    val call = active
                    Row(
                        Modifier.fillMaxWidth().safeDrawingPadding().padding(8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        EncryptionChip(call?.e2ee?.label() ?: CallEncryptionLabel.UNKNOWN, call?.phase == null)
                        Spacer(Modifier.weight(1f))
                        if (call != null && call.routes.size > 1) RoutePicker(call, calls)
                        if (call?.video == true) {
                            IconButton(onClick = onPip) {
                                Icon(painterResource(R.drawable.ic_lucide_picture_in_picture_2), stringResource(R.string.call_pip))
                            }
                        }
                        FilledIconButton(
                            onClick = onHangUp,
                            colors = IconButtonDefaults.filledIconButtonColors(containerColor = MaterialTheme.lumenColors.danger),
                        ) {
                            Icon(painterResource(R.drawable.ic_lucide_phone_off), stringResource(R.string.call_hang_up))
                        }
                    }
                }
            }
        }
    }
}

/** The label comes only from the widget's `e2ee` report; nothing is claimed before it reports. */
@Composable
private fun EncryptionChip(label: CallEncryptionLabel, notYetReported: Boolean) {
    val c = MaterialTheme.lumenColors
    val (text, color, icon) = when {
        notYetReported -> Triple(stringResource(R.string.call_connecting), c.textMuted, R.drawable.ic_lucide_clock)
        label == CallEncryptionLabel.END_TO_END_ENCRYPTED -> Triple(stringResource(R.string.call_e2ee_encrypted), c.success, R.drawable.ic_lucide_lock)
        label == CallEncryptionLabel.WAITING_FOR_KEYS -> Triple(stringResource(R.string.call_e2ee_waiting), c.warning, R.drawable.ic_lucide_clock)
        label == CallEncryptionLabel.NOT_ENCRYPTED -> Triple(stringResource(R.string.call_e2ee_not_encrypted), c.danger, R.drawable.ic_lucide_shield_alert)
        label == CallEncryptionLabel.DECRYPTION_ERROR -> Triple(stringResource(R.string.call_e2ee_error), c.danger, R.drawable.ic_lucide_shield_alert)
        else -> Triple(stringResource(R.string.call_e2ee_unknown), c.textMuted, R.drawable.ic_lucide_shield)
    }
    Surface(shape = MaterialTheme.shapes.small, color = c.surface2.copy(alpha = 0.9f)) {
        Row(Modifier.padding(horizontal = 10.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(painterResource(icon), null, tint = color, modifier = Modifier.size(16.dp))
            Spacer(Modifier.size(6.dp))
            Text(text, style = MaterialTheme.typography.labelMedium, color = c.text)
        }
    }
}

@Composable
private fun RoutePicker(call: ActiveCall, calls: CallManager) {
    var open by remember { mutableStateOf(false) }
    val currentLabel = call.currentRoute?.let { stringResource(calls.endpointLabel(it)) } ?: ""
    Box {
        IconButton(onClick = { open = true }) {
            Icon(painterResource(routeIcon(call.currentRoute)), stringResource(R.string.call_audio_route, currentLabel))
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            call.routes.forEach { r ->
                DropdownMenuItem(
                    text = { Text(stringResource(calls.endpointLabel(r)) + if (r.type == androidx.core.telecom.CallEndpointCompat.TYPE_BLUETOOTH) " · ${r.name}" else "") },
                    leadingIcon = { Icon(painterResource(routeIcon(r)), null) },
                    onClick = {
                        open = false
                        calls.selectRoute(r)
                    },
                )
            }
        }
    }
}

private fun routeIcon(r: AudioRoute?): Int = when (r?.type) {
    androidx.core.telecom.CallEndpointCompat.TYPE_SPEAKER -> R.drawable.ic_lucide_volume_2
    androidx.core.telecom.CallEndpointCompat.TYPE_BLUETOOTH -> R.drawable.ic_lucide_bluetooth
    androidx.core.telecom.CallEndpointCompat.TYPE_WIRED_HEADSET -> R.drawable.ic_lucide_headphones
    else -> R.drawable.ic_lucide_ear
}

@Composable
private fun Incoming(caller: String?, video: Boolean, onAnswer: (Boolean) -> Unit, onDecline: () -> Unit) {
    val c = MaterialTheme.lumenColors
    Column(
        Modifier.fillMaxSize().background(c.bg).safeDrawingPadding().padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.SpaceBetween,
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Spacer(Modifier.height(48.dp))
            Icon(painterResource(R.drawable.ic_lucide_phone_incoming), null, tint = c.accent, modifier = Modifier.size(48.dp))
            Spacer(Modifier.height(16.dp))
            Text(
                caller ?: stringResource(R.string.notification_incoming_call),
                style = MaterialTheme.typography.headlineMedium, color = c.text, textAlign = TextAlign.Center,
            )
            Text(
                stringResource(if (video) R.string.call_incoming_video else R.string.call_incoming_voice),
                style = MaterialTheme.typography.bodyLarge, color = c.textMuted,
            )
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceEvenly) {
            Button(
                onClick = onDecline,
                shape = CircleShape,
                colors = ButtonDefaults.buttonColors(containerColor = c.danger),
            ) {
                Icon(painterResource(R.drawable.ic_lucide_phone_off), null)
                Spacer(Modifier.size(8.dp))
                Text(stringResource(R.string.call_decline))
            }
            if (video) {
                Button(onClick = { onAnswer(true) }, shape = CircleShape, colors = ButtonDefaults.buttonColors(containerColor = c.success)) {
                    Icon(painterResource(R.drawable.ic_lucide_video), null)
                    Spacer(Modifier.size(8.dp))
                    Text(stringResource(R.string.call_answer_video))
                }
            }
            Button(onClick = { onAnswer(false) }, shape = CircleShape, colors = ButtonDefaults.buttonColors(containerColor = c.success)) {
                Icon(painterResource(R.drawable.ic_lucide_phone), null)
                Spacer(Modifier.size(8.dp))
                Text(stringResource(R.string.call_answer))
            }
        }
    }
}

@Composable
private fun Message(title: String, body: String?, onClose: () -> Unit) {
    val c = MaterialTheme.lumenColors
    Column(
        Modifier.fillMaxSize().safeDrawingPadding().padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text(title, style = MaterialTheme.typography.titleLarge, color = c.text, textAlign = TextAlign.Center)
        if (body != null) {
            Spacer(Modifier.height(8.dp))
            Text(body, style = MaterialTheme.typography.bodyMedium, color = c.textMuted, textAlign = TextAlign.Center)
        }
        Spacer(Modifier.height(24.dp))
        Button(onClick = onClose) { Text(stringResource(R.string.action_close)) }
    }
}
