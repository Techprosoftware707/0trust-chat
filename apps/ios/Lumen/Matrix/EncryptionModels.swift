import Foundation
import LumenCore
import MatrixRustSDK
import Observation

/// Recovery (secret storage + key backup) and this device's verification state.
@Observable @MainActor
final class EncryptionModel {
    private(set) var recoveryState: RecoveryState = .unknown
    private(set) var backupState: BackupState = .unknown
    private(set) var verificationState: VerificationState = .unknown
    private(set) var hasOtherDevices = false
    private(set) var initialised = false
    private(set) var recoveryProgress: String?

    @ObservationIgnored let encryption: Encryption
    @ObservationIgnored private var handles: [TaskHandle] = []
    @ObservationIgnored private var tasks: [Task<Void, Never>] = []

    init(encryption: Encryption) {
        self.encryption = encryption
    }

    /// The device can't read its history or prove who it is yet.
    var needsVerification: Bool { initialised && verificationState == .unverified }
    /// No recovery set up on the account at all.
    var needsRecoverySetup: Bool { initialised && recoveryState == .disabled }
    /// Recovery exists but this device hasn't unlocked it.
    var needsRecoveryKey: Bool { initialised && recoveryState == .incomplete }

    func start() {
        recoveryState = encryption.recoveryState()
        backupState = encryption.backupState()
        verificationState = encryption.verificationState()

        let (rs, rc) = makeStream(RecoveryState.self)
        handles.append(encryption.recoveryStateListener(listener: RecoveryListener(rc)))
        tasks.append(Task { [weak self] in for await s in rs { self?.recoveryState = s } })

        let (bs, bc) = makeStream(BackupState.self)
        handles.append(encryption.backupStateListener(listener: BackupListener(bc)))
        tasks.append(Task { [weak self] in for await s in bs { self?.backupState = s } })

        let (vs, vc) = makeStream(VerificationState.self)
        handles.append(encryption.verificationStateListener(listener: VerificationListener(vc)))
        tasks.append(Task { [weak self] in for await s in vs { self?.verificationState = s } })

        tasks.append(Task { [weak self, encryption] in
            await encryption.waitForE2eeInitializationTasks()
            let others = (try? await encryption.hasDevicesToVerifyAgainst()) ?? false
            self?.hasOtherDevices = others
            self?.recoveryState = encryption.recoveryState()
            self?.verificationState = encryption.verificationState()
            self?.initialised = true
        })
    }

    func stop() {
        for t in tasks { t.cancel() }
        for h in handles { h.cancel() }
        tasks.removeAll()
        handles.removeAll()
    }

    /// Creates secret storage and a key backup and returns the new recovery
    /// key. The key is shown once and not stored by the app.
    func enableRecovery() async throws -> String {
        let (stream, cont) = makeStream(EnableRecoveryProgress.self)
        let progressTask = Task { [weak self] in
            for await p in stream {
                switch p {
                case .starting: self?.recoveryProgress = "Starting…"
                case .creatingBackup: self?.recoveryProgress = "Creating the key backup…"
                case .creatingRecoveryKey: self?.recoveryProgress = "Creating the recovery key…"
                case .backingUp(let done, let total): self?.recoveryProgress = "Backing up keys (\(done) of \(total))…"
                case .roomKeyUploadError: self?.recoveryProgress = "Some keys couldn't be uploaded yet; they will be retried."
                case .done: self?.recoveryProgress = nil
                }
            }
        }
        defer { progressTask.cancel(); recoveryProgress = nil }
        return try await encryption.enableRecovery(waitForBackupsToUpload: false, passphrase: nil, progressListener: EnableRecoveryListener(cont))
    }

    /// Unlocks secret storage with the recovery key: cross-signing keys and
    /// the backup key are imported, and this device becomes verified.
    func recover(with key: String) async throws {
        try await encryption.recover(recoveryKey: RecoveryKeyFormat.normalise(key))
    }

    /// Replaces the recovery key (the old one stops working).
    func resetRecoveryKey() async throws -> String {
        try await encryption.resetRecoveryKey()
    }

    var backupLabel: String {
        switch backupState {
        case .enabled: return "On"
        case .creating, .enabling, .resuming: return "Turning on…"
        case .downloading: return "Restoring keys…"
        case .disabling: return "Turning off…"
        case .unknown: return "Off"
        }
    }
}

/// SAS emoji verification of this account's own devices and of contacts
/// (`SessionVerificationController`).
@Observable @MainActor
final class VerificationModel {
    enum Phase: Equatable {
        case idle
        case requesting
        case incoming(sender: String, deviceName: String?, deviceId: String)
        case waitingForOther
        case sasStarted
        case emojis([Emoji])
        case decimals([UInt16])
        case confirming
        case verified
        case cancelled(String)
        case failed
    }

    struct Emoji: Equatable, Identifiable {
        var symbol: String
        var name: String
        var id: String { symbol + name }
    }

    private(set) var phase: Phase = .idle
    /// Whom we are verifying: nil for own devices.
    private(set) var otherUserId: String?

    @ObservationIgnored private let client: Client
    @ObservationIgnored private var controller: SessionVerificationController?
    @ObservationIgnored private var delegate: VerificationDelegate?
    @ObservationIgnored private var consumer: Task<Void, Never>?
    @ObservationIgnored private var pendingRequest: SessionVerificationRequestDetails?

    init(client: Client) {
        self.client = client
    }

    var isActive: Bool {
        switch phase {
        case .idle, .verified, .cancelled, .failed: return false
        default: return true
        }
    }

    func start() {
        Task { [weak self] in await self?.ensureController() }
    }

    func stop() {
        consumer?.cancel()
        controller?.setDelegate(delegate: nil)
    }

    @discardableResult
    private func ensureController() async -> SessionVerificationController? {
        if let controller { return controller }
        guard let c = try? await client.getSessionVerificationController() else { return nil }
        let (stream, cont) = makeStream(VerificationEvent.self)
        let d = VerificationDelegate(cont)
        c.setDelegate(delegate: d)
        delegate = d
        controller = c
        consumer = Task { [weak self] in
            for await e in stream { self?.handle(e) }
        }
        return c
    }

    private func handle(_ e: VerificationEvent) {
        switch e {
        case .request(let details):
            pendingRequest = details
            otherUserId = details.senderProfile.userId == (try? client.userId()) ? nil : details.senderProfile.userId
            phase = .incoming(sender: details.senderProfile.displayName ?? details.senderProfile.userId, deviceName: details.deviceDisplayName, deviceId: details.deviceId)
            Task { [weak self] in
                try? await self?.controller?.acknowledgeVerificationRequest(senderId: details.senderProfile.userId, flowId: details.flowId)
            }
        case .accepted:
            // The other side accepted our request: start SAS.
            phase = .sasStarted
            Task { [weak self] in try? await self?.controller?.startSasVerification() }
        case .sasStarted:
            phase = .sasStarted
        case .emojis(let list):
            phase = .emojis(list)
        case .decimals(let v):
            phase = .decimals(v)
        case .finished:
            phase = .verified
        case .cancelled:
            let info = controller?.sasCancelInfo() ?? controller?.requestCancelInfo()
            phase = .cancelled(info.map { $0.cancelledByUs ? "You cancelled the verification." : "Verification was cancelled: \($0.reason)" } ?? "Verification was cancelled.")
        case .failed:
            phase = .failed
        }
    }

    /// Verify this device with another of the user's devices.
    func requestDeviceVerification() async {
        otherUserId = nil
        phase = .requesting
        do {
            guard let c = await ensureController() else { phase = .failed; return }
            try await c.requestDeviceVerification()
            phase = .waitingForOther
        } catch { phase = .failed }
    }

    /// Verify a contact (both need to be online in a Lumen or Matrix app).
    func requestUserVerification(_ userId: String) async {
        otherUserId = userId
        phase = .requesting
        do {
            guard let c = await ensureController() else { phase = .failed; return }
            try await c.requestUserVerification(userId: userId)
            phase = .waitingForOther
        } catch { phase = .failed }
    }

    func acceptIncoming() async {
        do {
            try await controller?.acceptVerificationRequest()
            phase = .waitingForOther
        } catch { phase = .failed }
    }

    /// The emoji match: confirm on this side.
    func confirm() async {
        phase = .confirming
        do { try await controller?.approveVerification() } catch { phase = .failed }
    }

    /// The emoji don't match.
    func mismatch() async {
        try? await controller?.declineVerification()
        phase = .cancelled("The emoji didn't match, so the verification was stopped. Someone may be intercepting the connection; try again in person.")
    }

    func cancel() async {
        try? await controller?.cancelVerification()
        phase = .idle
    }

    func reset() {
        phase = .idle
        pendingRequest = nil
    }
}

enum VerificationEvent: @unchecked Sendable {
    case request(SessionVerificationRequestDetails)
    case accepted
    case sasStarted
    case emojis([VerificationModel.Emoji])
    case decimals([UInt16])
    case finished
    case cancelled
    case failed
}

final class VerificationDelegate: SessionVerificationControllerDelegate {
    let continuation: AsyncStream<VerificationEvent>.Continuation
    init(_ c: AsyncStream<VerificationEvent>.Continuation) { continuation = c }

    func didReceiveVerificationRequest(details: SessionVerificationRequestDetails) { continuation.yield(.request(details)) }
    func didAcceptVerificationRequest() { continuation.yield(.accepted) }
    func didStartSasVerification() { continuation.yield(.sasStarted) }
    func didReceiveVerificationData(data: SessionVerificationData) {
        switch data {
        case .emojis(let emojis, _):
            continuation.yield(.emojis(emojis.map { VerificationModel.Emoji(symbol: $0.symbol(), name: $0.description()) }))
        case .decimals(let values):
            continuation.yield(.decimals(values))
        }
    }
    func didFail() { continuation.yield(.failed) }
    func didCancel() { continuation.yield(.cancelled) }
    func didFinish() { continuation.yield(.finished) }
}
