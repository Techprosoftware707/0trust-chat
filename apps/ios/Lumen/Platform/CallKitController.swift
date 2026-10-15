import AVFoundation
@preconcurrency import CallKit
import Foundation
import LumenCore
@preconcurrency import PushKit

/// Carries a main-actor-only value through a `@Sendable` system callback
/// that is used only to hop back to the main actor.
struct MainActorBox<T>: @unchecked Sendable {
    let value: T
}

/// CallKit and PushKit. Calls are reported to the system so they ring on the
/// lock screen, work with Bluetooth headsets and CarPlay, and get the audio
/// session. Lumen calls are kept out of the system call history (Recents and
/// its iCloud sync).
@MainActor
final class CallKitController: NSObject {
    static let shared = CallKitController()

    struct Call: Equatable {
        let uuid: UUID
        let roomId: String
        let isOutgoing: Bool
        var isVideo: Bool
        var ring: IncomingRing?
        var answered = false
    }

    private(set) var calls: [UUID: Call] = [:]

    var onStartOutgoing: ((Call) -> Void)?
    var onAnswer: ((Call) -> Void)?
    /// `answered` is false for a declined ring.
    var onEnd: ((Call, _ answered: Bool) -> Void)?
    var onMuteChanged: ((Bool) -> Void)?
    /// A ring arrived through PushKit (forwarded by the notification service extension).
    var onIncomingPushRing: ((IncomingRing) -> Void)?

    private let provider: CXProvider
    private let controller = CXCallController()
    private var registry: PKPushRegistry?

    override init() {
        let config = CXProviderConfiguration()
        config.supportsVideo = true
        config.maximumCallGroups = 1
        config.maximumCallsPerCallGroup = 1
        config.supportedHandleTypes = [.generic]
        config.includesCallsInRecents = false
        provider = CXProvider(configuration: config)
        super.init()
        provider.setDelegate(self, queue: nil)
    }

    /// PushKit must be registered at launch so a VoIP push handed over by the
    /// NSE (`reportNewIncomingVoIPPushPayload`) reaches the app.
    func registerVoIP() {
        let r = PKPushRegistry(queue: .main)
        r.delegate = self
        r.desiredPushTypes = [.voIP]
        registry = r
    }

    func call(for roomId: String) -> Call? {
        calls.values.first { $0.roomId == roomId }
    }

    // MARK: - Requests from the app

    func startOutgoing(roomId: String, video: Bool, displayName: String) {
        let uuid = UUID()
        calls[uuid] = Call(uuid: uuid, roomId: roomId, isOutgoing: true, isVideo: video)
        let action = CXStartCallAction(call: uuid, handle: CXHandle(type: .generic, value: displayName))
        action.isVideo = video
        controller.request(CXTransaction(action: action)) { [weak self] error in
            guard let error else { return }
            Task { @MainActor in
                Diagnostics.log("CallKit start failed: \(error.localizedDescription)")
                self?.calls[uuid] = nil
            }
        }
    }

    /// Reports a ring to CallKit (the system shows the incoming-call UI).
    func reportIncoming(_ ring: IncomingRing, callerName: String, completion: ((Bool) -> Void)? = nil) {
        if let existing = calls.values.first(where: { $0.ring?.eventId == ring.eventId }) {
            _ = existing
            completion?(true)
            return
        }
        let uuid = UUID()
        calls[uuid] = Call(uuid: uuid, roomId: ring.roomId, isOutgoing: false, isVideo: ring.isVideo, ring: ring)
        let update = CXCallUpdate()
        update.remoteHandle = CXHandle(type: .generic, value: callerName)
        update.localizedCallerName = callerName
        update.hasVideo = ring.isVideo
        update.supportsHolding = false
        update.supportsGrouping = false
        update.supportsUngrouping = false
        update.supportsDTMF = false
        let done = MainActorBox(value: completion)
        provider.reportNewIncomingCall(with: uuid, update: update) { [weak self] error in
            let message = error?.localizedDescription
            Task { @MainActor in
                if let message {
                    Diagnostics.log("CallKit incoming call refused: \(message)")
                    self?.calls[uuid] = nil
                    done.value?(false)
                } else {
                    self?.scheduleRingTimeout(uuid: uuid, ring: ring)
                    done.value?(true)
                }
            }
        }
    }

    func end(_ uuid: UUID) {
        controller.request(CXTransaction(action: CXEndCallAction(call: uuid))) { error in
            if let error { Task { @MainActor in Diagnostics.log("CallKit end failed: \(error.localizedDescription)") } }
        }
    }

    func setMuted(_ uuid: UUID, muted: Bool) {
        controller.request(CXTransaction(action: CXSetMutedCallAction(call: uuid, muted: muted))) { _ in }
    }

    // MARK: - State from the call widget

    func reportConnecting(_ uuid: UUID) {
        guard calls[uuid]?.isOutgoing == true else { return }
        provider.reportOutgoingCall(with: uuid, startedConnectingAt: Date())
    }

    func reportConnected(_ uuid: UUID) {
        guard calls[uuid]?.isOutgoing == true else { return }
        provider.reportOutgoingCall(with: uuid, connectedAt: Date())
    }

    /// The call ended without the user pressing the CallKit button.
    func reportEnded(_ uuid: UUID, reason: CXCallEndedReason) {
        guard calls[uuid] != nil else { return }
        provider.reportCall(with: uuid, endedAt: Date(), reason: reason)
        calls[uuid] = nil
    }

    func updateVideo(_ uuid: UUID, video: Bool) {
        guard calls[uuid] != nil else { return }
        calls[uuid]?.isVideo = video
        let u = CXCallUpdate()
        u.hasVideo = video
        provider.reportCall(with: uuid, updated: u)
    }

    private func scheduleRingTimeout(uuid: UUID, ring: IncomingRing) {
        let deadline = min(ring.expiresAt ?? .distantFuture, ring.sentAt.addingTimeInterval(IncomingRingPolicy.maxRingAge))
        let delay = max(1, deadline.timeIntervalSinceNow)
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            guard let self, let call = self.calls[uuid], !call.answered else { return }
            self.reportEnded(uuid, reason: .unanswered)
        }
    }

    // MARK: - Audio

    /// `.playAndRecord` with `.voiceChat` / `.videoChat`, Bluetooth (HFP and
    /// A2DP) and AirPlay routes allowed; the route picker in the call screen
    /// switches between them.
    static func configureAudioSession(video: Bool) {
        let s = AVAudioSession.sharedInstance()
        var options: AVAudioSession.CategoryOptions = [.allowBluetoothHFP, .allowBluetoothA2DP, .allowAirPlay]
        if video { options.insert(.defaultToSpeaker) }
        do {
            try s.setCategory(.playAndRecord, mode: video ? .videoChat : .voiceChat, options: options)
        } catch {
            Diagnostics.log("Audio session configuration failed: \(error.localizedDescription)")
        }
    }

    static func setSpeaker(_ on: Bool) {
        try? AVAudioSession.sharedInstance().overrideOutputAudioPort(on ? .speaker : .none)
    }
}

extension CallKitController: CXProviderDelegate {
    nonisolated func providerDidReset(_ provider: CXProvider) {
        MainActor.assumeIsolated {
            for call in calls.values { onEnd?(call, call.answered) }
            calls.removeAll()
        }
    }

    nonisolated func provider(_ provider: CXProvider, perform action: CXStartCallAction) {
        MainActor.assumeIsolated {
            guard let call = calls[action.callUUID] else { action.fail(); return }
            CallKitController.configureAudioSession(video: call.isVideo)
            onStartOutgoing?(call)
            action.fulfill()
        }
    }

    nonisolated func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
        MainActor.assumeIsolated {
            guard var call = calls[action.callUUID] else { action.fail(); return }
            call.answered = true
            calls[action.callUUID] = call
            CallKitController.configureAudioSession(video: call.isVideo)
            onAnswer?(call)
            action.fulfill()
        }
    }

    nonisolated func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        MainActor.assumeIsolated {
            if let call = calls.removeValue(forKey: action.callUUID) {
                onEnd?(call, call.answered || call.isOutgoing)
            }
            action.fulfill()
        }
    }

    nonisolated func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) {
        MainActor.assumeIsolated {
            onMuteChanged?(action.isMuted)
            action.fulfill()
        }
    }

    nonisolated func provider(_ provider: CXProvider, perform action: CXSetHeldCallAction) {
        action.fail()
    }

    nonisolated func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
        Task { @MainActor in Diagnostics.log("Call audio session activated") }
    }

    nonisolated func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {}
}

extension CallKitController: PKPushRegistryDelegate {
    nonisolated func pushRegistry(_ registry: PKPushRegistry, didUpdate pushCredentials: PKPushCredentials, for type: PKPushType) {
        // The VoIP token is not sent anywhere: VoIP pushes reach this app only
        // through the NSE's reportNewIncomingVoIPPushPayload.
    }

    nonisolated func pushRegistry(_ registry: PKPushRegistry, didReceiveIncomingPushWith payload: PKPushPayload, for type: PKPushType, completion: @escaping () -> Void) {
        let dict = payload.dictionaryPayload
        MainActor.assumeIsolated {
            // iOS requires every VoIP push to be reported to CallKit.
            guard let ring = IncomingRing(voipPayload: dict) else {
                let uuid = UUID()
                let u = CXCallUpdate()
                u.localizedCallerName = "Call"
                let box = MainActorBox(value: (provider: provider, completion: completion))
                provider.reportNewIncomingCall(with: uuid, update: u) { _ in
                    box.value.provider.reportCall(with: uuid, endedAt: Date(), reason: .failed)
                    box.value.completion()
                }
                return
            }
            let prefs = SharedPreferences.current().load()
            // The lock screen shows the caller only if the user allows notification previews.
            let name = prefs.notificationPreview == .hidden ? "Lumen call" : (ring.senderName ?? ring.roomName ?? "Lumen call")
            let stillRinging = IncomingRingPolicy.shouldRing(sender: ring.sender, ownUserId: "", isRing: true, sentAt: ring.sentAt, expiresAt: ring.expiresAt, now: Date())
            reportIncoming(ring, callerName: name) { [weak self] ok in
                if ok && !stillRinging, let uuid = self?.calls.first(where: { $0.value.ring?.eventId == ring.eventId })?.key {
                    self?.reportEnded(uuid, reason: .unanswered)
                } else if ok {
                    self?.onIncomingPushRing?(ring)
                }
                completion()
            }
        }
    }
}
