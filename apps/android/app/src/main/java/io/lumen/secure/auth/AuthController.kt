package io.lumen.secure.auth

import io.lumen.secure.BuildConfig
import io.lumen.secure.core.config.DiscoveredServer
import io.lumen.secure.core.config.DiscoveryFailure
import io.lumen.secure.core.config.DiscoveryResult
import io.lumen.secure.core.config.ServerDiscovery
import io.lumen.secure.log.LumenLog
import io.lumen.secure.matrix.SessionManager
import io.lumen.secure.matrix.SsoFinishResult
import io.lumen.secure.net.PlatformHttp
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

enum class SignInError { SSO_FAILED, PASSWORD_FAILED, SSO_START_FAILED, CALLBACK_IGNORED }

data class AuthFlowState(
    val serverInput: String = BuildConfig.DEFAULT_SERVER,
    val discovering: Boolean = false,
    val discoveryError: DiscoveryFailure? = null,
    val server: DiscoveredServer? = null,
    val busy: Boolean = false,
    val waitingForBrowser: Boolean = false,
    val error: SignInError? = null,
)

/** Server picker → discovery → SSO in Custom Tabs (or password, only if offered). */
class AuthController(private val sessions: SessionManager, private val scope: CoroutineScope) {
    private val _state = MutableStateFlow(AuthFlowState())
    val state: StateFlow<AuthFlowState> = _state.asStateFlow()

    fun setInput(s: String) = _state.update { it.copy(serverInput = s, discoveryError = null) }

    fun discover() {
        val input = _state.value.serverInput
        _state.update { it.copy(discovering = true, discoveryError = null) }
        scope.launch {
            val result = withContext(Dispatchers.IO) { ServerDiscovery(PlatformHttp, BuildConfig.ALLOW_LOOPBACK_HTTP).discover(input) }
            _state.update {
                when (result) {
                    is DiscoveryResult.Ok -> it.copy(discovering = false, server = result.server)
                    is DiscoveryResult.Failed -> it.copy(discovering = false, discoveryError = result.reason)
                }
            }
        }
    }

    fun changeServer() {
        scope.launch { sessions.abandonPendingSso() }
        _state.update { it.copy(server = null, error = null, waitingForBrowser = false, busy = false) }
    }

    /** Prepares SSO; [open] receives the URL to show in Custom Tabs. */
    fun startSso(open: (String) -> Unit) {
        val server = _state.value.server ?: return
        _state.update { it.copy(busy = true, error = null) }
        scope.launch {
            try {
                val url = sessions.startSso(server)
                _state.update { it.copy(busy = false, waitingForBrowser = true) }
                withContext(Dispatchers.Main) { open(url) }
            } catch (e: Exception) {
                LumenLog.w("auth", "SSO start failed", e)
                _state.update { it.copy(busy = false, error = SignInError.SSO_START_FAILED) }
            }
        }
    }

    fun onSsoCallback(uri: String) {
        _state.update { it.copy(busy = true) }
        scope.launch {
            val r = sessions.finishSso(uri)
            _state.update {
                when (r) {
                    SsoFinishResult.Success -> AuthFlowState()
                    SsoFinishResult.Ignored -> it.copy(busy = false, error = if (it.waitingForBrowser) SignInError.CALLBACK_IGNORED else it.error)
                    is SsoFinishResult.Failed -> it.copy(busy = false, waitingForBrowser = false, error = SignInError.SSO_FAILED)
                }
            }
        }
    }

    /** The user came back from the browser without completing sign-in. */
    fun browserClosed() {
        if (_state.value.waitingForBrowser && !_state.value.busy) _state.update { it.copy(waitingForBrowser = false) }
    }

    fun passwordLogin(user: String, password: String) {
        val server = _state.value.server ?: return
        _state.update { it.copy(busy = true, error = null) }
        scope.launch {
            try {
                sessions.passwordLogin(server, user, password)
                _state.value = AuthFlowState()
            } catch (e: Exception) {
                LumenLog.w("auth", "password login failed", e)
                _state.update { it.copy(busy = false, error = SignInError.PASSWORD_FAILED) }
            }
        }
    }
}
