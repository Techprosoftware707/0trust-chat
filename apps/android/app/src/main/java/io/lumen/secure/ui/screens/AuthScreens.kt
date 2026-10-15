package io.lumen.secure.ui.screens

import android.content.ActivityNotFoundException
import android.content.Context
import androidx.core.net.toUri
import androidx.browser.customtabs.CustomTabsIntent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import io.lumen.secure.AppGraph
import io.lumen.secure.R
import io.lumen.secure.auth.SignInError
import io.lumen.secure.core.config.DiscoveredServer
import io.lumen.secure.core.config.DiscoveryFailure
import io.lumen.secure.matrix.SignOutReason
import io.lumen.secure.ui.components.Banner
import io.lumen.secure.ui.components.BannerKind
import io.lumen.secure.ui.components.LogoMark
import io.lumen.secure.ui.theme.lumenColors

/** Opens a URL in Custom Tabs (the system browser): the app never sees passwords or MFA codes. */
fun openInBrowser(context: Context, url: String): Boolean = try {
    CustomTabsIntent.Builder().setShowTitle(true).build().launchUrl(context, url.toUri())
    true
} catch (_: ActivityNotFoundException) {
    false
}

@Composable
fun AuthFlow(graph: AppGraph, reason: SignOutReason?) {
    val state by graph.auth.state.collectAsState()
    Column(
        Modifier.fillMaxSize().safeDrawingPadding().imePadding().verticalScroll(rememberScrollState()).padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Column(Modifier.widthIn(max = 480.dp).fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
            Spacer(Modifier.height(32.dp))
            LogoMark(64.dp)
            Spacer(Modifier.height(16.dp))
            if (reason == SignOutReason.REMOTE) {
                Banner(stringResource(R.string.signed_out_remote), BannerKind.WARNING, R.drawable.ic_lucide_triangle_alert)
                Spacer(Modifier.height(16.dp))
            }
            val server = state.server
            if (server == null) ServerPicker(graph) else SignIn(graph, server)
        }
    }
}

@Composable
private fun ServerPicker(graph: AppGraph) {
    val state by graph.auth.state.collectAsState()
    val c = MaterialTheme.lumenColors
    Text(stringResource(R.string.auth_welcome), style = MaterialTheme.typography.headlineMedium, color = c.text, textAlign = TextAlign.Center)
    Spacer(Modifier.height(8.dp))
    Text(stringResource(R.string.auth_server_explain), style = MaterialTheme.typography.bodyMedium, color = c.textMuted, textAlign = TextAlign.Center)
    Spacer(Modifier.height(24.dp))
    OutlinedTextField(
        value = state.serverInput,
        onValueChange = graph.auth::setInput,
        label = { Text(stringResource(R.string.auth_server_label)) },
        placeholder = { Text(stringResource(R.string.auth_server_placeholder)) },
        singleLine = true,
        isError = state.discoveryError != null,
        supportingText = state.discoveryError?.let { e -> { Text(stringResource(discoveryMessage(e))) } },
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Go, autoCorrectEnabled = false),
        keyboardActions = KeyboardActions(onGo = { if (state.serverInput.isNotBlank()) graph.auth.discover() }),
        modifier = Modifier.fillMaxWidth().testTag("server_input"),
    )
    Spacer(Modifier.height(16.dp))
    Button(
        onClick = graph.auth::discover,
        enabled = !state.discovering && state.serverInput.isNotBlank(),
        modifier = Modifier.fillMaxWidth().testTag("server_continue"),
    ) {
        if (state.discovering) CircularProgressIndicator(Modifier.height(18.dp), strokeWidth = 2.dp) else Text(stringResource(R.string.action_continue))
    }
}

private fun discoveryMessage(e: DiscoveryFailure): Int = when (e) {
    DiscoveryFailure.INVALID_INPUT -> R.string.discovery_invalid_input
    DiscoveryFailure.UNREACHABLE -> R.string.discovery_unreachable
    DiscoveryFailure.INVALID_WELL_KNOWN -> R.string.discovery_invalid_well_known
    DiscoveryFailure.NOT_A_MATRIX_SERVER -> R.string.discovery_not_matrix
    DiscoveryFailure.NO_SUPPORTED_LOGIN -> R.string.discovery_no_login
}

@Composable
private fun SignIn(graph: AppGraph, server: DiscoveredServer) {
    val state by graph.auth.state.collectAsState()
    val context = LocalContext.current
    val c = MaterialTheme.lumenColors
    var browserMissing by remember { mutableStateOf(false) }
    Text(stringResource(R.string.auth_sign_in_to, server.displayName), style = MaterialTheme.typography.headlineSmall, color = c.text, textAlign = TextAlign.Center)
    Spacer(Modifier.height(4.dp))
    Text(server.serverName ?: server.homeserverUrl, style = MaterialTheme.typography.bodyMedium, color = c.textMuted)
    Spacer(Modifier.height(24.dp))

    state.error?.let { e ->
        Banner(
            stringResource(
                when (e) {
                    SignInError.SSO_FAILED -> R.string.auth_error_sso
                    SignInError.SSO_START_FAILED -> R.string.auth_error_sso_start
                    SignInError.PASSWORD_FAILED -> R.string.auth_error_password
                    SignInError.CALLBACK_IGNORED -> R.string.auth_error_callback
                },
            ),
            BannerKind.DANGER, R.drawable.ic_lucide_circle_alert,
        )
        Spacer(Modifier.height(16.dp))
    }
    if (browserMissing) {
        Banner(stringResource(R.string.auth_no_browser), BannerKind.DANGER, R.drawable.ic_lucide_circle_alert)
        Spacer(Modifier.height(16.dp))
    }

    Column(verticalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.fillMaxWidth()) {
        if (server.loginFlows.sso && server.loginFlows.token) {
            Button(
                onClick = { graph.auth.startSso { url -> browserMissing = !openInBrowser(context, url) } },
                enabled = !state.busy,
                modifier = Modifier.fillMaxWidth().testTag("sso_button"),
            ) {
                if (state.busy) {
                    CircularProgressIndicator(Modifier.height(18.dp), strokeWidth = 2.dp)
                } else {
                    Text(stringResource(R.string.auth_continue_sso, server.lumen?.brandShortName ?: server.displayName))
                }
            }
            if (state.waitingForBrowser) {
                Text(stringResource(R.string.auth_waiting_browser), style = MaterialTheme.typography.bodySmall, color = c.textMuted, textAlign = TextAlign.Center)
            }
        }
        server.lumen?.signupUrl?.let { signup ->
            OutlinedButton(onClick = { browserMissing = !openInBrowser(context, signup) }, modifier = Modifier.fillMaxWidth()) {
                Text(stringResource(R.string.auth_create_account))
            }
        }
        // Password sign-in only when the server offers it and no SSO is available (integration.md §2).
        if (server.loginFlows.password && !(server.loginFlows.sso && server.loginFlows.token)) PasswordForm(graph, state.busy)
        Spacer(Modifier.height(8.dp))
        Text(stringResource(R.string.auth_privacy_note), style = MaterialTheme.typography.bodySmall, color = c.textMuted, textAlign = TextAlign.Center)
        Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.fillMaxWidth()) {
            server.lumen?.privacyUrl?.let { u -> TextButton(onClick = { openInBrowser(context, u) }) { Text(stringResource(R.string.link_privacy)) } }
            server.lumen?.helpUrl?.let { u -> TextButton(onClick = { openInBrowser(context, u) }) { Text(stringResource(R.string.link_help)) } }
            TextButton(onClick = graph.auth::changeServer) { Text(stringResource(R.string.auth_change_server)) }
        }
    }
}

@Composable
private fun PasswordForm(graph: AppGraph, busy: Boolean) {
    var user by rememberSaveable { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    OutlinedTextField(
        value = user, onValueChange = { user = it }, singleLine = true,
        label = { Text(stringResource(R.string.auth_username)) },
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Text, imeAction = ImeAction.Next, autoCorrectEnabled = false),
        modifier = Modifier.fillMaxWidth(),
    )
    OutlinedTextField(
        value = password, onValueChange = { password = it }, singleLine = true,
        label = { Text(stringResource(R.string.auth_password)) },
        visualTransformation = PasswordVisualTransformation(),
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Done),
        modifier = Modifier.fillMaxWidth(),
    )
    Button(
        onClick = {
            graph.auth.passwordLogin(user, password)
            password = ""
        },
        enabled = !busy && user.isNotBlank() && password.isNotEmpty(),
        modifier = Modifier.fillMaxWidth(),
    ) { Text(stringResource(R.string.auth_sign_in)) }
}
