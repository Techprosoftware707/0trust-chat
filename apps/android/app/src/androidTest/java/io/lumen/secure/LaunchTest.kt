package io.lumen.secure

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextClearance
import androidx.compose.ui.test.performTextInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.lumen.secure.ui.MainActivity
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Launch → server picker. Runs without a server. The last test needs a reachable Lumen server and
 * is skipped unless the instrumentation argument LUMEN_TEST_SERVER is set, e.g.
 * `-Pandroid.testInstrumentationRunnerArguments.LUMEN_TEST_SERVER=example.com`.
 */
@RunWith(AndroidJUnit4::class)
class LaunchTest {
    @get:Rule
    val compose = createAndroidComposeRule<MainActivity>()

    private fun waitForPicker() = compose.waitUntil(timeoutMillis = 20_000) {
        compose.onAllNodes(hasTestTag("server_input")).fetchSemanticsNodes().isNotEmpty()
    }

    @Test
    fun freshInstallShowsServerPicker() {
        waitForPicker()
        compose.onNodeWithTag("server_input").assertIsDisplayed()
        compose.onNodeWithTag("server_continue").assertIsDisplayed()
    }

    @Test
    fun continueNeedsInputAndInvalidInputIsRejected() {
        waitForPicker()
        compose.onNodeWithTag("server_input").performTextClearance()
        compose.onNodeWithTag("server_continue").assertIsNotEnabled()
        compose.onNodeWithTag("server_input").performTextInput("not a server!")
        compose.onNodeWithTag("server_continue").assertIsEnabled().performClick()
        // Invalid input is refused locally, without network access.
        compose.waitUntil(5_000) { compose.onAllNodes(hasTestTag("sso_button")).fetchSemanticsNodes().isEmpty() }
        compose.onNodeWithTag("server_input").assertIsDisplayed()
    }

    @Test
    fun discoversConfiguredTestServer() {
        val server = InstrumentationRegistry.getArguments().getString("LUMEN_TEST_SERVER")
        assumeTrue("LUMEN_TEST_SERVER not set", !server.isNullOrBlank())
        waitForPicker()
        compose.onNodeWithTag("server_input").performTextClearance()
        compose.onNodeWithTag("server_input").performTextInput(server!!)
        compose.onNodeWithTag("server_continue").performClick()
        compose.waitUntil(30_000) { compose.onAllNodes(hasTestTag("sso_button")).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("sso_button").assertIsDisplayed()
    }
}
