package io.lumen.secure.auth

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import io.lumen.secure.LumenApplication
import io.lumen.secure.ui.MainActivity

/**
 * Receives `io.lumen.secure:/sso-callback?n=…&loginToken=…` from the browser. The URI is handed to
 * the session manager, which completes the sign-in only if it matches the pending attempt's nonce
 * (anything else is ignored). The app UI follows the auth state.
 */
class SsoCallbackActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val uri = intent?.data?.toString()
        if (uri != null && intent?.action == Intent.ACTION_VIEW) {
            LumenApplication.graph(this).auth.onSsoCallback(uri)
        }
        startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP))
        finish()
    }
}
