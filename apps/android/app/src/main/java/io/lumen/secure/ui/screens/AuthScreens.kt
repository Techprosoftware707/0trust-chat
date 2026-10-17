package io.lumen.secure.ui.screens

import android.content.ActivityNotFoundException
import android.content.Context
import androidx.core.net.toUri
import androidx.browser.customtabs.CustomTabsIntent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Icon
import androidx.compose.material3.Surface
import androidx.compose.ui.res.painterResource
import io.lumen.secure.ui.components.Pill
import io.lumen.secure.ui.components.PrimaryButton
import io.lumen.secure.ui.theme.LumenEase
import io.lumen.secure.ui.theme.brandHero
import io.lumen.secure.ui.theme.brandWash
import io.lumen.secure.ui.theme.isDark
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
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
import io.lumen.secure.auth.AuthFlowState
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

/** Everything the sign-in screens do, as callbacks (the stateful wiring is in [AuthFlow]). */
class AuthActions(
    val onInput: (String) -> Unit = {},
    val onDiscover: () -> Unit = {},
    val onSso: () -> Unit = {},
    val onOpenUrl: (String) -> Unit = {},
    val onChangeServer: () -> Unit = {},
    val onPassword: (user: String, password: String) -> Unit = { _, _ -> },
)

@Composable
fun AuthFlow(graph: AppGraph, reason: SignOutReason?) {
    val state by graph.auth.state.collectAsState()
    val context = LocalContext.current
    var browserMissing by remember { mutableStateOf(false) }
    AuthContent(
        state = state,
        reason = reason,
        browserMissing = browserMissing,
        actions = remember(graph) {
            AuthActions(
                onInput = graph.auth::setInput,
                onDiscover = graph.auth::discover,
                onSso = { graph.auth.startSso { url -> browserMissing = !openInBrowser(context, url) } },
                onOpenUrl = { url -> browserMissing = !openInBrowser(context, url) },
                onChangeServer = {
                    browserMissing = false
                    graph.auth.changeServer()
                },
                onPassword = graph.auth::passwordLogin,
            )
        },
    )
}

@Composable
fun AuthContent(state: AuthFlowState, reason: SignOutReason?, browserMissing: Boolean, actions: AuthActions) {
    val dark = MaterialTheme.isDark
    // Light mode: the airy brand wash. Dark mode: the midnight hero with its sunrise glow.
    Box(Modifier.fillMaxSize().then(if (dark) Modifier.brandHero() else Modifier.brandWash(1.6f))) {
        BoxWithConstraints(Modifier.fillMaxSize().safeDrawingPadding()) {
            Column(
                Modifier.verticalScroll(rememberScrollState()).heightIn(min = maxHeight).fillMaxWidth().padding(horizontal = 20.dp, vertical = 24.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center,
            ) {
                Column(Modifier.widthIn(max = 440.dp).fillMaxWidth().animateContentSize(LumenEase.med()), horizontalAlignment = Alignment.CenterHorizontally) {
                    LogoMark(60.dp, glow = true)
                    if (reason == SignOutReason.REMOTE) {
                        Spacer(Modifier.height(8.dp))
                        Banner(stringResource(R.string.signed_out_remote), BannerKind.WARNING, R.drawable.ic_lucide_triangle_alert, modifier = Modifier.padding(horizontal = 0.dp))
                    }
                    val server = state.server
                    if (server == null) ServerPicker(state, actions) else SignIn(state, server, browserMissing, actions)
                }
            }
        }
    }
}

/** The card the sign-in controls sit on: white on the wash in light mode, a tonal step in dark mode. */
@Composable
private fun AuthCard(content: @Composable ColumnScope.() -> Unit) {
    val c = MaterialTheme.lumenColors
    val dark = MaterialTheme.isDark
    Surface(
        shape = MaterialTheme.shapes.large,
        color = if (dark) c.surface.copy(alpha = 0.92f) else c.surface,
        border = BorderStroke(1.dp, c.border),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(14.dp), content = content)
    }
}

@Composable
private fun ServerPicker(state: AuthFlowState, actions: AuthActions) {
    val c = MaterialTheme.lumenColors
    Spacer(Modifier.height(4.dp))
    Pill(stringResource(R.string.auth_new), icon = R.drawable.ic_lucide_sparkles)
    Spacer(Modifier.height(16.dp))
    Text(stringResource(R.string.auth_welcome), style = MaterialTheme.typography.headlineMedium, color = c.text, textAlign = TextAlign.Center)
    Spacer(Modifier.height(8.dp))
    Text(stringResource(R.string.auth_tagline), style = MaterialTheme.typography.bodyLarge, color = c.textMuted, textAlign = TextAlign.Center)
    Spacer(Modifier.height(28.dp))
    AuthCard {
        Text(stringResource(R.string.auth_server_explain), style = MaterialTheme.typography.bodyMedium, color = c.textMuted)
        OutlinedTextField(
            value = state.serverInput,
            onValueChange = actions.onInput,
            label = { Text(stringResource(R.string.auth_server_label)) },
            placeholder = { Text(stringResource(R.string.auth_server_placeholder)) },
            leadingIcon = { Icon(painterResource(R.drawable.ic_lucide_server), null) },
            singleLine = true,
            shape = MaterialTheme.shapes.medium,
            isError = state.discoveryError != null,
            supportingText = state.discoveryError?.let { e -> { Text(stringResource(discoveryMessage(e))) } },
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Go, autoCorrectEnabled = false),
            keyboardActions = KeyboardActions(onGo = { if (state.serverInput.isNotBlank()) actions.onDiscover() }),
            modifier = Modifier.fillMaxWidth().testTag("server_input"),
        )
        PrimaryButton(
            text = stringResource(R.string.action_continue),
            onClick = actions.onDiscover,
            enabled = state.discovering || state.serverInput.isNotBlank(),
            loading = state.discovering,
            modifier = Modifier.fillMaxWidth().testTag("server_continue"),
        )
    }
}

private fun discoveryMessage(e: DiscoveryFailure): Int = when (e) {
    DiscoveryFailure.INVALID_INPUT -> R.string.discovery_invalid_input
    DiscoveryFailure.UNREACHABLE -> R.string.discovery_unreachable
    DiscoveryFailure.INVALID_WELL_KNOWN -> R.string.discovery_invalid_well_known
    DiscoveryFailure.NOT_A_MATRIX_SERVER -> R.string.discovery_not_matrix
    DiscoveryFailure.NO_SUPPORTED_LOGIN -> R.string.discovery_no_login
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun SignIn(state: AuthFlowState, server: DiscoveredServer, browserMissing: Boolean, actions: AuthActions) {
    val c = MaterialTheme.lumenColors
    Spacer(Modifier.height(12.dp))
    Text(stringResource(R.string.auth_sign_in_to, server.displayName), style = MaterialTheme.typography.headlineSmall, color = c.text, textAlign = TextAlign.Center)
    Spacer(Modifier.height(10.dp))
    Pill(server.serverName ?: server.homeserverUrl, icon = R.drawable.ic_lucide_globe)
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
            modifier = Modifier.padding(bottom = 8.dp),
        )
    }
    if (browserMissing) {
        Banner(stringResource(R.string.auth_no_browser), BannerKind.DANGER, R.drawable.ic_lucide_circle_alert, modifier = Modifier.padding(bottom = 8.dp))
    }

    AuthCard {
        if (server.loginFlows.sso && server.loginFlows.token) {
            PrimaryButton(
                text = stringResource(R.string.auth_continue_sso, server.lumen?.brandShortName ?: server.displayName),
                onClick = actions.onSso,
                enabled = true,
                loading = state.busy,
                modifier = Modifier.fillMaxWidth().testTag("sso_button"),
            )
            if (state.waitingForBrowser) {
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
                    Icon(painterResource(R.drawable.ic_lucide_external_link), null, tint = c.accent, modifier = Modifier.size(16.dp))
                    Spacer(Modifier.width(8.dp))
                    Text(stringResource(R.string.auth_waiting_browser), style = MaterialTheme.typography.bodySmall, color = c.textMuted)
                }
            }
        }
        server.lumen?.signupUrl?.let { signup ->
            OutlinedButton(
                onClick = { actions.onOpenUrl(signup) },
                shape = MaterialTheme.shapes.medium,
                modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp),
            ) { Text(stringResource(R.string.auth_create_account)) }
        }
        // Password sign-in only when the server offers it and no SSO is available (integration.md §2).
        if (server.loginFlows.password && !(server.loginFlows.sso && server.loginFlows.token)) PasswordForm(actions, state.busy)
    }
    Spacer(Modifier.height(16.dp))
    Row(verticalAlignment = Alignment.Top, modifier = Modifier.fillMaxWidth().padding(horizontal = 4.dp)) {
        Icon(painterResource(R.drawable.ic_lucide_lock), null, tint = c.textSubtle, modifier = Modifier.padding(top = 2.dp).size(14.dp))
        Spacer(Modifier.width(8.dp))
        Text(stringResource(R.string.auth_privacy_note), style = MaterialTheme.typography.bodySmall, color = c.textMuted)
    }
    Spacer(Modifier.height(8.dp))
    FlowRow(horizontalArrangement = Arrangement.Center, modifier = Modifier.fillMaxWidth()) {
        server.lumen?.privacyUrl?.let { u -> TextButton(onClick = { actions.onOpenUrl(u) }) { Text(stringResource(R.string.link_privacy)) } }
        server.lumen?.helpUrl?.let { u -> TextButton(onClick = { actions.onOpenUrl(u) }) { Text(stringResource(R.string.link_help)) } }
        TextButton(onClick = actions.onChangeServer) { Text(stringResource(R.string.auth_change_server)) }
    }
}

@Composable
private fun PasswordForm(actions: AuthActions, busy: Boolean) {
    var user by rememberSaveable { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    OutlinedTextField(
        value = user, onValueChange = { user = it }, singleLine = true,
        label = { Text(stringResource(R.string.auth_username)) },
        shape = MaterialTheme.shapes.medium,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Text, imeAction = ImeAction.Next, autoCorrectEnabled = false),
        modifier = Modifier.fillMaxWidth(),
    )
    OutlinedTextField(
        value = password, onValueChange = { password = it }, singleLine = true,
        label = { Text(stringResource(R.string.auth_password)) },
        shape = MaterialTheme.shapes.medium,
        visualTransformation = PasswordVisualTransformation(),
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Done),
        modifier = Modifier.fillMaxWidth(),
    )
    PrimaryButton(
        text = stringResource(R.string.auth_sign_in),
        onClick = {
            actions.onPassword(user, password)
            password = ""
        },
        enabled = busy || (user.isNotBlank() && password.isNotEmpty()),
        loading = busy,
        modifier = Modifier.fillMaxWidth(),
    )
}
