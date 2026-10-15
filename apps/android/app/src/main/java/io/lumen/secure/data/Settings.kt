package io.lumen.secure.data

import android.content.Context
import android.content.SharedPreferences
import androidx.core.content.edit
import io.lumen.secure.core.notifications.NotificationPreview
import io.lumen.secure.core.security.AutoLockTimeout
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** Read-receipt privacy (integration.md §5). */
enum class ReceiptMode(val key: String) {
    /** `m.read`: others see what you have read. */
    PUBLIC("public"),

    /** `m.read.private`: unread state syncs across your devices, others see nothing. */
    PRIVATE("private"),

    /** Only the private fully-read marker is moved. */
    OFF("off"),
    ;

    companion object {
        fun fromKey(k: String?) = entries.firstOrNull { it.key == k } ?: PUBLIC
    }
}

data class UserSettings(
    val preview: NotificationPreview = NotificationPreview.DEFAULT,
    val receipts: ReceiptMode = ReceiptMode.PUBLIC,
    val typing: Boolean = true,
    val appLock: Boolean = false,
    val autoLock: AutoLockTimeout = AutoLockTimeout.DEFAULT,
    val secureScreen: Boolean = false,
    val keepConnected: Boolean = false,
)

/**
 * Non-secret preferences (no tokens or keys here; those live in the Keystore-sealed vault).
 * Excluded from backups like everything else (data_extraction_rules.xml).
 */
class Settings(context: Context) {
    private val prefs: SharedPreferences = context.getSharedPreferences("lumen_settings", Context.MODE_PRIVATE)
    private val _state = MutableStateFlow(read())
    val state: StateFlow<UserSettings> = _state.asStateFlow()
    val current: UserSettings get() = _state.value

    private fun read() = UserSettings(
        preview = NotificationPreview.fromKey(prefs.getString(K_PREVIEW, null)),
        receipts = ReceiptMode.fromKey(prefs.getString(K_RECEIPTS, null)),
        typing = prefs.getBoolean(K_TYPING, true),
        appLock = prefs.getBoolean(K_APP_LOCK, false),
        autoLock = AutoLockTimeout.fromKey(prefs.getString(K_AUTO_LOCK, null)),
        secureScreen = prefs.getBoolean(K_SECURE_SCREEN, false),
        keepConnected = prefs.getBoolean(K_KEEP_CONNECTED, false),
    )

    fun update(block: (UserSettings) -> UserSettings) {
        val next = block(_state.value)
        prefs.edit {
            putString(K_PREVIEW, next.preview.key)
            putString(K_RECEIPTS, next.receipts.key)
            putBoolean(K_TYPING, next.typing)
            putBoolean(K_APP_LOCK, next.appLock)
            putString(K_AUTO_LOCK, next.autoLock.key)
            putBoolean(K_SECURE_SCREEN, next.secureScreen)
            putBoolean(K_KEEP_CONNECTED, next.keepConnected)
        }
        _state.value = next
    }

    /** Sign-out: back to defaults (privacy-preserving). */
    fun reset() {
        prefs.edit { clear() }
        _state.value = UserSettings()
    }

    private companion object {
        const val K_PREVIEW = "notification_preview"
        const val K_RECEIPTS = "read_receipts"
        const val K_TYPING = "typing_notifications"
        const val K_APP_LOCK = "app_lock"
        const val K_AUTO_LOCK = "auto_lock"
        const val K_SECURE_SCREEN = "secure_screen"
        const val K_KEEP_CONNECTED = "keep_connected"
    }
}
