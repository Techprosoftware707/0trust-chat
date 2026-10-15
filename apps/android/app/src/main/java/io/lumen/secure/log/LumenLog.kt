package io.lumen.secure.log

import android.util.Log
import io.lumen.secure.BuildConfig
import io.lumen.secure.core.log.Redactor

/**
 * The app's only logger. Messages are fixed strings plus error *types*; everything passes through
 * [Redactor] (no tokens, keys, identifiers, message bodies or room names, integration.md §9).
 * Debug and verbose output exists only in debug builds; release builds log warnings and errors
 * to logcat only. There is no crash reporter and nothing is sent anywhere.
 */
object LumenLog {
    private const val TAG = "Lumen"

    fun d(scope: String, message: String) {
        if (BuildConfig.DEBUG) Log.d(TAG, "[$scope] " + Redactor.redact(message))
    }

    fun i(scope: String, message: String) {
        if (BuildConfig.DEBUG) Log.i(TAG, "[$scope] " + Redactor.redact(message))
    }

    fun w(scope: String, message: String, t: Throwable? = null) {
        Log.w(TAG, "[$scope] " + Redactor.redact(message) + (t?.let { " (" + Redactor.describe(it) + ")" } ?: ""))
    }

    fun e(scope: String, message: String, t: Throwable? = null) {
        Log.e(TAG, "[$scope] " + Redactor.redact(message) + (t?.let { " (" + Redactor.describe(it) + ")" } ?: ""))
    }
}
