package io.lumen.secure.matrix

import io.lumen.secure.log.LumenLog
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import org.matrix.rustcomponents.sdk.BackupState
import org.matrix.rustcomponents.sdk.BackupStateListener
import org.matrix.rustcomponents.sdk.EnableRecoveryProgress
import org.matrix.rustcomponents.sdk.EnableRecoveryProgressListener
import org.matrix.rustcomponents.sdk.RecoveryState
import org.matrix.rustcomponents.sdk.RecoveryStateListener
import org.matrix.rustcomponents.sdk.SessionVerificationController
import org.matrix.rustcomponents.sdk.SessionVerificationControllerDelegate
import org.matrix.rustcomponents.sdk.SessionVerificationData
import org.matrix.rustcomponents.sdk.SessionVerificationRequestDetails
import org.matrix.rustcomponents.sdk.TaskHandle
import org.matrix.rustcomponents.sdk.VerificationState
import org.matrix.rustcomponents.sdk.VerificationStateListener

data class SasEmoji(val symbol: String, val description: String)

/** SAS verification (`m.sas.v1`) through the SDK's SessionVerificationController. */
sealed interface VerificationUi {
    data object Idle : VerificationUi
    data class IncomingRequest(val fromUserId: String, val fromName: String?, val deviceId: String, val deviceName: String?, val flowId: String) : VerificationUi
    data class Waiting(val otherUserId: String?) : VerificationUi
    data object Starting : VerificationUi
    data class Emojis(val emojis: List<SasEmoji>) : VerificationUi
    data class Decimals(val values: List<Int>) : VerificationUi
    data object Done : VerificationUi
    data class Cancelled(val reason: String?) : VerificationUi
    data object Failed : VerificationUi
}

sealed interface RecoverySetup {
    data object Idle : RecoverySetup
    data class Working(val backedUp: Int?, val total: Int?) : RecoverySetup
    /** The key is shown exactly once; the user must confirm they stored it. */
    data class ShowKey(val key: String) : RecoverySetup
    data class Error(val error: Throwable) : RecoverySetup
}

/** Recovery (key backup + secret storage), this device's verification state and SAS flows. */
class EncryptionController(private val session: MatrixSession) {
    private val encryption = session.client.encryption()
    private val handles = mutableListOf<TaskHandle>()

    private val _recovery = MutableStateFlow(RecoveryState.UNKNOWN)
    val recovery: StateFlow<RecoveryState> = _recovery.asStateFlow()
    private val _backup = MutableStateFlow(BackupState.UNKNOWN)
    val backup: StateFlow<BackupState> = _backup.asStateFlow()
    private val _verification = MutableStateFlow(VerificationState.UNKNOWN)
    val verification: StateFlow<VerificationState> = _verification.asStateFlow()
    private val _sas = MutableStateFlow<VerificationUi>(VerificationUi.Idle)
    val sas: StateFlow<VerificationUi> = _sas.asStateFlow()
    private val _setup = MutableStateFlow<RecoverySetup>(RecoverySetup.Idle)
    val setup: StateFlow<RecoverySetup> = _setup.asStateFlow()

    private var controller: SessionVerificationController? = null

    fun start() {
        _recovery.value = encryption.recoveryState()
        _backup.value = encryption.backupState()
        _verification.value = encryption.verificationState()
        handles += encryption.recoveryStateListener(object : RecoveryStateListener {
            override fun onUpdate(status: RecoveryState) { _recovery.value = status }
        })
        handles += encryption.backupStateListener(object : BackupStateListener {
            override fun onUpdate(status: BackupState) { _backup.value = status }
        })
        handles += encryption.verificationStateListener(object : VerificationStateListener {
            override fun onUpdate(status: VerificationState) { _verification.value = status }
        })
        session.scope.launch {
            try {
                controller().also { } // registers the delegate so incoming requests are seen
            } catch (e: Exception) {
                LumenLog.w("crypto", "verification controller unavailable", e)
            }
        }
    }

    private suspend fun controller(): SessionVerificationController = controller ?: session.client.getSessionVerificationController().also { c ->
        controller = c
        c.setDelegate(delegate)
    }

    private val delegate = object : SessionVerificationControllerDelegate {
        override fun didReceiveVerificationRequest(details: SessionVerificationRequestDetails) {
            _sas.value = VerificationUi.IncomingRequest(
                fromUserId = details.senderProfile.userId,
                fromName = details.senderProfile.displayName,
                deviceId = details.deviceId,
                deviceName = details.deviceDisplayName,
                flowId = details.flowId,
            )
        }

        override fun didAcceptVerificationRequest() {
            // The other side accepted our request: we start SAS.
            _sas.value = VerificationUi.Starting
            session.scope.launch { act { controller().startSasVerification() } }
        }

        override fun didStartSasVerification() {
            _sas.value = VerificationUi.Starting
        }

        override fun didReceiveVerificationData(data: SessionVerificationData) {
            _sas.value = when (data) {
                is SessionVerificationData.Emojis -> VerificationUi.Emojis(data.emojis.map { SasEmoji(it.symbol(), it.description()) })
                is SessionVerificationData.Decimals -> VerificationUi.Decimals(data.values.map { it.toInt() })
            }
        }

        override fun didFail() { _sas.value = VerificationUi.Failed }

        override fun didCancel() {
            val info = controller?.sasCancelInfo() ?: controller?.requestCancelInfo()
            _sas.value = VerificationUi.Cancelled(info?.reason)
        }

        override fun didFinish() { _sas.value = VerificationUi.Done }
    }

    /** Verify this device with another of the user's devices. */
    fun verifyThisDevice() = session.scope.launch {
        _sas.value = VerificationUi.Waiting(null)
        act { controller().requestDeviceVerification() }
    }

    /** Verify a contact (the request is sent in a direct chat with them). */
    fun verifyUser(userId: String) = session.scope.launch {
        _sas.value = VerificationUi.Waiting(userId)
        act { controller().requestUserVerification(userId) }
    }

    fun acceptIncoming(req: VerificationUi.IncomingRequest) = session.scope.launch {
        _sas.value = VerificationUi.Waiting(req.fromUserId)
        act {
            val c = controller()
            c.acknowledgeVerificationRequest(req.fromUserId, req.flowId)
            c.acceptVerificationRequest()
        }
    }

    fun confirmMatch() = session.scope.launch { act { controller().approveVerification() } }
    fun reportMismatch() = session.scope.launch { act { controller().declineVerification() } }

    fun cancel() = session.scope.launch {
        act { controller().cancelVerification() }
        _sas.value = VerificationUi.Idle
    }

    fun dismiss() {
        _sas.value = VerificationUi.Idle
    }

    private suspend fun act(block: suspend () -> Unit) {
        try {
            block()
        } catch (e: Exception) {
            LumenLog.w("crypto", "verification step failed", e)
            _sas.value = VerificationUi.Failed
        }
    }

    // ---- recovery ----------------------------------------------------------------------------

    fun enableRecovery() = session.scope.launch {
        _setup.value = RecoverySetup.Working(null, null)
        try {
            val key = encryption.enableRecovery(
                false,
                null,
                object : EnableRecoveryProgressListener {
                    override fun onUpdate(status: EnableRecoveryProgress) {
                        if (status is EnableRecoveryProgress.BackingUp) {
                            _setup.value = RecoverySetup.Working(status.backedUpCount.toInt(), status.totalCount.toInt())
                        }
                    }
                },
            )
            _setup.value = RecoverySetup.ShowKey(key)
        } catch (e: Exception) {
            LumenLog.w("crypto", "enable recovery failed", e)
            _setup.value = RecoverySetup.Error(e)
        }
    }

    fun resetRecoveryKey() = session.scope.launch {
        _setup.value = RecoverySetup.Working(null, null)
        try {
            _setup.value = RecoverySetup.ShowKey(encryption.resetRecoveryKey())
        } catch (e: Exception) {
            LumenLog.w("crypto", "reset recovery key failed", e)
            _setup.value = RecoverySetup.Error(e)
        }
    }

    /** After the user confirmed they saved the key, it is dropped from memory. */
    fun keyStored() {
        _setup.value = RecoverySetup.Idle
    }

    suspend fun recover(recoveryKey: String) {
        encryption.recover(recoveryKey.trim())
    }

    fun stop() {
        handles.forEach { it.cancel() }
        handles.clear()
        controller?.setDelegate(null)
    }
}
