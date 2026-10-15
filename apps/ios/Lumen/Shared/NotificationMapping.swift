import Foundation
import LumenCore
import MatrixRustSDK

/// An incoming MatrixRTC ring (`org.matrix.msc4075.rtc.notification`, type ring).
struct IncomingRing: Equatable, Sendable, Codable {
    var roomId: String
    var eventId: String
    var sender: String
    var senderName: String?
    var roomName: String?
    var isVideo: Bool
    var sentAt: Date
    var expiresAt: Date?

    /// The dictionary handed from the NSE to the app through
    /// `CXProvider.reportNewIncomingVoIPPushPayload`. It carries no message content.
    var voipPayload: [String: Any] {
        var d: [String: Any] = [
            "lumen_ring": 1,
            "room_id": roomId,
            "event_id": eventId,
            "sender": sender,
            "video": isVideo,
            "sent_at": sentAt.timeIntervalSince1970,
        ]
        if let n = senderName { d["sender_name"] = n }
        if let n = roomName { d["room_name"] = n }
        if let e = expiresAt { d["expires_at"] = e.timeIntervalSince1970 }
        return d
    }

    init(roomId: String, eventId: String, sender: String, senderName: String?, roomName: String?, isVideo: Bool, sentAt: Date, expiresAt: Date?) {
        self.roomId = roomId
        self.eventId = eventId
        self.sender = sender
        self.senderName = senderName
        self.roomName = roomName
        self.isVideo = isVideo
        self.sentAt = sentAt
        self.expiresAt = expiresAt
    }

    init?(voipPayload d: [AnyHashable: Any]) {
        guard d["lumen_ring"] != nil,
              let roomId = d["room_id"] as? String, MatrixID.isValidRoomId(roomId),
              let eventId = d["event_id"] as? String, MatrixID.isValidEventId(eventId),
              let sender = d["sender"] as? String
        else { return nil }
        let sent = (d["sent_at"] as? Double).map(Date.init(timeIntervalSince1970:)) ?? Date()
        self.init(
            roomId: roomId, eventId: eventId, sender: sender,
            senderName: d["sender_name"] as? String, roomName: d["room_name"] as? String,
            isVideo: d["video"] as? Bool ?? false, sentAt: sent,
            expiresAt: (d["expires_at"] as? Double).map(Date.init(timeIntervalSince1970:))
        )
    }
}

/// What a notification item is, for the preview policy and call handling.
struct MappedNotification {
    var kind: NotificationKind
    var ring: IncomingRing?
    var senderName: String?
    var roomName: String
    var isDirect: Bool
    var isNoisy: Bool
}

enum NotificationMapper {
    static func map(_ item: NotificationItem, roomId: String, eventId: String?) -> MappedNotification {
        var kind: NotificationKind = .other
        var ring: IncomingRing?
        switch item.event {
        case .invite:
            kind = .invite
        case .timeline(let event):
            if let content = try? event.content() {
                switch content {
                case .messageLike(let ml):
                    switch ml {
                    case .roomMessage(let messageType, _):
                        kind = .message(body: MessageText.body(of: messageType))
                    case .roomEncrypted:
                        kind = .encryptedUnreadable
                    case .rtcNotification(let type, let expirationTs, let intent):
                        let video = intent == .video
                        kind = .call(video: video)
                        if type == .ring {
                            ring = IncomingRing(
                                roomId: roomId,
                                eventId: eventId ?? event.eventId(),
                                sender: event.senderId(),
                                senderName: item.senderInfo.displayName,
                                roomName: item.roomInfo.displayName,
                                isVideo: video,
                                sentAt: Date(timeIntervalSince1970: TimeInterval(event.timestamp()) / 1000),
                                expiresAt: Date(timeIntervalSince1970: TimeInterval(expirationTs) / 1000)
                            )
                        }
                    case .callInvite:
                        kind = .call(video: false)
                    default:
                        kind = .other
                    }
                case .state:
                    kind = .other
                }
            }
        }
        return MappedNotification(
            kind: kind,
            ring: ring,
            senderName: item.senderInfo.displayName,
            roomName: item.roomInfo.displayName,
            isDirect: item.roomInfo.isDm || item.roomInfo.isDirect,
            isNoisy: item.isNoisy ?? false
        )
    }
}

/// Plain text for a message type (notifications, room list previews).
enum MessageText {
    static func body(of type: MessageType) -> String {
        switch type {
        case .text(let c): return c.body
        case .emote(let c): return "* " + c.body
        case .notice(let c): return c.body
        case .image(let c): return c.caption ?? "Image"
        case .video(let c): return c.caption ?? "Video"
        case .audio(let c): return c.caption ?? "Audio"
        case .file(let c): return c.caption ?? "File: \(c.filename)"
        case .gallery: return "Images"
        case .location: return "Location"
        case .other(_, let body): return body
        }
    }
}
