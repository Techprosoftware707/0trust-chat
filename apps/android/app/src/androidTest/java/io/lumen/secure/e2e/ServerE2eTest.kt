package io.lumen.secure.e2e

import android.app.Activity
import android.app.Instrumentation
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.SystemClock
import android.util.Log
import androidx.browser.customtabs.CustomTabsIntent
import androidx.compose.ui.test.ComposeTimeoutException
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextClearance
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.printToLog
import androidx.test.espresso.intent.Intents
import androidx.test.espresso.intent.Intents.intending
import androidx.test.espresso.intent.matcher.IntentMatchers.hasAction
import androidx.test.espresso.intent.matcher.IntentMatchers.hasData
import androidx.test.espresso.intent.matcher.UriMatchers.hasScheme
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.filters.LargeTest
import androidx.test.platform.app.InstrumentationRegistry
import io.lumen.secure.BuildConfig
import io.lumen.secure.LumenApplication
import io.lumen.secure.R
import io.lumen.secure.auth.SsoCallbackActivity
import io.lumen.secure.matrix.AuthState
import io.lumen.secure.matrix.SignOutReason
import io.lumen.secure.net.PlatformHttp
import io.lumen.secure.ui.MainActivity
import kotlinx.coroutines.runBlocking
import org.hamcrest.Matchers.allOf
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.FixMethodOrder
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TestWatcher
import org.junit.runner.Description
import org.junit.runner.RunWith
import org.junit.runners.MethodSorters
import java.io.File
import java.security.KeyStore
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64

/**
 * The app against a real Lumen server (`install.sh --test`), driven through its UI on a device or
 * emulator that trusts the server's test CA as a user CA. Orchestrated by
 * `tests/apps/android-e2e/run.sh`, one phase per instrumentation run, in this order:
 *
 *  a. discovery and sign-in through the portal's single sign-on (the browser is stubbed; the test
 *     plays the browser over HTTPS and delivers the callback URL the way a browser does);
 *  b. after a web user (Playwright, `tests/apps/android-e2e/web-user.mjs`) has invited this account
 *     to an encrypted direct chat and written in it: accept, read the message decrypted, reply;
 *  c. sign out: the server no longer accepts the token and the local data is gone.
 *
 * The app process restarts between phases, so b and c also cover restoring the session from the
 * Keystore-sealed store. Every phase is skipped unless its instrumentation arguments are given,
 * so `connectedDebugAndroidTest` without arguments skips them all.
 *
 * Arguments: LUMEN_E2E_SERVER (server name); a: LUMEN_E2E_USER, LUMEN_E2E_PASSWORD (portal account
 * created by the orchestrator), LUMEN_E2E_CA_SHA256 (optional: assert the user CA); b:
 * LUMEN_E2E_EXPECT (marker in the web user's message), LUMEN_E2E_REPLY (marker for the reply),
 * LUMEN_E2E_PEER (optional: the inviter's user ID); c: LUMEN_E2E_SIGN_OUT=true.
 * Secrets (password, cookies, login and access tokens) are never logged or put in messages.
 */
@RunWith(AndroidJUnit4::class)
@LargeTest
@FixMethodOrder(MethodSorters.NAME_ASCENDING)
class ServerE2eTest {
    @get:Rule(order = 0)
    val compose = createAndroidComposeRule<MainActivity>()

    /** Inner rule: runs while the activity is still up, so the screenshot shows the failure. */
    @get:Rule(order = 1)
    val onFailure = object : TestWatcher() {
        override fun failed(e: Throwable, description: Description) = captureFailure(description.methodName)
    }

    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private val graph get() = LumenApplication.graph(context)
    private val args = InstrumentationRegistry.getArguments()

    // ---- a. discovery and single sign-on ---------------------------------------------------------

    @Test
    fun a_signInThroughPortalSso() {
        val server = requireArg(SERVER)
        val user = requireArg(USER)
        val password = requireArg(PASSWORD)

        arg(CA_SHA256)?.let { fp -> step("device trusts the server's test CA as a user CA (not a system CA)") { assertUserCa(fp) } }

        step("discovery: the server name leads to the sign-in screen with single sign-on") {
            waitForTag("server_input", 30_000)
            compose.onNodeWithTag("server_input").performTextClearance()
            compose.onNodeWithTag("server_input").performTextInput(server)
            compose.onNodeWithTag("server_continue").performClick()
            waitForTag("sso_button", 60_000)
            compose.onNodeWithTag("sso_button").assertIsDisplayed()
        }

        val ssoUrl = step("single sign-on opens the homeserver's SSO URL in Custom Tabs") {
            Intents.init()
            try {
                // The browser is stubbed: the test plays the browser below.
                intending(allOf(hasAction(Intent.ACTION_VIEW), hasData(hasScheme("https"))))
                    .respondWith(Instrumentation.ActivityResult(Activity.RESULT_CANCELED, null))
                compose.onNodeWithTag("sso_button").performClick()
                val opened = waitFor(90_000, "the app to open the browser") {
                    Intents.getIntents().lastOrNull { it.action == Intent.ACTION_VIEW && it.data?.scheme == "https" }
                }
                assertTrue("opened as a Custom Tab", opened.hasExtra(CustomTabsIntent.EXTRA_SESSION))
                opened.dataString!!
            } finally {
                Intents.release()
            }
        }

        val nonce = step("the SSO URL carries the app's redirect with a fresh per-attempt nonce") {
            val sso = Uri.parse(ssoUrl)
            assertEquals("https", sso.scheme)
            assertTrue("SSO host is under the server name (${sso.host})", sso.host?.endsWith(server) == true)
            assertTrue("SSO path (${sso.path})", sso.path?.startsWith("/_matrix/client/v3/login/sso/redirect") == true)
            val redirect = sso.getQueryParameter("redirectUrl") ?: throw AssertionError("no redirectUrl in the SSO URL")
            assertTrue("redirect is the app's callback", redirect.startsWith("${BuildConfig.APPLICATION_ID}:/sso-callback?"))
            val n = Uri.parse(redirect).getQueryParameter("n")
            assertTrue("nonce present and long enough", (n?.length ?: 0) >= 16)
            n!!
        }

        val callback = step("portal sign-in and the SSO redirect chain over HTTPS end at the app's callback") {
            val browser = PortalBrowser()
            browser.signIn(server, user, password)
            val (cb, hops) = browser.followUntilScheme(ssoUrl, BuildConfig.APPLICATION_ID)
            Log.i(TAG, "redirect chain: $hops")
            val cbUri = Uri.parse(cb)
            assertEquals("callback keeps the app's nonce", nonce, cbUri.getQueryParameter("n"))
            assertFalse("callback carries a login token", cbUri.getQueryParameter("loginToken").isNullOrEmpty())
            cb
        }

        step("only the app's callback activity handles the callback URL") {
            val handlers = context.packageManager.queryIntentActivities(browserIntent(callback), 0)
            assertEquals(listOf(SsoCallbackActivity::class.java.name), handlers.map { it.activityInfo.name })
        }

        step("a callback with another nonce is ignored and its login token is not used") {
            val forged = callback.replace(Regex("([?&]n=)[^&#]*"), "$1${newNonce()}")
            assertTrue(forged != callback)
            context.startActivity(browserIntent(forged))
            waitForText(context.getString(R.string.auth_error_callback), 30_000)
            assertTrue("still signed out", graph.sessions.state.value is AuthState.SignedOut)
        }

        step("the browser's callback signs in: nonce check, m.login.token in the Rust SDK, first sync") {
            context.startActivity(browserIntent(callback))
            waitForRoomList(120_000)
            val session = graph.sessions.session ?: throw AssertionError("no session after sign-in")
            assertEquals("@$user:$server", session.userId)
            Log.i(TAG, "signed in as ${session.userId} on device ${session.deviceId}")
        }

        step("the server has this device's identity and one-time keys, and the device is named") {
            val s = graph.sessions.session!!
            val token = s.client.session().accessToken
            val hs = s.homeserverUrl.trimEnd('/')
            waitFor(120_000, "device keys, one-time keys and the device name on the server") {
                val keys = api("POST", "$hs/_matrix/client/v3/keys/query", token, """{"device_keys":{${JSONObject.quote(s.userId)}:[]}}""")
                val device = keys.optJSONObject("device_keys")?.optJSONObject(s.userId)?.optJSONObject(s.deviceId)
                val otks = api("POST", "$hs/_matrix/client/v3/keys/upload", token, "{}")
                    .optJSONObject("one_time_key_counts")?.optInt("signed_curve25519") ?: 0
                val name = api("GET", "$hs/_matrix/client/v3/devices/${Uri.encode(s.deviceId)}", token, null).optString("display_name")
                Log.i(TAG, "server view: device keys=${device != null}, one-time keys=$otks, name='$name'")
                if (device != null && otks > 0 && name.startsWith("Lumen on ")) true else null
            }
        }
    }

    // ---- b. encrypted direct chat with a web user ----------------------------------------------

    @Test
    fun b_encryptedChatWithWebUser() {
        requireArg(SERVER)
        val expect = requireArg(EXPECT)
        val reply = requireArg(REPLY)
        val peer = arg(PEER)

        step("after the app process restarted, the session is restored and syncs") { waitForRoomList(120_000) }

        val roomId = step("the web user's invitation appears in the room list") {
            waitForTag("invite_accept", 240_000)
            val invite = graph.roomList.value?.visible?.value?.firstOrNull { it.isInvite } ?: throw AssertionError("no invite in the room list")
            if (peer != null) {
                val inviter = runBlocking { graph.sessions.session!!.client.getRoom(invite.id)?.inviter()?.userId }
                assertEquals("invited by the web user", peer, inviter)
            }
            invite.id
        }

        val roomName = step("accepting the invitation in the room list joins the chat") {
            compose.onAllNodesWithTag("invite_accept")[0].performClick()
            waitUi("the chat to be joined", 60_000) {
                graph.roomList.value?.visible?.value?.any { it.id == roomId && !it.isInvite } == true &&
                    compose.onAllNodesWithTag("invite_accept").fetchSemanticsNodes().isEmpty()
            }
            val summary = graph.roomList.value!!.visible.value.first { it.id == roomId }
            assertTrue("room list marks the chat as encrypted", summary.encrypted)
            summary.name
        }

        step("the chat is end-to-end encrypted and shows the web user's message decrypted") {
            compose.onNode(hasTestTag("room_row") and hasText(roomName, substring = true)).performClick()
            waitForText(context.getString(R.string.room_encrypted), 30_000)
            waitUi("the web user's message to be shown decrypted", 180_000) {
                compose.onAllNodes(hasText(expect, substring = true)).fetchSemanticsNodes().isNotEmpty()
            }
            compose.onNodeWithText(expect, substring = true).assertIsDisplayed()
        }

        step("a reply typed in the composer is sent and confirmed by the server") {
            compose.onNodeWithTag("composer_input").performTextInput("Reply from Android $reply")
            compose.onNodeWithTag("composer_send").performClick()
            val delivered = hasContentDescription(context.getString(R.string.delivery_sent)) or
                hasContentDescription(context.getString(R.string.delivery_read))
            waitUi("the reply to be shown as sent", 120_000) {
                compose.onAllNodes(hasText(reply, substring = true) and delivered).fetchSemanticsNodes().isNotEmpty()
            }
        }
    }

    // ---- c. sign-out -----------------------------------------------------------------------------

    @Test
    fun c_signOutEndsTheSession() {
        requireArg(SERVER)
        assumeTrue("$SIGN_OUT not set (phase skipped)", arg(SIGN_OUT) == "true")

        step("after another restart, the session is restored") { waitForRoomList(120_000) }
        val s = graph.sessions.session!!
        val token = s.client.session().accessToken
        val hs = s.homeserverUrl.trimEnd('/')

        step("the access token is valid before signing out") { assertEquals(200, whoamiStatus(hs, token)) }

        step("Settings → Sign out → confirm returns to the server picker") {
            compose.onNodeWithTag("settings_button").performClick()
            waitForTag("sign_out_row", 15_000)
            compose.onNodeWithTag("sign_out_row").performScrollTo().performClick()
            compose.onNodeWithTag("sign_out_confirm").performClick()
            waitForTag("server_input", 60_000)
            val state = graph.sessions.state.value
            assertTrue("signed out by the user ($state)", state is AuthState.SignedOut && state.reason == SignOutReason.USER)
        }

        step("the server no longer accepts the old access token") { assertEquals(401, whoamiStatus(hs, token)) }

        step("local data is gone: stores, sealed session and its Keystore key") {
            assertTrue("no session stores", File(context.noBackupFilesDir, "sessions").listFiles().isNullOrEmpty())
            assertTrue("no session caches", File(context.cacheDir, "sessions").listFiles().isNullOrEmpty())
            assertTrue("no sealed secrets", File(context.noBackupFilesDir, "vault").listFiles()?.none { it.name.endsWith(".bin") } ?: true)
            val keystore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
            assertFalse("vault key deleted", keystore.containsAlias("lumen_vault_v1"))
        }
    }

    // ---- helpers ---------------------------------------------------------------------------------

    private fun arg(name: String): String? = args.getString(name)?.takeIf { it.isNotBlank() }

    private fun requireArg(name: String): String {
        val v = arg(name)
        assumeTrue("$name not set (phase skipped)", v != null)
        return v!!
    }

    private inline fun <T> step(name: String, block: () -> T): T {
        Log.i(TAG, "STEP $name")
        try {
            return block().also { Log.i(TAG, "PASS $name") }
        } catch (e: Throwable) {
            Log.e(TAG, "FAIL $name: ${e.javaClass.simpleName}: ${e.message?.lineSequence()?.firstOrNull()}")
            throw e
        }
    }

    private fun waitUi(what: String, timeoutMs: Long, condition: () -> Boolean) {
        try {
            compose.waitUntil(timeoutMs, condition)
        } catch (e: ComposeTimeoutException) {
            throw AssertionError("timed out after ${timeoutMs / 1000} s waiting for $what")
        }
    }

    private fun waitForTag(tag: String, timeoutMs: Long) = waitUi("'$tag' on screen", timeoutMs) {
        compose.onAllNodesWithTag(tag).fetchSemanticsNodes().isNotEmpty()
    }

    private fun waitForText(text: String, timeoutMs: Long) = waitUi("text \"$text\" on screen", timeoutMs) {
        compose.onAllNodes(hasText(text, substring = true)).fetchSemanticsNodes().isNotEmpty()
    }

    /** Signed in, and the room list has loaded (rooms, or the empty state for a new account). */
    private fun waitForRoomList(timeoutMs: Long) = waitUi("the signed-in room list", timeoutMs) {
        graph.sessions.state.value is AuthState.SignedIn &&
            compose.onAllNodesWithTag("settings_button").fetchSemanticsNodes().isNotEmpty() &&
            (
                compose.onAllNodesWithTag("room_list").fetchSemanticsNodes().isNotEmpty() ||
                    compose.onAllNodes(hasText(context.getString(R.string.rooms_empty_title))).fetchSemanticsNodes().isNotEmpty()
                )
    }

    private fun <T : Any> waitFor(timeoutMs: Long, what: String, probe: () -> T?): T {
        val end = SystemClock.uptimeMillis() + timeoutMs
        var last: Exception? = null
        while (SystemClock.uptimeMillis() < end) {
            try {
                probe()?.let { return it }
            } catch (e: Exception) {
                last = e
            }
            SystemClock.sleep(1_000)
        }
        throw AssertionError("timed out after ${timeoutMs / 1000} s waiting for $what" + (last?.let { " (last error: ${it.javaClass.simpleName})" } ?: ""))
    }

    /** As a browser hands a URL to the app: implicit VIEW intent, browsable, new task. */
    private fun browserIntent(url: String) = Intent(Intent.ACTION_VIEW, Uri.parse(url))
        .addCategory(Intent.CATEGORY_BROWSABLE)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

    private fun newNonce(): String = ByteArray(24).also { SecureRandom().nextBytes(it) }.let { Base64.getUrlEncoder().withoutPadding().encodeToString(it) }

    /** Client-server API call with the app's own HTTPS client (same trust as the app). */
    private fun api(method: String, url: String, token: String, body: String?): JSONObject {
        val r = PlatformHttp.request(method, url, token, body)
        if (r.status != 200) throw IllegalStateException("HTTP ${r.status} for ${PortalBrowser.hostAndPath(url)}")
        return JSONObject(r.body)
    }

    private fun whoamiStatus(hs: String, token: String) = PlatformHttp.request("GET", "$hs/_matrix/client/v3/account/whoami", token, null).status

    private fun assertUserCa(sha256: String) {
        val want = sha256.replace(":", "").lowercase()
        val store = KeyStore.getInstance("AndroidCAStore").apply { load(null) }
        val aliases = store.aliases().toList()
        fun fp(alias: String) = MessageDigest.getInstance("SHA-256").digest(store.getCertificate(alias).encoded).joinToString("") { "%02x".format(it) }
        val user = aliases.filter { it.startsWith("user:") }
        assertNotNull("user CA store has the test CA (user CAs: $user)", user.firstOrNull { fp(it) == want })
        assertTrue("the test CA is not a system CA", aliases.filter { it.startsWith("system:") }.none { fp(it) == want })
    }

    private fun captureFailure(name: String) {
        try {
            val dir = File(context.getExternalFilesDir(null), "e2e").apply { mkdirs() }
            instrumentation.uiAutomation.takeScreenshot()?.let { bmp ->
                File(dir, "$name.png").outputStream().use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
            }
        } catch (e: Exception) {
            Log.w(TAG, "screenshot failed", e)
        }
        try {
            compose.onRoot(useUnmergedTree = true).printToLog(TAG)
        } catch (e: Throwable) {
            Log.w(TAG, "semantics tree not available: ${e.message?.lineSequence()?.firstOrNull()}")
        }
    }

    private companion object {
        const val TAG = "LumenE2E"
        const val SERVER = "LUMEN_E2E_SERVER"
        const val USER = "LUMEN_E2E_USER"
        const val PASSWORD = "LUMEN_E2E_PASSWORD"
        const val CA_SHA256 = "LUMEN_E2E_CA_SHA256"
        const val EXPECT = "LUMEN_E2E_EXPECT"
        const val REPLY = "LUMEN_E2E_REPLY"
        const val PEER = "LUMEN_E2E_PEER"
        const val SIGN_OUT = "LUMEN_E2E_SIGN_OUT"
    }
}
