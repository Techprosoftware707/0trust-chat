package io.lumen.secure.ui.screens

import androidx.compose.foundation.layout.Column
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
import io.lumen.secure.ui.theme.MonoFamily
import io.lumen.secure.ui.theme.lumenColors
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.matrix.rustcomponents.sdk.sdkGitSha

@Composable
fun AboutScreen(graph: AppGraph, nav: NavViewModel) {
    val c = MaterialTheme.lumenColors
    val server = remember { graph.serverInfo.load() }
    val sdkSha = remember { runCatching { sdkGitSha().take(10) }.getOrDefault("?") }
    DetailScaffold(stringResource(R.string.about_title), onBack = { nav.pop() }) {
        Column(Modifier.fillMaxWidth().padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            LogoMark(64.dp)
            Text(stringResource(R.string.app_name), style = MaterialTheme.typography.titleLarge, color = c.text)
            Text(stringResource(R.string.about_version, BuildConfig.VERSION_NAME, BuildConfig.VERSION_CODE), style = MaterialTheme.typography.bodyMedium, color = c.textMuted)
        }
        SectionHeader(stringResource(R.string.about_server))
        SettingRow(server?.serverName ?: "—", server?.homeserverUrl, null)
        SectionHeader(stringResource(R.string.about_components))
        SettingRow(stringResource(R.string.about_sdk), "org.matrix.rustcomponents:sdk-android 26.09.28 ($sdkSha)", null)
        SettingRow(
            stringResource(R.string.about_calls),
            stringResource(if (graph.calls.widgetBundled) R.string.about_calls_bundled else R.string.call_unavailable_title),
            null,
        )
        SettingRow(
            stringResource(R.string.about_push),
            stringResource(if (BuildConfig.FCM_CONFIGURED) R.string.about_push_fcm else R.string.about_push_none),
            null,
        )
        SettingRow(stringResource(R.string.about_no_tracking), stringResource(R.string.about_no_tracking_desc), null)
        SettingRow(stringResource(R.string.licenses_title), null, R.drawable.ic_lucide_file, onClick = { nav.push(Screen.Licenses) })
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
            Text(body, style = MaterialTheme.typography.bodySmall, fontFamily = MonoFamily, color = c.textMuted, modifier = Modifier.padding(horizontal = 16.dp))
        }
    }
}
