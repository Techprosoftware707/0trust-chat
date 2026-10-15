import CallKit
import Foundation
import LumenCore
import MatrixRustSDK
import Observation
import UIKit

/// Starts, answers, declines and ends calls; connects CallKit with the call
/// widget. The encryption label shown in the call screen comes only from the
/// widget's own `e2ee` state.
@Observable @MainActor
final class CallCoordinator {
    struct ActiveCall {
        let uuid: UUID
        let roomId: String
        let roomName: String
        let session: CallWidgetSession
        let host: CallWidgetHost
        var source: WidgetSource
    }

    private(set) var active: ActiveCall?
    private(set) var state: CallStateUpdate?
    private(set) var error: String?
    var isPresented = false

    @ObservationIgnored weak var sessionModel: SessionModel?
    @ObservationIgnored private let callKit = CallKitController.shared
    @ObservationIgnored private var pendingRings: [IncomingRing] = []
    @ObservationIgnored private var declineHandles: [String: TaskHandle] = [:]
    @ObservationIgnored private var declineTasks: [String: Task<Void, Never>] = [:]
    /// A call answered or started before the session finished restoring
    /// (for example when a ring launched the app).
    @ObservationIgnored private var pendingLaunch: (call: CallKitController.Call, intent: CallIntent)?

    private static let insecureKey = "lumen.widget.bundledInsecure"

    init() {
        callKit.onStartOutgoing = { [weak self] call in self?.openWidget(for: call, intent: .startCall) }
        callKit.onAnswer = { [weak self] call in self?.openWidget(for: call, intent: .joinExisting) }
        callKit.onEnd = { [weak self] call, answered in self?.handleEnd(call, answered: answered) }
        callKit.onMuteChanged = { [weak self] muted in self?.active?.session.send(muted ? .mute : .unmute) }
        callKit.onIncomingPushRing = { [weak self] ring in self?.trackRing(ring) }
    }

    func attach(_ session: SessionModel?) {
        sessionModel = session
        session?.onRing = { [weak self] ring in self?.incoming(ring) }
        if session != nil {
            let rings = pendingRings
            pendingRings.removeAll()
            for r in rings { trackRing(r) }
            if let p = pendingLaunch {
                pendingLaunch = nil
                if callKit.calls[p.call.uuid] != nil { openWidget(for: p.call, intent: p.intent) }
            }
        }
    }

    /// Calls need the widget: bundled, or the server's `call_widget_url`.
    var canCall: Bool {
        WidgetSchemeHandler.hasBundledWidget || sessionModel?.lumen?.callWidgetURL != nil
    }

    func clearError() { error = nil }

    // MARK: - Start / incoming

    func startCall(roomId: String, roomName: String, video: Bool) {
        guard active == nil else { isPresented = true; return }
        guard canCall else {
            error = "Calls aren't available: this app build has no call widget and the server doesn't provide one."
            return
        }
        callKit.startOutgoing(roomId: roomId, video: video, displayName: roomName)
    }

    /// A ring seen in sync while the app runs.
    func incoming(_ ring: IncomingRing) {
        let prefs = SharedPreferences.current().load()
        let name = prefs.notificationPreview == .hidden ? "Lumen call" : (ring.senderName ?? ring.roomName ?? "Lumen call")
        callKit.reportIncoming(ring, callerName: name) { [weak self] ok in
            if ok { self?.trackRing(ring) }
        }
    }

    /// Ends the CallKit ring when the user declined on another device.
    private func trackRing(_ ring: IncomingRing) {
        guard let s = sessionModel else { pendingRings.append(ring); return }
        guard declineHandles[ring.eventId] == nil, let room = try? s.client.getRoom(roomId: ring.roomId) else { return }
        let (stream, cont) = makeStream(String.self)
        if let h = try? room.subscribeToCallDeclineEvents(rtcNotificationEventId: ring.eventId, listener: CallDeclinedListener(cont)) {
            declineHandles[ring.eventId] = h
        }
        let own = s.userId
        declineTasks[ring.eventId] = Task { [weak self] in
            for await decliner in stream where decliner == own {
                guard let self, let call = self.callKit.calls.values.first(where: { $0.ring?.eventId == ring.eventId }), !call.answered else { continue }
                self.callKit.reportEnded(call.uuid, reason: .declinedElsewhere)
            }
        }
    }

    private func stopTracking(_ eventId: String) {
        declineHandles.removeValue(forKey: eventId)?.cancel()
        declineTasks.removeValue(forKey: eventId)?.cancel()
    }

    // MARK: - Widget

    private func preferredSource() -> WidgetSource? {
        let bundledInsecure = UserDefaults.standard.string(forKey: Self.insecureKey) == AppEnvironment.appVersion
        if WidgetSchemeHandler.hasBundledWidget && !bundledInsecure { return .bundled }
        if let url = sessionModel?.lumen?.callWidgetURL { return .server(url) }
        return nil
    }

    private func openWidget(for call: CallKitController.Call, intent: CallIntent) {
        if let ring = call.ring { stopTracking(ring.eventId) }
        guard let s = sessionModel else {
            pendingLaunch = (call, intent)
            return
        }
        guard let room = try? s.client.getRoom(roomId: call.roomId) else {
            error = "The call's room isn't available on this device."
            callKit.reportEnded(call.uuid, reason: .failed)
            return
        }
        guard let source = preferredSource() else {
            error = "Calls aren't available: no call widget."
            callKit.reportEnded(call.uuid, reason: .failed)
            return
        }
        let joinExisting = intent == .joinExisting || room.hasActiveRoomCall()
        launch(call: call, room: room, source: source, intent: joinExisting ? .joinExisting : .startCall, sessionModel: s)
    }

    private func launch(call: CallKitController.Call, room: Room, source: WidgetSource, intent: CallIntent, sessionModel s: SessionModel) {
        do {
            let notify: CallNotify = intent == .startCall ? (s.roomList.summaries.first(where: { $0.id == call.roomId })?.isDirect == true ? .ring : .notification) : .none
            let client = s.client
            guard let homeserver = URL(string: s.account.homeserverURL) else { throw SessionError.noAccount }
            let session = try CallWidgetSession(
                room: room, source: source, intent: intent, video: call.isVideo, notify: notify,
                homeserverURL: homeserver, userId: s.userId, deviceId: s.deviceId, http: URLSessionHTTPClient(),
                accessToken: { try client.session().accessToken }
            )
            let host = CallWidgetHost(source: source, session: session)
            session.onCallState = { [weak self] update in self?.apply(update) }
            host.onInsecureContext = { [weak self] in self?.fallBackToServer() }
            host.onLoadFailed = { [weak self] msg in self?.error = msg }
            let roomName = room.displayName() ?? "Call"
            active = ActiveCall(uuid: call.uuid, roomId: call.roomId, roomName: roomName, session: session, host: host, source: source)
            state = CallStateUpdate(state: .connecting, video: call.isVideo, muted: false, e2ee: .unknown)
            isPresented = true
            callKit.reportConnecting(call.uuid)
            session.start(ownUserId: s.userId, ownDeviceId: s.deviceId)
            let dark = UITraitCollection.current.userInterfaceStyle == .dark
            Task {
                do {
                    let url = try await session.pageURL(clientId: AppEnvironment.build.bundleIdentifier, language: Locale.preferredLanguages.first ?? "en", dark: dark)
                    host.load(url)
                } catch {
                    self.error = "The call couldn't be started."
                    self.end()
                }
            }
        } catch {
            self.error = "The call couldn't be started."
            callKit.reportEnded(call.uuid, reason: .failed)
        }
    }

    /// WebKit doesn't treat the bundled scheme as a secure context (no camera
    /// or microphone): reload from the operator's server and remember it.
    private func fallBackToServer() {
        guard let current = active, case .bundled = current.source else { return }
        UserDefaults.standard.set(AppEnvironment.appVersion, forKey: Self.insecureKey)
        guard let s = sessionModel, let url = s.lumen?.callWidgetURL, let room = try? s.client.getRoom(roomId: current.roomId) else {
            error = "Calls can't use the camera or microphone in this app build, and the server doesn't provide a call widget."
            end()
            return
        }
        current.session.close()
        current.host.tearDown()
        let call = callKit.calls[current.uuid] ?? CallKitController.Call(uuid: current.uuid, roomId: current.roomId, isOutgoing: true, isVideo: current.session.isVideo)
        active = nil
        launch(call: call, room: room, source: .server(url), intent: room.hasActiveRoomCall() ? .joinExisting : .startCall, sessionModel: s)
    }

    private func apply(_ update: CallStateUpdate) {
        state = update
        guard let call = active else { return }
        switch update.state {
        case .connecting, .reconnecting: break
        case .connected: callKit.reportConnected(call.uuid)
        case .ended:
            callKit.reportEnded(call.uuid, reason: .remoteEnded)
            finish()
        }
        if let v = update.video { callKit.updateVideo(call.uuid, video: v) }
    }

    // MARK: - Controls

    func toggleMute() {
        guard let call = active else { return }
        callKit.setMuted(call.uuid, muted: !(state?.muted ?? false))
    }

    func toggleVideo() {
        guard let call = active else { return }
        call.session.send((state?.video ?? false) ? .videoOff : .videoOn)
    }

    func switchCamera() {
        active?.session.send(.switchCamera)
    }

    func end() {
        guard let call = active else { return }
        if callKit.calls[call.uuid] != nil {
            callKit.end(call.uuid)
        } else {
            call.session.send(.hangup)
            finish()
        }
    }

    private func handleEnd(_ call: CallKitController.Call, answered: Bool) {
        if let ring = call.ring {
            stopTracking(ring.eventId)
            if !answered, let s = sessionModel {
                // Declined from the CallKit UI: tell the caller (MSC4310).
                Task { try? await CallRoomActions(client: s.client).decline(roomId: ring.roomId, notificationEventId: ring.eventId) }
            }
        }
        if let a = active, a.uuid == call.uuid {
            a.session.send(.hangup)
            // Give the widget a moment to leave the MatrixRTC session.
            Task { [weak self] in
                try? await Task.sleep(nanoseconds: 1_500_000_000)
                self?.finish()
            }
        }
    }

    private func finish() {
        guard let a = active else { return }
        a.session.close()
        a.host.tearDown()
        active = nil
        state = nil
        isPresented = false
        // CallKit deactivates the audio session when the call ends.
    }
}
