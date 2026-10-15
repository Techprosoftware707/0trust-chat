package io.lumen.secure

import io.lumen.secure.core.notifications.NotificationPreview
import io.lumen.secure.core.security.AutoLockTimeout
import io.lumen.secure.data.ReceiptMode
import io.lumen.secure.data.UserSettings
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SettingsDefaultsTest {
    @Test
    fun `privacy defaults`() {
        val s = UserSettings()
        assertEquals(NotificationPreview.HIDDEN, s.preview)
        assertFalse(s.keepConnected)
        assertFalse(s.appLock)
        assertEquals(AutoLockTimeout.MINUTE_1, s.autoLock)
        // Same defaults as the web client (services/chat/src/lib/prefs.ts).
        assertEquals(ReceiptMode.PUBLIC, s.receipts)
        assertTrue(s.typing)
        assertEquals(ReceiptMode.PUBLIC, ReceiptMode.fromKey(null))
        assertEquals(ReceiptMode.OFF, ReceiptMode.fromKey("off"))
    }

    @Test
    fun `build configuration`() {
        // The pusher app_id is <applicationId>.android (integration.md §1).
        assertEquals(BuildConfig.APPLICATION_ID + ".android", BuildConfig.PUSHER_APP_ID)
        // Debug builds accept loopback http; release builds never do (checked by the release unit test task).
        assertEquals(BuildConfig.DEBUG, BuildConfig.ALLOW_LOOPBACK_HTTP)
        // FCM is all-or-nothing.
        val fcm = listOf(BuildConfig.FCM_PROJECT_ID, BuildConfig.FCM_APP_ID, BuildConfig.FCM_API_KEY, BuildConfig.FCM_SENDER_ID)
        assertEquals(BuildConfig.FCM_CONFIGURED, fcm.all { it.isNotEmpty() })
    }
}
