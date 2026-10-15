import Foundation

/// How much a notification shows (integration.md §7). Hidden by default.
public enum NotificationPreview: String, CaseIterable, Codable, Sendable {
    case hidden
    case sender
    case senderAndText

    public static let `default`: NotificationPreview = .hidden

    public var title: String {
        switch self {
        case .hidden: return "Hide sender and text"
        case .sender: return "Show sender"
        case .senderAndText: return "Show sender and text"
        }
    }
}

/// What a decrypted push turned out to be.
public enum NotificationKind: Equatable, Sendable {
    case message(body: String)
    case encryptedUnreadable
    case invite
    case call(video: Bool)
    case other
}

public struct RenderedNotification: Equatable, Sendable {
    public var title: String
    public var subtitle: String
    public var body: String
    public init(title: String, subtitle: String = "", body: String) {
        self.title = title
        self.subtitle = subtitle
        self.body = body
    }
}

public enum NotificationRenderer {
    public static let maxBodyLength = 240

    /// Builds the visible text. With `.hidden` nothing about the sender, room
    /// or content is shown: only the app's name and a generic line.
    public static func render(kind: NotificationKind, senderName: String?, roomName: String?, isDirect: Bool, preview: NotificationPreview, appName: String) -> RenderedNotification {
        let generic: String
        switch kind {
        case .message, .encryptedUnreadable, .other: generic = "New message"
        case .invite: generic = "New invitation"
        case .call(let video): generic = video ? "Incoming video call" : "Incoming call"
        }
        guard preview != .hidden, let sender = clean(senderName), !sender.isEmpty else {
            return RenderedNotification(title: appName, body: generic)
        }
        let subtitle = (!isDirect ? clean(roomName) : nil) ?? ""
        switch (preview, kind) {
        case (.senderAndText, .message(let body)):
            let text = clean(body) ?? ""
            return RenderedNotification(title: sender, subtitle: subtitle, body: text.isEmpty ? generic : truncate(text))
        default:
            return RenderedNotification(title: sender, subtitle: subtitle, body: generic)
        }
    }

    static func clean(_ s: String?) -> String? {
        guard let s else { return nil }
        let collapsed = s.split(whereSeparator: { $0.isNewline }).joined(separator: " ")
        let t = collapsed.trimmingCharacters(in: .whitespacesAndNewlines)
        return t.isEmpty ? nil : t
    }

    static func truncate(_ s: String) -> String {
        s.count <= maxBodyLength ? s : String(s.prefix(maxBodyLength - 1)) + "…"
    }
}

/// The APNs payload Sygnal sends for `event_id_only` pushers: room ID, event
/// ID, unread count and the pusher's `default_payload` (`aps`).
public struct PushPayload: Equatable, Sendable {
    public var roomId: String
    public var eventId: String
    public var unreadCount: Int?

    public init(roomId: String, eventId: String, unreadCount: Int?) {
        self.roomId = roomId
        self.eventId = eventId
        self.unreadCount = unreadCount
    }

    public static func parse(_ userInfo: [AnyHashable: Any]) -> PushPayload? {
        guard let roomId = userInfo["room_id"] as? String, MatrixID.isValidRoomId(roomId),
              let eventId = userInfo["event_id"] as? String, MatrixID.isValidEventId(eventId)
        else { return nil }
        var unread: Int?
        if let n = userInfo["unread_count"] as? Int { unread = n } else if let n = userInfo["unread_count"] as? NSNumber { unread = n.intValue }
        if let u = unread, u < 0 { unread = nil }
        return PushPayload(roomId: roomId, eventId: eventId, unreadCount: unread)
    }
}

/// The HTTP pusher registered with the homeserver (integration.md §7).
public struct PusherConfiguration: Equatable, Sendable {
    public var appId: String
    public var pushkey: String
    public var gatewayURL: URL
    /// `{"aps":{"mutable-content":1,"alert":{"loc-key":"NEW_MESSAGE"}}}`
    public var defaultPayloadJSON: String

    public static let defaultPayloadJSON = #"{"aps":{"alert":{"loc-key":"NEW_MESSAGE"},"mutable-content":1}}"#

    public init(appId: String, deviceToken: Data, gatewayURL: URL) {
        self.appId = appId
        self.pushkey = deviceToken.map { String(format: "%02x", $0) }.joined()
        self.gatewayURL = gatewayURL
        self.defaultPayloadJSON = PusherConfiguration.defaultPayloadJSON
    }
}

/// What the settings screen says about notifications.
public enum PushAvailability: Equatable, Sendable {
    /// The server has no push gateway: notifications only while the app runs.
    case noGateway
    case permissionDenied
    case notDetermined
    case registering
    case active
    case failed(String)

    public static func evaluate(gatewayConfigured: Bool, permission: PushPermission, pusherRegistered: Bool, lastError: String?) -> PushAvailability {
        guard gatewayConfigured else { return .noGateway }
        switch permission {
        case .denied: return .permissionDenied
        case .notDetermined: return .notDetermined
        case .granted:
            if let e = lastError { return .failed(e) }
            return pusherRegistered ? .active : .registering
        }
    }

    public var explanation: String {
        switch self {
        case .noGateway:
            return "This server has no push service, so this device gets notifications only while the app is open or during short background refreshes that iOS schedules. Calls do not ring while the app is closed."
        case .permissionDenied:
            return "Notifications are turned off for this app in iOS Settings. Messages and calls can't alert you while the app is closed."
        case .notDetermined:
            return "Allow notifications to be alerted about new messages and calls while the app is closed."
        case .registering:
            return "Registering this device with the server's push service…"
        case .active:
            return "Push notifications are on. Apple and the server's push gateway see only that a notification was sent to this device, its room and event IDs and the unread count; the message is fetched and decrypted on this device."
        case .failed(let e):
            return "Push registration failed: \(e). Notifications arrive only while the app is open."
        }
    }
}

public enum PushPermission: Equatable, Sendable {
    case notDetermined, denied, granted
}
