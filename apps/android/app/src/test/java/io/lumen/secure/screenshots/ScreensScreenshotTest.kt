package io.lumen.secure.screenshots

import androidx.compose.ui.res.stringResource
import io.lumen.secure.R
import io.lumen.secure.auth.AuthFlowState
import io.lumen.secure.auth.SignInError
import io.lumen.secure.calls.Incoming
import io.lumen.secure.calls.Message
import io.lumen.secure.core.config.DiscoveryFailure
import io.lumen.secure.matrix.ConnectionState
import io.lumen.secure.matrix.IdentityWarning
import io.lumen.secure.matrix.RecoverySetup
import io.lumen.secure.matrix.RoomCategory
import io.lumen.secure.matrix.SasEmoji
import io.lumen.secure.matrix.SignOutReason
import io.lumen.secure.matrix.TimelineRow
import io.lumen.secure.matrix.VerificationUi
import io.lumen.secure.net.UiaChallenge
import io.lumen.secure.push.PushStatus
import io.lumen.secure.ui.DetailEntry
import io.lumen.secure.ui.ListDetailLayout
import io.lumen.secure.ui.screens.AboutContent
import io.lumen.secure.ui.screens.AuthActions
import io.lumen.secure.ui.screens.AuthContent
import io.lumen.secure.ui.screens.BlockedUsersContent
import io.lumen.secure.ui.screens.DevicesActions
import io.lumen.secure.ui.screens.DevicesContent
import io.lumen.secure.ui.screens.EncryptionActions
import io.lumen.secure.ui.screens.EncryptionContent
import io.lumen.secure.ui.screens.LockScreen
import io.lumen.secure.ui.screens.NewChatActions
import io.lumen.secure.ui.screens.NewChatContent
import io.lumen.secure.ui.screens.RecoveryKeyDialog
import io.lumen.secure.ui.screens.RoomActions
import io.lumen.secure.ui.screens.RoomContent
import io.lumen.secure.ui.screens.RoomData
import io.lumen.secure.ui.screens.RoomInfoActions
import io.lumen.secure.ui.screens.RoomInfoContent
import io.lumen.secure.ui.screens.RoomListActions
import io.lumen.secure.ui.screens.RoomListContent
import io.lumen.secure.ui.screens.RoomListUiState
import io.lumen.secure.ui.screens.RoomUiState
import io.lumen.secure.ui.screens.SecurityContent
import io.lumen.secure.ui.screens.SettingsActions
import io.lumen.secure.ui.screens.SettingsContent
import io.lumen.secure.ui.screens.SettingsUiState
import io.lumen.secure.ui.screens.VerificationActions
import io.lumen.secure.ui.screens.VerificationContent
import androidx.compose.runtime.Composable
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.matrix.rustcomponents.sdk.BackupState
import org.matrix.rustcomponents.sdk.RecoveryState
import org.matrix.rustcomponents.sdk.VerificationState
import org.robolectric.ParameterizedRobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import uniffi.matrix_sdk_crypto.IdentityState

/**
 * Every screen state worth looking at, rendered from the real screen composables with fake data on
 * each [Variant]. Run with `./gradlew :app:screenshots`; images land in app/build/outputs/roborazzi/.
 */
@RunWith(ParameterizedRobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35])
class ScreensScreenshotTest(private val v: Variant) {
    companion object {
        @JvmStatic
        @ParameterizedRobolectricTestRunner.Parameters(name = "{0}")
        fun variants(): List<Array<Any>> = Variant.standard.map { arrayOf(it) }
    }

    @get:Rule val rule = createEmptyComposeRule()

    private fun shoot(name: String, v: Variant, content: @Composable () -> Unit) = shoot(rule, name, v, content = content)

    private val f = Fixtures

    // ---- sign-in -----------------------------------------------------------------------------------

    @Test fun auth_server_picker() = shoot("auth_server_picker", v) { AuthContent(AuthFlowState(serverInput = ""), null, false, AuthActions()) }

    @Test fun auth_discovery_error() = shoot("auth_discovery_error", v) {
        AuthContent(AuthFlowState(serverInput = "lumen.exmaple", discoveryError = DiscoveryFailure.UNREACHABLE), null, false, AuthActions())
    }

    @Test fun auth_discovering() = shoot("auth_discovering", v) { AuthContent(AuthFlowState(serverInput = "lumen.example", discovering = true), null, false, AuthActions()) }

    @Test fun auth_sign_in() = shoot("auth_sign_in", v) { AuthContent(AuthFlowState(server = f.server), null, false, AuthActions()) }

    @Test fun auth_waiting_browser() = shoot("auth_waiting_browser", v) {
        AuthContent(AuthFlowState(server = f.server, waitingForBrowser = true), null, false, AuthActions())
    }

    @Test fun auth_error_banners() = shoot("auth_error_banners", v) {
        AuthContent(AuthFlowState(server = f.server, error = SignInError.CALLBACK_IGNORED), SignOutReason.REMOTE, true, AuthActions())
    }

    /** Debug builds: the sign-in error offers "Details" (collapsed here). */
    @Test fun auth_sso_start_error_details() = shoot("auth_sso_start_error_details", v) {
        AuthContent(
            AuthFlowState(
                server = f.server, error = SignInError.SSO_START_FAILED,
                errorDetail = "ClientBuildException.SlidingSyncVersion: error sending request for url (https://lumen.example/…\n" +
                    "TLS: certificate of lumen.example refused: Revoked\nLumen 1.0.0 (debug) · Android 9 (API 28)",
            ),
            null, false, AuthActions(), showErrorDetails = true,
        )
    }

    @Test fun auth_password_server() = shoot("auth_password_server", v) { AuthContent(AuthFlowState(server = f.passwordOnlyServer), null, false, AuthActions()) }

    // ---- room list --------------------------------------------------------------------------------

    private fun list(
        rooms: List<io.lumen.secure.matrix.RoomSummary> = f.rooms, loading: Boolean = false, query: String = "",
        connection: ConnectionState = ConnectionState.CONNECTED, verification: VerificationState = VerificationState.VERIFIED,
        recovery: RecoveryState = RecoveryState.ENABLED, ask: Boolean = false, selected: String? = null,
    ) = RoomListUiState(
        brand = "Lumen Secure", loading = loading, rooms = rooms, query = query, invites = rooms.count { it.isInvite }, connection = connection,
        verification = verification, recovery = recovery, askNotifications = ask, selectedRoomId = selected,
    )

    @Test fun rooms_populated() = shoot("rooms_populated", v) { RoomListContent(list(), RoomListActions()) }

    @Test fun rooms_banners() = shoot("rooms_banners", v) {
        RoomListContent(list(connection = ConnectionState.OFFLINE, verification = VerificationState.UNVERIFIED, ask = true), RoomListActions())
    }

    @Test fun rooms_recovery_banner_search() = shoot("rooms_recovery_banner_search", v) {
        RoomListContent(list(rooms = f.rooms.take(3), recovery = RecoveryState.DISABLED, query = "pla"), RoomListActions())
    }

    @Test fun rooms_empty() = shoot("rooms_empty", v) { RoomListContent(list(rooms = emptyList()), RoomListActions()) }

    @Test fun rooms_loading() = shoot("rooms_loading", v) { RoomListContent(list(rooms = emptyList(), loading = true), RoomListActions()) }

    @Test fun rooms_no_match() = shoot("rooms_no_match", v) {
        RoomListContent(list(rooms = emptyList(), query = "zebra"), RoomListActions())
    }

    // ---- room / timeline -------------------------------------------------------------------------

    private fun room(
        header: io.lumen.secure.matrix.RoomHeader? = f.header, rows: List<TimelineRow> = f.timeline, typing: List<String> = emptyList(),
        warnings: List<IdentityWarning> = emptyList(), error: Boolean = false,
    ) = RoomData(header = header, rows = rows, typing = typing, warnings = warnings, error = error, atStart = true, callsAvailable = true)

    @Test fun room_timeline() = shoot("room_timeline", v) { RoomContent(room(), RoomUiState(), showBack = true, RoomActions()) }

    @Test fun room_group_typing() = shoot("room_group_typing", v) {
        RoomContent(room(header = f.groupHeader, typing = listOf("Jonas")), RoomUiState(composerText = "A longer draft that wraps onto a second line in the composer, to see how it grows."), showBack = true, RoomActions())
    }

    @Test fun room_reply_composer() = shoot("room_reply_composer", v) {
        val target = f.timeline.filterIsInstance<TimelineRow.Event>().first { !it.isOwn && it.content is io.lumen.secure.matrix.RowContent.Text }
        RoomContent(room(), RoomUiState(replyTo = target, composerText = "Thanks, see you there"), showBack = true, RoomActions())
    }

    @Test fun room_message_actions() = shoot("room_message_actions", v) {
        val target = f.timeline.filterIsInstance<TimelineRow.Event>().first { it.isOwn && it.content is io.lumen.secure.matrix.RowContent.Text }
        RoomContent(room(), RoomUiState(menuFor = target), showBack = true, RoomActions())
    }

    @Test fun room_warnings() = shoot("room_warnings", v) {
        RoomContent(
            room(
                header = f.unencryptedHeader, error = true,
                warnings = listOf(IdentityWarning("@jonas:lumen.example", "Jonas Okafor", IdentityState.PIN_VIOLATION)),
            ),
            RoomUiState(), showBack = true, RoomActions(),
        )
    }

    @Test fun room_invite() = shoot("room_invite", v) { RoomContent(room(header = f.inviteHeader, rows = emptyList()), RoomUiState(), showBack = true, RoomActions()) }

    @Test fun room_empty() = shoot("room_empty", v) { RoomContent(room(rows = emptyList()), RoomUiState(), showBack = true, RoomActions()) }

    @Test fun room_loading() = shoot("room_loading", v) { RoomContent(room(header = null, rows = emptyList()), RoomUiState(), showBack = true, RoomActions()) }

    @Test fun room_search() = shoot("room_search", v) {
        val hits = f.timeline.filterIsInstance<TimelineRow.Event>().filter { (it.content.searchableText ?: "").contains("the", ignoreCase = true) }
        RoomContent(room(), RoomUiState(searching = true, searchQuery = "the"), showBack = true, RoomActions(onSearch = { hits }))
    }

    @Test fun list_detail() = shoot("list_detail", v) {
        ListDetailLayout(
            detail = DetailEntry("!maya:x", 2),
            list = { RoomListContent(list(selected = "!maya:x"), RoomListActions()) },
            detailContent = { _, twoPane -> RoomContent(room(), RoomUiState(), showBack = !twoPane, RoomActions()) },
        )
    }

    @Test fun list_no_detail() = shoot("list_no_detail", v) {
        ListDetailLayout<String>(detail = null, list = { RoomListContent(list(), RoomListActions()) }, detailContent = { _, _ -> })
    }

    // ---- details, new chat, settings ------------------------------------------------------------

    @Test fun room_info() = shoot("room_info", v) {
        RoomInfoContent(f.groupHeader.name, "Planning, drafts and launch logistics.", encrypted = true, error = false, members = f.members, selfUserId = Fixtures.ME, actions = RoomInfoActions())
    }

    @Test fun room_info_unencrypted() = shoot("room_info_unencrypted", v) {
        RoomInfoContent("Community lobby", null, encrypted = false, error = true, members = null, selfUserId = Fixtures.ME, actions = RoomInfoActions())
    }

    @Test fun new_chat() = shoot("new_chat", v) { NewChatContent(busy = false, error = false, actions = NewChatActions(), initialTerm = "@maya:lumen.example") }

    @Test fun new_chat_group() = shoot("new_chat_group", v) { NewChatContent(busy = false, error = true, actions = NewChatActions(), initialGroup = true) }

    private val settingsState = SettingsUiState(
        userId = Fixtures.ME, deviceId = "ABCDEFGHIJ", push = PushStatus.NOT_IN_BUILD,
        accountUrl = "https://lumen.example/portal/", privacyUrl = "https://lumen.example/privacy/", helpUrl = "https://lumen.example/help/",
        accountDeleteUrl = "https://lumen.example/portal/delete/",
    )

    @Test fun settings() = shoot("settings", v) { SettingsContent(settingsState, SettingsActions()) }

    @Test fun settings_app_lock() = shoot("settings_app_lock", v) {
        SettingsContent(settingsState.copy(settings = settingsState.settings.copy(appLock = true, secureScreen = true), askFullScreenIntent = true), SettingsActions())
    }

    @Test fun security() = shoot("security", v) { SecurityContent(strongBox = false) {} }

    @Test fun about() = shoot("about", v) { AboutContent(
            "lumen.example", "https://matrix.lumen.example", Fixtures.ME, "ABCDEFGHIJ", VerificationState.VERIFIED, "1a2b3c4d5e",
            callsBundled = true, onBack = {}, onLicenses = {},
        ) }

    @Test fun blocked_empty() = shoot("blocked_empty", v) { BlockedUsersContent(emptyList(), {}, {}) }

    @Test fun devices() = shoot("devices", v) {
        DevicesContent(
            f.devices, loading = false, failed = false, pending = f.devices[1] to UiaChallenge("s", ssoFallback = true, password = false),
            currentDeviceId = "ABCDEFGHIJ", thisDevice = VerificationState.VERIFIED, actions = DevicesActions(),
        )
    }

    // ---- encryption, verification, lock, calls ------------------------------------------------------

    @Test fun encryption_unverified() = shoot("encryption_unverified", v) {
        EncryptionContent(VerificationState.UNVERIFIED, RecoveryState.INCOMPLETE, BackupState.UNKNOWN, RecoverySetup.Idle, EncryptionActions())
    }

    @Test fun encryption_ok() = shoot("encryption_ok", v) {
        EncryptionContent(VerificationState.VERIFIED, RecoveryState.ENABLED, BackupState.ENABLED, RecoverySetup.Working(120, 480), EncryptionActions())
    }

    @Test fun encryption_recover_dialog() = shoot("encryption_recover_dialog", v) {
        EncryptionContent(VerificationState.UNVERIFIED, RecoveryState.INCOMPLETE, BackupState.UNKNOWN, RecoverySetup.Idle, EncryptionActions(), initiallyRecovering = true)
    }

    @Test fun recovery_key() = shoot("recovery_key", v) { RecoveryKeyDialog(Fixtures.RECOVERY_KEY) {} }

    @Test fun verify_emoji() = shoot("verify_emoji", v) {
        VerificationContent(
            VerificationUi.Emojis(
                listOf(
                    SasEmoji("🐶", "Dog"), SasEmoji("🔑", "Key"), SasEmoji("🎸", "Guitar"), SasEmoji("🌍", "Globe"),
                    SasEmoji("☂️", "Umbrella"), SasEmoji("🚀", "Rocket"), SasEmoji("🍎", "Apple"),
                ),
            ),
            VerificationActions(),
        )
    }

    @Test fun verify_incoming() = shoot("verify_incoming", v) {
        VerificationContent(VerificationUi.IncomingRequest(Fixtures.ME, "Alex", "KLMNOPQRST", "Lumen web (Firefox on Linux)", "f"), VerificationActions())
    }

    @Test fun verify_waiting() = shoot("verify_waiting", v) { VerificationContent(VerificationUi.Waiting(null), VerificationActions()) }

    @Test fun verify_done() = shoot("verify_done", v) { VerificationContent(VerificationUi.Done, VerificationActions()) }

    @Test fun lock() = shoot("lock", v) { LockScreen {} }

    @Test fun call_incoming() = shoot("call_incoming", v) { Incoming("Maya Lindqvist", video = true, onAnswer = {}, onDecline = {}) }

    @Test fun call_unavailable() = shoot("call_unavailable", v) {
        Message(stringResource(R.string.call_unavailable_title), stringResource(R.string.call_unavailable_body), onClose = {})
    }
}
