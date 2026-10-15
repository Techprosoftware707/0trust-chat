package io.lumen.secure.security

import android.os.SystemClock
import io.lumen.secure.core.security.AppLockTimer
import io.lumen.secure.data.Settings
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * App lock (ADR 0003 D7): BiometricPrompt (class 3) or the device credential, with an auto-lock
 * timeout. It protects against someone picking up an unlocked phone; it does not protect against
 * a compromised operating system.
 */
class AppLockManager(private val settings: Settings) {
    private val timer = AppLockTimer { SystemClock.elapsedRealtime() }
    private val _locked = MutableStateFlow(false)
    val locked: StateFlow<Boolean> = _locked.asStateFlow()

    fun init() {
        val s = settings.current
        timer.configure(s.appLock, s.autoLock, startLocked = true)
        _locked.value = timer.locked
    }

    fun applySettings() {
        val s = settings.current
        timer.configure(s.appLock, s.autoLock, startLocked = false)
        _locked.value = timer.locked
    }

    fun onBackground() = timer.onBackground()

    fun onForeground() {
        _locked.value = timer.onForeground()
    }

    fun lockNow() {
        timer.lockNow()
        _locked.value = timer.locked
    }

    fun unlocked() {
        timer.onUnlocked()
        _locked.value = false
    }
}
