package io.lumen.secure.screenshots

import androidx.compose.runtime.Composable
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import io.lumen.secure.auth.AuthFlowState
import io.lumen.secure.matrix.SasEmoji
import io.lumen.secure.matrix.VerificationUi
import io.lumen.secure.push.PushStatus
import io.lumen.secure.ui.screens.AuthActions
import io.lumen.secure.ui.screens.AuthContent
import io.lumen.secure.ui.screens.RoomActions
import io.lumen.secure.ui.screens.RoomContent
import io.lumen.secure.ui.screens.RoomData
import io.lumen.secure.ui.screens.RoomInfoActions
import io.lumen.secure.ui.screens.RoomInfoContent
import io.lumen.secure.ui.screens.RoomListActions
import io.lumen.secure.ui.screens.RoomListContent
import io.lumen.secure.ui.screens.RoomListUiState
import io.lumen.secure.ui.screens.RoomUiState
import io.lumen.secure.ui.screens.SettingsActions
import io.lumen.secure.ui.screens.SettingsContent
import io.lumen.secure.ui.screens.SettingsUiState
import io.lumen.secure.ui.screens.VerificationActions
import io.lumen.secure.ui.screens.VerificationContent
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.ParameterizedRobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * The busiest screens at the largest system font size (200%), where clipping and truncation show
 * up first. Same output folder and naming as [ScreensScreenshotTest].
 */
@RunWith(ParameterizedRobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35])
class LargeTextScreenshotTest(private val v: Variant) {
    companion object {
        @JvmStatic
        @ParameterizedRobolectricTestRunner.Parameters(name = "{0}")
        fun variants(): List<Array<Any>> = listOf(
            Variant(Device.PHONE, dark = false, fontScale = 2f),
            Variant(Device.PHONE_SMALL, dark = true, fontScale = 2f),
        ).map { arrayOf(it) }
    }

    @get:Rule val rule = createEmptyComposeRule()

    private fun shoot(name: String, v: Variant, content: @Composable () -> Unit) = shoot(rule, name, v, content = content)

    private val f = Fixtures

    @Test fun auth_server_picker() = shoot("auth_server_picker", v) { AuthContent(AuthFlowState(serverInput = "lumen.example"), null, false, AuthActions()) }

    @Test fun rooms_populated() = shoot("rooms_populated", v) {
        RoomListContent(RoomListUiState(brand = "Lumen Secure", loading = false, rooms = f.rooms, invites = 1), RoomListActions())
    }

    @Test fun room_timeline() = shoot("room_timeline", v) {
        RoomContent(RoomData(header = f.header, rows = f.timeline, atStart = true, callsAvailable = true), RoomUiState(), showBack = true, RoomActions())
    }

    @Test fun room_info() = shoot("room_info", v) {
        RoomInfoContent(f.groupHeader.name, "Planning, drafts and launch logistics.", encrypted = true, error = false, members = f.members, selfUserId = Fixtures.ME, actions = RoomInfoActions())
    }

    @Test fun settings() = shoot("settings", v) {
        SettingsContent(
            SettingsUiState(userId = Fixtures.ME, deviceId = "ABCDEFGHIJ", push = PushStatus.NOT_IN_BUILD, accountUrl = "https://lumen.example/portal/"),
            SettingsActions(),
        )
    }

    @Test fun verify_emoji() = shoot("verify_emoji", v) {
        VerificationContent(
            VerificationUi.Emojis(
                listOf(
                    SasEmoji("🐶", "Dog"), SasEmoji("🔑", "Key"), SasEmoji("🎸", "Guitar"), SasEmoji("🌍", "Globe"),
                    SasEmoji("🚀", "Rocket"), SasEmoji("🍄", "Mushroom"), SasEmoji("🎩", "Hat"),
                ),
            ),
            VerificationActions(),
        )
    }
}
