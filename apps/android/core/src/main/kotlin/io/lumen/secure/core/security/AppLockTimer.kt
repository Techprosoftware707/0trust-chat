package io.lumen.secure.core.security

/** Auto-lock timeouts offered in Settings. */
enum class AutoLockTimeout(val key: String, val millis: Long) {
    IMMEDIATELY("0", 0),
    SECONDS_30("30s", 30_000),
    MINUTE_1("1m", 60_000),
    MINUTES_5("5m", 5 * 60_000L),
    MINUTES_15("15m", 15 * 60_000L),
    HOUR_1("1h", 60 * 60_000L),
    ;

    companion object {
        val DEFAULT = MINUTE_1
        fun fromKey(key: String?): AutoLockTimeout = entries.firstOrNull { it.key == key } ?: DEFAULT
    }
}

/**
 * App-lock state machine. Times come from a monotonic clock (elapsedRealtime), so changing the
 * wall clock cannot extend an unlocked session. The app starts locked when the lock is enabled.
 */
class AppLockTimer(private val clock: () -> Long) {
    var enabled: Boolean = false
        private set
    var timeout: AutoLockTimeout = AutoLockTimeout.DEFAULT
        private set
    var locked: Boolean = false
        private set
    private var backgroundedAt: Long? = null

    fun configure(enabled: Boolean, timeout: AutoLockTimeout, startLocked: Boolean) {
        this.enabled = enabled
        this.timeout = timeout
        if (!enabled) {
            locked = false
            backgroundedAt = null
        } else if (startLocked) {
            locked = true
        }
    }

    fun onBackground() {
        if (enabled && !locked) backgroundedAt = clock()
    }

    /** Returns true when the user has to unlock before seeing content. */
    fun onForeground(): Boolean {
        if (!enabled) return false
        val since = backgroundedAt
        if (since != null) {
            val elapsed = clock() - since
            if (elapsed < 0 || elapsed >= timeout.millis) locked = true
            backgroundedAt = null
        }
        return locked
    }

    fun lockNow() {
        if (enabled) locked = true
    }

    fun onUnlocked() {
        locked = false
        backgroundedAt = null
    }
}
