package io.lumen.secure.ui

import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import io.lumen.secure.BuildConfig
import io.lumen.secure.LumenApplication
import io.lumen.secure.R
import io.lumen.secure.core.deeplink.DeepLinkRoute
import io.lumen.secure.core.deeplink.DeepLinkRouter
import io.lumen.secure.core.matrix.MatrixIds
import io.lumen.secure.matrix.AuthState
import io.lumen.secure.ui.nav.NavViewModel
import io.lumen.secure.ui.theme.LumenTheme
import kotlinx.coroutines.launch

class MainActivity : FragmentActivity() {
    private val graph by lazy { LumenApplication.graph(this) }
    private val nav: NavViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        val splash = installSplashScreen()
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        splash.setKeepOnScreenCondition { graph.sessions.state.value is AuthState.Restoring }

        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                graph.settings.state.collect { s ->
                    if (s.secureScreen) window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
                    else window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
                }
            }
        }
        setContent {
            LumenTheme {
                LumenApp(graph = graph, nav = nav, onUnlockRequest = ::promptUnlock)
            }
        }
        if (savedInstanceState == null) handleIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIntent(intent)
    }

    override fun onResume() {
        super.onResume()
        graph.auth.browserClosed()
    }

    private fun handleIntent(intent: Intent?) {
        intent ?: return
        when (intent.action) {
            ACTION_OPEN_ROOM -> intent.getStringExtra(EXTRA_ROOM_ID)?.takeIf(MatrixIds::isRoomId)?.let { nav.openRoom(it) }
            Intent.ACTION_VIEW -> {
                val url = intent.dataString ?: return
                val hosts = BuildConfig.APP_LINK_HOSTS.split(',').filter { it.isNotBlank() }.toSet()
                when (val route = DeepLinkRouter.route(url, pendingSsoNonce = null, appScheme = BuildConfig.APPLICATION_ID, appLinkHosts = hosts)) {
                    is DeepLinkRoute.Room, is DeepLinkRoute.User -> nav.pendingLink = route // always confirmed first
                    else -> Unit
                }
            }
        }
    }

    /** BiometricPrompt: class 3 biometrics or the device PIN/pattern/password. */
    private fun promptUnlock() {
        val authenticators = lockAuthenticators()
        if (BiometricManager.from(this).canAuthenticate(authenticators) != BiometricManager.BIOMETRIC_SUCCESS) {
            // No screen lock any more: the app lock cannot work, so it is turned off.
            graph.settings.update { it.copy(appLock = false) }
            graph.appLock.applySettings()
            return
        }
        val prompt = BiometricPrompt(
            this, ContextCompat.getMainExecutor(this),
            object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                    graph.appLock.unlocked()
                }
            },
        )
        prompt.authenticate(
            BiometricPrompt.PromptInfo.Builder()
                .setTitle(getString(R.string.lock_prompt_title))
                .setSubtitle(getString(R.string.lock_prompt_subtitle))
                .setAllowedAuthenticators(authenticators)
                .build(),
        )
    }

    companion object {
        const val ACTION_OPEN_ROOM = "io.lumen.secure.OPEN_ROOM"
        const val EXTRA_ROOM_ID = "room_id"

        /** BIOMETRIC_STRONG | DEVICE_CREDENTIAL needs Android 11; before that, any biometric or the credential. */
        fun lockAuthenticators(): Int = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            BiometricManager.Authenticators.BIOMETRIC_STRONG or BiometricManager.Authenticators.DEVICE_CREDENTIAL
        } else {
            BiometricManager.Authenticators.BIOMETRIC_WEAK or BiometricManager.Authenticators.DEVICE_CREDENTIAL
        }
    }
}
