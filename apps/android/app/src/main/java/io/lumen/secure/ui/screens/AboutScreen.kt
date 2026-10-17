package io.lumen.secure.ui.screens

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Icon
import androidx.compose.runtime.collectAsState
import androidx.compose.ui.res.painterResource
import io.lumen.secure.matrix.MatrixSession
import io.lumen.secure.ui.components.SettingsGroup
import kotlinx.coroutines.flow.MutableStateFlow
import org.matrix.rustcomponents.sdk.VerificationState
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import io.lumen.secure.AppGraph
import io.lumen.secure.BuildConfig
import io.lumen.secure.R
import io.lumen.secure.ui.components.LogoMark
import io.lumen.secure.ui.components.SectionHeader
import io.lumen.secure.ui.components.SettingRow
import io.lumen.secure.ui.nav.NavViewModel
import io.lumen.secure.ui.nav.Screen
import io.lumen.secure.ui.theme.lumenFonts
import io.lumen.secure.ui.theme.lumenColors
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.matrix.rustcomponents.sdk.sdkGitSha

@Composable
fun AboutScreen(graph: AppGraph, session: MatrixSession, nav: NavViewModel) {
    val server = remember { graph.serverInfo.load() }
    val sdkSha = remember { runCatching { sdkGitSha().take(10) }.getOrDefault("?") }
    val enc by graph.encryption.collectAsState()
    val verification by (enc?.verification ?: remember { MutableStateFlow(VerificationState.UNKNOWN) }).collectAsState()
    AboutContent(
        serverName = server?.serverName, homeserverUrl = server?.homeserverUrl ?: session.homeserverUrl,
        userId = session.userId, deviceId = session.deviceId, verification = verification,
        sdkSha = sdkSha, callsBundled = graph.calls.widgetBundled,
        onBack = { nav.pop() }, onLicenses = { nav.push(Screen.Licenses) },
    )
}

@Composable
fun AboutContent(
    serverName: String?,
    homeserverUrl: String?,
    userId: String,
    deviceId: String,
    verification: VerificationState,
    sdkSha: String,
    callsBundled: Boolean,
    onBack: () -> Unit,
    onLicenses: () -> Unit,
) {
    val c = MaterialTheme.lumenColors
    DetailScaffold(stringResource(R.string.about_title), onBack = onBack) {
        Column(Modifier.fillMaxWidth().padding(top = 8.dp, bottom = 4.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            LogoMark(64.dp, glow = true)
            Text(stringResource(R.string.app_name), style = MaterialTheme.typography.headlineSmall, color = c.text)
            Spacer(Modifier.height(2.dp))
            Text(stringResource(R.string.about_version, BuildConfig.VERSION_NAME, BuildConfig.VERSION_CODE), style = MaterialTheme.typography.bodyMedium, color = c.textMuted)
        }

        SettingsGroup(stringResource(R.string.about_matrix_title)) {
            Text(
                stringResource(R.string.about_matrix_body), style = MaterialTheme.typography.bodyMedium, color = c.textMuted,
                modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 12.dp, bottom = 4.dp),
            )
            SettingRow(stringResource(R.string.about_homeserver), homeserverUrl ?: serverName ?: "—", R.drawable.ic_lucide_server)
            SettingRow(stringResource(R.string.about_matrix_id), userId, R.drawable.ic_lucide_user)
            SettingRow(stringResource(R.string.about_device_id), deviceId, R.drawable.ic_lucide_smartphone)
            SettingRow(stringResource(R.string.about_encryption), stringResource(R.string.about_encryption_value), R.drawable.ic_lucide_lock, tint = c.success)
            SettingRow(
                stringResource(R.string.about_this_device),
                stringResource(
                    when (verification) {
                        VerificationState.VERIFIED -> R.string.encryption_device_verified
                        VerificationState.UNVERIFIED -> R.string.encryption_device_unverified
                        VerificationState.UNKNOWN -> R.string.encryption_device_unknown
                    },
                ),
                if (verification == VerificationState.VERIFIED) R.drawable.ic_lucide_shield_check else R.drawable.ic_lucide_shield_alert,
                tint = when (verification) {
                    VerificationState.VERIFIED -> c.success
                    VerificationState.UNVERIFIED -> c.warning
                    VerificationState.UNKNOWN -> c.textMuted
                },
            )
            Note(R.drawable.ic_lucide_globe, stringResource(R.string.about_federation))
            Note(R.drawable.ic_lucide_shield, stringResource(R.string.about_wireguard))
        }

        SettingsGroup(stringResource(R.string.about_components)) {
            SettingRow(stringResource(R.string.about_sdk), "org.matrix.rustcomponents:sdk-android 26.09.28 ($sdkSha)", R.drawable.ic_lucide_key_round)
            SettingRow(
                stringResource(R.string.about_calls),
                stringResource(if (callsBundled) R.string.about_calls_bundled else R.string.call_unavailable_title),
                R.drawable.ic_lucide_phone,
            )
            SettingRow(
                stringResource(R.string.about_push),
                stringResource(if (BuildConfig.FCM_CONFIGURED) R.string.about_push_fcm else R.string.about_push_none),
                R.drawable.ic_lucide_bell,
            )
            SettingRow(stringResource(R.string.about_no_tracking), stringResource(R.string.about_no_tracking_desc), R.drawable.ic_lucide_eye_off)
        }
        SettingsGroup {
            SettingRow(stringResource(R.string.licenses_title), null, R.drawable.ic_lucide_file, onClick = onLicenses)
        }
    }
}

/** A short plain-text fact with a small icon, inside a settings card. */
@Composable
private fun Note(icon: Int, text: String) {
    val c = MaterialTheme.lumenColors
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), verticalAlignment = Alignment.Top) {
        Icon(painterResource(icon), null, tint = c.textMuted, modifier = Modifier.padding(start = 8.dp, top = 2.dp).size(18.dp))
        Spacer(Modifier.width(22.dp))
        Text(text, style = MaterialTheme.typography.bodyMedium, color = c.textMuted)
    }
}

@Composable
fun LicensesScreen(nav: NavViewModel) {
    val c = MaterialTheme.lumenColors
    val context = LocalContext.current
    var texts by remember { mutableStateOf<List<Pair<String, String>>>(emptyList()) }
    LaunchedEffect(Unit) {
        texts = withContext(Dispatchers.IO) {
            val files = context.assets.list("licenses").orEmpty().sorted()
            files.map { f -> f to context.assets.open("licenses/$f").bufferedReader().use { it.readText() } }
        }
    }
    DetailScaffold(stringResource(R.string.licenses_title), onBack = { nav.pop() }) {
        Text(stringResource(R.string.licenses_intro), style = MaterialTheme.typography.bodyMedium, color = c.textMuted, modifier = Modifier.padding(16.dp))
        texts.forEach { (name, body) ->
            SectionHeader(name.removeSuffix(".txt"))
            Text(body, style = MaterialTheme.typography.bodySmall, fontFamily = MaterialTheme.lumenFonts.mono, color = c.textMuted, modifier = Modifier.padding(horizontal = 16.dp))
        }
    }
}
