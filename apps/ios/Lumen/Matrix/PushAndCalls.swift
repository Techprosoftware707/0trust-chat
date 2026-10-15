import Foundation
import LumenCore
import MatrixRustSDK
import Observation

/// Registers this device's APNs token as an HTTP pusher (integration.md §7),
/// only when the server announced a push gateway.
@MainActor
struct PusherRegistrar {
    let client: Client
    let lumen: LumenAppInfo?
    let appId: String

    var gatewayConfigured: Bool { lumen?.pushGatewayURL != nil }

    func register(deviceToken: Data, appDisplayName: String, deviceDisplayName: String) async throws {
        guard let gateway = lumen?.pushGatewayURL else { return }
        let config = PusherConfiguration(appId: appId, deviceToken: deviceToken, gatewayURL: gateway)
        try await client.setPusher(
            identifiers: PusherIdentifiers(pushkey: config.pushkey, appId: config.appId),
            kind: .http(data: HttpPusherData(url: config.gatewayURL.absoluteString, format: .eventIdOnly, defaultPayload: config.defaultPayloadJSON)),
            appDisplayName: appDisplayName,
            deviceDisplayName: deviceDisplayName,
            profileTag: nil,
            lang: Locale.preferredLanguages.first ?? "en",
            append: false
        )
    }

    func unregister(deviceToken: Data) async throws {
        let pushkey = deviceToken.map { String(format: "%02x", $0) }.joined()
        try await client.deletePusher(identifiers: PusherIdentifiers(pushkey: pushkey, appId: appId))
    }
}

/// Connects one call widget page to the Rust SDK's widget driver
/// (integration.md §6.2). The widget never holds an access token: it asks the
/// driver, which acts with exactly the MatrixRTC capabilities.
@Observable @MainActor
final class CallWidgetSession {
    let roomId: String
    let source: WidgetSource
    let widgetId: String
    let isVideo: Bool
    private(set) var state: CallStateUpdate?
    private(set) var ended = false

    /// Delivers a JSON string to the page (`window.postMessage`).
    @ObservationIgnored var deliverToWidget: ((String) -> Void)?
    /// Called for every `io.lumen.call_state` from the widget.
    @ObservationIgnored var onCallState: ((CallStateUpdate) -> Void)?

    @ObservationIgnored private let room: Room
    @ObservationIgnored private let settings: WidgetSettings
    @ObservationIgnored private var driver: WidgetDriver?
    @ObservationIgnored private var handle: WidgetDriverHandle?
    @ObservationIgnored private var filter: WidgetMessageFilter
    @ObservationIgnored private var driverTask: Task<Void, Never>?
    @ObservationIgnored private var recvTask: Task<Void, Never>?
    @ObservationIgnored private var closed = false

    init(room: Room, source: WidgetSource, intent: CallIntent, video: Bool, notify: CallNotify) throws {
        self.room = room
        self.roomId = room.id()
        self.source = source
        self.isVideo = video
        let id = UUID().uuidString
        self.widgetId = id
        self.filter = WidgetMessageFilter(widgetId: id)
        // initAfterContentLoad: the driver starts the widget-API handshake when
        // the widget sends `content_loaded`, so nothing is lost while the page loads.
        self.settings = WidgetSettings(widgetId: id, initAfterContentLoad: true, rawUrl: WidgetURLTemplate.rawURL(source: source, intent: intent, video: video, notify: notify))
        let pair = try makeWidgetDriver(settings: settings)
        self.driver = pair.driver
        self.handle = pair.handle
    }

    /// The page URL with the SDK's placeholders filled in.
    func pageURL(clientId: String, language: String, dark: Bool) async throws -> URL {
        let s = try await generateWebviewUrl(widgetSettings: settings, room: room, props: ClientProperties(clientId: clientId, languageTag: language, theme: dark ? "dark" : "light"))
        guard let url = URL(string: s) else { throw WebAuthenticationError.failed("Invalid widget URL") }
        return url
    }

    func start(ownUserId: String, ownDeviceId: String) {
        guard let driver, let handle else { return }
        let room = self.room
        let provider = CallCapabilitiesProvider(ownUserId: ownUserId, ownDeviceId: ownDeviceId)
        driverTask = Task.detached {
            await driver.run(room: room, capabilitiesProvider: provider)
        }
        recvTask = Task { [weak self] in
            while let message = await handle.recv() {
                self?.deliverToWidget?(message)
            }
        }
    }

    /// A message from the page's `lumenNative` handler.
    func receiveFromWidget(_ raw: String) {
        guard !closed else { return }
        switch filter.classify(raw) {
        case .forwardToDriver(let msg):
            _ = handle?.send(msg: msg)
        case .callState(let update, let reply):
            state = update
            if update.state == .ended { ended = true }
            onCallState?(update)
            if let reply { deliverToWidget?(reply) }
        case .drop:
            break
        }
    }

    func send(_ action: CallAction) {
        deliverToWidget?(filter.actionMessage(action))
    }

    /// Detaches the page. The widget leaves the MatrixRTC session itself
    /// (and its delayed leave event covers crashes). Note: at SDK 26.10.02
    /// `WidgetDriver.run` has no stop and uniffi futures can't be cancelled
    /// from Swift, so the driver task stays idle until the app process ends;
    /// messages it still produces are discarded here.
    func close() {
        closed = true
        ended = true
        deliverToWidget = nil
        onCallState = nil
        recvTask?.cancel()
        driverTask?.cancel()
    }
}

/// Room-level call operations outside the widget.
@MainActor
struct CallRoomActions {
    let client: Client

    func room(_ id: String) -> Room? { try? client.getRoom(roomId: id) }

    /// Sends the MatrixRTC decline (`org.matrix.msc4310.rtc.decline`) for a ring.
    func decline(roomId: String, notificationEventId: String) async throws {
        guard let room = room(roomId) else { return }
        try await room.declineCall(rtcNotificationEventId: notificationEventId)
    }

    /// Whether the call has already started without us (for joining instead of starting).
    func hasActiveCall(roomId: String) -> Bool {
        room(roomId)?.hasActiveRoomCall() ?? false
    }

    /// The server's SFU transports (MSC4143), for the diagnostics screen.
    func transports() async -> [String] {
        guard let list = try? await client.discoverRtcTransports() else { return [] }
        return list.map {
            switch $0 {
            case .liveKit(let url): return "LiveKit: \(url)"
            case .custom(let type, _): return type
            }
        }
    }
}
