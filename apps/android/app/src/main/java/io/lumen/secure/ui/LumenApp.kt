package io.lumen.secure.ui

import androidx.activity.compose.PredictiveBackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.ContentTransform
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.ui.graphics.graphicsLayer
import io.lumen.secure.ui.theme.LumenEase
import io.lumen.secure.ui.theme.LumenMotion
import io.lumen.secure.ui.theme.brandWash
import kotlin.coroutines.cancellation.CancellationException
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
    val ringing by graph.calls.ringing.collectAsState()
    val encryption by graph.encryption.collectAsState()

    // Predictive back: the screen follows the gesture (scales down and shifts), then pops on release.
    var backProgress by remember { mutableFloatStateOf(0f) }
    PredictiveBackHandler(enabled = nav.stack.size > 1) { events ->
        try {
            events.collect { backProgress = it.progress }
            backProgress = 0f
            nav.pop()
        } catch (e: CancellationException) {
            backProgress = 0f
            throw e
        }
    }

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
                modifier = Modifier.statusBarsPadding(),
            )
        }
        Box(Modifier.weight(1f).then(if (ringing != null) Modifier.consumeWindowInsets(WindowInsets.statusBars) else Modifier)) {
            val top = nav.top
            ListDetailLayout(
                detail = if (top == Screen.Rooms) null else DetailEntry(top, nav.stack.size),
                backProgress = backProgress,
                list = { RoomListScreen(graph, session, nav, selectedRoomId = (nav.stack.firstOrNull { it is Screen.Room } as? Screen.Room)?.roomId) },
                detailContent = { entry, twoPane -> ScreenContent(graph, session, nav, entry.screen, twoPane = twoPane) },
            )
        }
    }

    nav.pendingLink?.let { link -> LinkConfirmDialog(graph, session, nav, link) }
    encryption?.let { VerificationDialog(it) }
}

/** A detail screen and its depth in the back stack (deeper means the transition moves forward). */
data class DetailEntry<T>(val screen: T, val depth: Int)

/** From this window width on, the room list stays beside the chat (tablets, unfolded foldables, landscape). */
val TwoPaneMinWidth = 720.dp

private fun detailTransition(forward: Boolean): ContentTransform {
    val dir = if (forward) 1 else -1
    return (fadeIn(tween(LumenMotion.durMedMillis, easing = LumenEase.Out)) + slideInHorizontally(tween(LumenMotion.durMedMillis, easing = LumenEase.Out)) { w -> dir * w / 8 }) togetherWith
        (fadeOut(tween(LumenMotion.durFastMillis, easing = LumenEase.Out)) + slideOutHorizontally(tween(LumenMotion.durMedMillis, easing = LumenEase.Out)) { w -> -dir * w / 16 })
}

/**
 * List-detail layout: on wide windows the [list] stays on the left and the detail fills the rest;
 * on narrow windows only one of them is shown. Screen changes slide and fade (220 ms, ease-out;
 * Compose follows the system animator duration scale), and [backProgress] lets the detail follow
 * a predictive back gesture.
 */
@Composable
fun <T> ListDetailLayout(
    detail: DetailEntry<T>?,
    backProgress: Float = 0f,
    list: @Composable () -> Unit,
    detailContent: @Composable (DetailEntry<T>, twoPane: Boolean) -> Unit,
) {
    val c = MaterialTheme.lumenColors
    val backModifier = Modifier.graphicsLayer {
        val p = backProgress
        if (p > 0f) {
            scaleX = 1f - 0.08f * p
            scaleY = 1f - 0.08f * p
            translationX = 32.dp.toPx() * p
            shape = RoundedCornerShape(28.dp * p)
            clip = true
        }
    }
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val twoPane = maxWidth >= TwoPaneMinWidth
        if (twoPane) {
            val listWidth = if (maxWidth >= 1000.dp) 400.dp else 360.dp
            Row(Modifier.fillMaxSize()) {
                Box(Modifier.width(listWidth).fillMaxHeight()) { list() }
                VerticalDivider(color = c.border)
                AnimatedContent(
                    targetState = detail,
                    transitionSpec = { detailTransition((targetState?.depth ?: 0) >= (initialState?.depth ?: 0)) },
                    contentKey = { it?.screen },
                    modifier = Modifier.weight(1f).fillMaxHeight().background(c.bg),
                    label = "detail",
                ) { entry ->
                    if (entry != null) {
                        Box(Modifier.fillMaxSize().then(if (entry == detail) backModifier else Modifier)) { detailContent(entry, true) }
                    } else {
                        Box(Modifier.fillMaxSize().brandWash()) {
                            CenteredState(
                                title = stringResource(R.string.empty_detail_title),
                                body = stringResource(R.string.empty_detail_body),
                                icon = R.drawable.ic_lucide_messages_square,
                            )
                        }
                    }
                }
            }
        } else {
            AnimatedContent(
                targetState = detail,
                transitionSpec = { detailTransition((targetState?.depth ?: 0) >= (initialState?.depth ?: 0)) },
                contentKey = { it?.screen },
                modifier = Modifier.fillMaxSize().background(c.bg),
                label = "screen",
            ) { entry ->
                if (entry != null) {
                    Box(Modifier.fillMaxSize().then(if (entry == detail) backModifier else Modifier)) { detailContent(entry, false) }
                } else {
                    list()
                }
            }
        }
    }
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
        Screen.About -> AboutScreen(graph, session, nav)
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
