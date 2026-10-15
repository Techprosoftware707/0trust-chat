package io.lumen.secure.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.width
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.VerticalDivider
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import io.lumen.secure.AppGraph
import io.lumen.secure.R
import io.lumen.secure.calls.CallActivity
import io.lumen.secure.core.deeplink.DeepLinkRoute
import io.lumen.secure.log.LumenLog
import io.lumen.secure.matrix.AuthState
import io.lumen.secure.matrix.MatrixSession
import io.lumen.secure.matrix.SignOutReason
import io.lumen.secure.ui.components.Banner
import io.lumen.secure.ui.components.BannerKind
import io.lumen.secure.ui.components.CenteredState
import io.lumen.secure.ui.nav.NavViewModel
import io.lumen.secure.ui.nav.Screen
import io.lumen.secure.ui.screens.AboutScreen
import io.lumen.secure.ui.screens.AuthFlow
import io.lumen.secure.ui.screens.BlockedUsersScreen
import io.lumen.secure.ui.screens.DevicesScreen
import io.lumen.secure.ui.screens.EncryptionScreen
import io.lumen.secure.ui.screens.LicensesScreen
import io.lumen.secure.ui.screens.LockScreen
import io.lumen.secure.ui.screens.NewChatScreen
import io.lumen.secure.ui.screens.RoomInfoScreen
import io.lumen.secure.ui.screens.RoomListScreen
import io.lumen.secure.ui.screens.RoomScreen
import io.lumen.secure.ui.screens.SecurityScreen
import io.lumen.secure.ui.screens.SettingsScreen
import io.lumen.secure.ui.screens.VerificationDialog
import io.lumen.secure.ui.theme.lumenColors
import kotlinx.coroutines.launch

@Composable
fun LumenApp(graph: AppGraph, nav: NavViewModel, onUnlockRequest: () -> Unit) {
    val auth by graph.sessions.state.collectAsState()
    val locked by graph.appLock.locked.collectAsState()
    Surface(Modifier.fillMaxSize(), color = MaterialTheme.lumenColors.bg) {
        Box(Modifier.fillMaxSize()) {
            when (val a = auth) {
                AuthState.Restoring -> CenteredState(stringResource(R.string.state_opening), loading = true)
                is AuthState.SignedOut -> {
                    LaunchedEffect(Unit) { nav.reset() }
                    if (a.reason == SignOutReason.STORE_UNREADABLE) RestoreFailed(graph) else AuthFlow(graph, a.reason)
                }
                is AuthState.SignedIn -> SignedInApp(graph, nav, a.session)
            }
            if (locked && auth is AuthState.SignedIn) {
                LockScreen(onUnlock = onUnlockRequest)
                LaunchedEffect(Unit) { onUnlockRequest() }
            }
        }
    }
}

@Composable
private fun RestoreFailed(graph: AppGraph) {
    val scope = rememberCoroutineScope()
    Column(Modifier.fillMaxSize()) {
        Box(Modifier.weight(1f)) {
            CenteredState(
                title = stringResource(R.string.restore_failed_title),
                body = stringResource(R.string.restore_failed_body),
                icon = R.drawable.ic_lucide_cloud_off,
                actionLabel = stringResource(R.string.action_try_again),
                onAction = { scope.launch { graph.sessions.restore() } },
            )
        }
        // Deletes the local data only; the server session can be removed from another device.
        TextButton(
            onClick = { scope.launch { graph.sessions.signOut(serverSide = false) } },
            modifier = Modifier.align(androidx.compose.ui.Alignment.CenterHorizontally),
        ) { Text(stringResource(R.string.restore_failed_sign_out)) }
    }
}

@Composable
private fun SignedInApp(graph: AppGraph, nav: NavViewModel, session: MatrixSession) {
    val context = LocalContext.current
    BackHandler(enabled = nav.stack.size > 1) { nav.pop() }
    val ringing by graph.calls.ringing.collectAsState()
    val encryption by graph.encryption.collectAsState()

    BoxWithConstraints(Modifier.fillMaxSize()) {
        val twoPane = maxWidth >= 720.dp
        Column(Modifier.fillMaxSize()) {
            ringing?.let { r ->
                Banner(
                    text = r.callerName?.let { stringResource(R.string.notification_incoming_call_from, it) } ?: stringResource(R.string.notification_incoming_call),
                    kind = BannerKind.SUCCESS,
                    icon = R.drawable.ic_lucide_phone_incoming,
                    actionLabel = stringResource(R.string.call_answer),
                    onAction = { context.startActivity(CallActivity.answerIntent(context, r.roomId, false)) },
                    secondaryLabel = stringResource(R.string.call_decline),
                    onSecondary = { graph.calls.declineRinging() },
                )
            }
            if (twoPane) {
                Row(Modifier.fillMaxSize()) {
                    Box(Modifier.width(360.dp).fillMaxHeight()) {
                        RoomListScreen(graph, session, nav, selectedRoomId = (nav.stack.firstOrNull { it is Screen.Room } as? Screen.Room)?.roomId)
                    }
                    VerticalDivider(color = MaterialTheme.lumenColors.border)
                    Box(Modifier.weight(1f).fillMaxHeight()) {
                        val top = nav.top
                        if (top == Screen.Rooms) {
                            CenteredState(
                                title = stringResource(R.string.empty_detail_title),
                                body = stringResource(R.string.empty_detail_body),
                                icon = R.drawable.ic_lucide_messages_square,
                            )
                        } else {
                            ScreenContent(graph, session, nav, top, twoPane = true)
                        }
                    }
                }
            } else {
                ScreenContent(graph, session, nav, nav.top, twoPane = false)
            }
        }
    }

    nav.pendingLink?.let { link -> LinkConfirmDialog(graph, session, nav, link) }
    encryption?.let { VerificationDialog(it) }
}

@Composable
private fun ScreenContent(graph: AppGraph, session: MatrixSession, nav: NavViewModel, screen: Screen, twoPane: Boolean) {
    when (screen) {
        Screen.Rooms -> RoomListScreen(graph, session, nav, selectedRoomId = null)
        is Screen.Room -> RoomScreen(graph, session, nav, screen.roomId, showBack = !twoPane)
        is Screen.RoomInfo -> RoomInfoScreen(graph, session, nav, screen.roomId)
        Screen.NewChat -> NewChatScreen(graph, session, nav)
        Screen.Settings -> SettingsScreen(graph, session, nav)
        Screen.Security -> SecurityScreen(graph, nav)
        Screen.Encryption -> EncryptionScreen(graph, nav)
        Screen.Devices -> DevicesScreen(graph, session, nav)
        Screen.Blocked -> BlockedUsersScreen(session, nav)
        Screen.About -> AboutScreen(graph, nav)
        Screen.Licenses -> LicensesScreen(nav)
    }
}

/** matrix.to / matrix: / App Links: the user always confirms before joining or starting a chat. */
@Composable
private fun LinkConfirmDialog(graph: AppGraph, session: MatrixSession, nav: NavViewModel, link: DeepLinkRoute) {
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    var failed by remember { mutableStateOf(false) }
    val (title, body) = when (link) {
        is DeepLinkRoute.Room -> stringResource(R.string.link_room_title) to stringResource(R.string.link_room_body, link.id)
        is DeepLinkRoute.User -> stringResource(R.string.link_user_title) to stringResource(R.string.link_user_body, link.id)
        else -> return
    }
    AlertDialog(
        onDismissRequest = { nav.pendingLink = null },
        title = { Text(title) },
        text = { Text(if (failed) stringResource(R.string.link_failed) else body) },
        confirmButton = {
            TextButton(
                enabled = !busy,
                onClick = {
                    busy = true
                    scope.launch {
                        try {
                            val roomId = when (link) {
                                is DeepLinkRoute.Room -> {
                                    val existing = session.client.getRoom(link.id)?.takeIf { it.membership() == org.matrix.rustcomponents.sdk.Membership.JOINED }
                                    existing?.id() ?: session.client.joinRoomByIdOrAlias(link.id, link.via).id()
                                }
                                is DeepLinkRoute.User -> io.lumen.secure.matrix.DirectChats.open(session, link.id)
                            }
                            nav.pendingLink = null
                            nav.openRoom(roomId)
                        } catch (e: Exception) {
                            LumenLog.w("link", "open link failed", e)
                            failed = true
                        } finally {
                            busy = false
                        }
                    }
                },
            ) { Text(stringResource(if (link is DeepLinkRoute.User) R.string.link_user_confirm else R.string.link_room_confirm)) }
        },
        dismissButton = { TextButton(onClick = { nav.pendingLink = null }) { Text(stringResource(R.string.action_cancel)) } },
    )
}
