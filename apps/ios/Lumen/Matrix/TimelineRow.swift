import Foundation
import LumenCore
import MatrixRustSDK

/// A timeline item prepared for display. Built synchronously from the SDK's
/// `TimelineItem` on every diff.
struct TimelineRow: Identifiable {
    enum Kind {
        case dateDivider(Date)
        case readMarker
        case timelineStart
        case message(MessageRow)
        case call(CallRow)
        case state(String)
    }

    let id: String
    let kind: Kind
}

struct ReplyPreview {
    var eventId: String
    var senderName: String
    var text: String
}

struct ReactionGroup: Identifiable, Equatable {
    var key: String
    var count: Int
    var includesMe: Bool
    var id: String { key }
}

struct Attachment {
    enum Kind { case image, video, audio, file }
    var kind: Kind
    var filename: String
    var mimeType: String?
    var size: UInt64?
    var width: UInt64?
    var height: UInt64?
    var source: MediaSource
    var thumbnailSource: MediaSource?
}

struct MessageRow {
    enum Body {
        case text(String)
        case emote(String)
        case notice(String)
        case attachment(Attachment, caption: String?)
        case redacted
        case unableToDecrypt(String)
        case unsupported(String)
    }

    var itemId: EventOrTransactionId
    var eventId: String?
    var sender: String
    var senderName: String
    var isOwn: Bool
    var timestamp: Date
    var body: Body
    var isEdited: Bool
    var reply: ReplyPreview?
    var reactions: [ReactionGroup]
    var delivery: DeliveryState?
    var isEditable: Bool
    var canReply: Bool
    var readBy: [String]

    var plainText: String? {
        switch body {
        case .text(let t), .notice(let t): return t
        case .emote(let t): return t
        default: return nil
        }
    }
}

struct CallRow {
    var record: RtcNotificationRecord
    var senderName: String
}

enum TimelineRowMapper {
    static func map(_ item: TimelineItem, ownUserId: String) -> TimelineRow? {
        let id = item.uniqueId().id
        if let v = item.asVirtual() {
            switch v {
            case .dateDivider(let ts): return TimelineRow(id: id, kind: .dateDivider(date(ts)))
            case .readMarker: return TimelineRow(id: id, kind: .readMarker)
            case .timelineStart: return TimelineRow(id: id, kind: .timelineStart)
            }
        }
        guard let ev = item.asEvent() else { return nil }
        let name = senderName(ev.senderProfile, fallback: ev.sender)
        switch ev.content {
        case .msgLike(let content):
            return TimelineRow(id: id, kind: .message(message(ev, content: content, senderName: name, ownUserId: ownUserId)))
        case .rtcNotification(let intent, let declinedBy, let active, let startTs, let isJoined):
            let record = RtcNotificationRecord(
                eventId: eventId(ev.eventOrTransactionId), sender: ev.sender, timestamp: date(ev.timestamp),
                callIntent: intent, declinedBy: declinedBy, activeMembers: active,
                callStart: startTs.map { date($0) }, isJoined: isJoined
            )
            return TimelineRow(id: id, kind: .call(CallRow(record: record, senderName: name)))
        case .callInvite:
            return TimelineRow(id: id, kind: .state("\(name) started a call (legacy)"))
        case .roomMembership(let userId, let display, let change, _):
            return TimelineRow(id: id, kind: .state(TimelineText.membership(userId: userId, displayName: display, change: change)))
        case .profileChange(let dn, let prevDn, _, _):
            if let dn, let prevDn, dn != prevDn { return TimelineRow(id: id, kind: .state("\(prevDn) is now \(dn)")) }
            return TimelineRow(id: id, kind: .state("\(name) updated their profile"))
        case .state(_, let content):
            guard let text = TimelineText.state(content, sender: name) else { return nil }
            return TimelineRow(id: id, kind: .state(text))
        case .failedToParseMessageLike, .failedToParseState:
            return nil
        }
    }

    static func message(_ ev: EventTimelineItem, content: MsgLikeContent, senderName: String, ownUserId: String) -> MessageRow {
        var body: MessageRow.Body
        var edited = false
        switch content.kind {
        case .message(let m):
            edited = m.isEdited
            body = messageBody(m.msgType)
        case .redacted:
            body = .redacted
        case .unableToDecrypt(let msg):
            body = .unableToDecrypt(TimelineText.utd(msg))
        case .sticker(let b, _, _):
            body = .unsupported("Sticker: \(b)")
        case .poll(let q, _, _, _, _, _, _):
            body = .unsupported("Poll: \(q) (open the web app to vote)")
        case .liveLocation:
            body = .unsupported("Live location (not shown in this app)")
        case .other:
            body = .unsupported("Unsupported message")
        }

        var reply: ReplyPreview?
        if let r = content.inReplyTo {
            switch r.event() {
            case .ready(let c, let sender, let profile, _, _):
                reply = ReplyPreview(eventId: r.eventId(), senderName: TimelineRowMapper.senderName(profile, fallback: sender), text: TimelineText.preview(c, isOwn: false) ?? "Message")
            case .error:
                reply = ReplyPreview(eventId: r.eventId(), senderName: "", text: "Original message unavailable")
            case .pending, .unavailable:
                reply = ReplyPreview(eventId: r.eventId(), senderName: "", text: "Loading…")
            }
        }

        let reactions = ev.reactions.map { r in
            ReactionGroup(key: r.key, count: r.senders.count, includesMe: r.senders.contains { $0.senderId == ownUserId })
        }

        let sendState: SendStateInput?
        switch ev.localSendState {
        case .none: sendState = nil
        case .some(.notSentYet): sendState = .notSentYet
        case .some(.sendingFailed(_, let recoverable)): sendState = .sendingFailed(isRecoverable: recoverable)
        case .some(.sent(let eventId)): sendState = .sent(eventId: eventId)
        }
        let readers = Array(ev.readReceipts.keys)
        let delivery = DeliveryStateMapper.map(isOwn: ev.isOwn, isRemote: ev.isRemote, sendState: sendState, receiptUserIds: readers, ownUserId: ownUserId)

        return MessageRow(
            itemId: ev.eventOrTransactionId,
            eventId: eventId(ev.eventOrTransactionId),
            sender: ev.sender,
            senderName: senderName,
            isOwn: ev.isOwn,
            timestamp: date(ev.timestamp),
            body: body,
            isEdited: edited,
            reply: reply,
            reactions: reactions,
            delivery: delivery,
            isEditable: ev.isEditable,
            canReply: ev.canBeRepliedTo,
            readBy: readers.filter { $0 != ownUserId }
        )
    }

    static func messageBody(_ type: MessageType) -> MessageRow.Body {
        switch type {
        case .text(let c): return .text(c.body)
        case .emote(let c): return .emote(c.body)
        case .notice(let c): return .notice(c.body)
        case .image(let c):
            return .attachment(Attachment(kind: .image, filename: c.filename, mimeType: c.info?.mimetype, size: c.info?.size, width: c.info?.width, height: c.info?.height, source: c.source, thumbnailSource: c.info?.thumbnailSource), caption: c.caption)
        case .video(let c):
            return .attachment(Attachment(kind: .video, filename: c.filename, mimeType: c.info?.mimetype, size: c.info?.size, width: nil, height: nil, source: c.source, thumbnailSource: nil), caption: c.caption)
        case .audio(let c):
            return .attachment(Attachment(kind: .audio, filename: c.filename, mimeType: c.info?.mimetype, size: c.info?.size, width: nil, height: nil, source: c.source, thumbnailSource: nil), caption: c.caption)
        case .file(let c):
            return .attachment(Attachment(kind: .file, filename: c.filename, mimeType: c.info?.mimetype, size: c.info?.size, width: nil, height: nil, source: c.source, thumbnailSource: nil), caption: c.caption)
        case .gallery:
            return .unsupported("Image gallery (open the web app to view)")
        case .location:
            return .unsupported("Location")
        case .other(_, let body):
            return .text(body)
        }
    }

    static func senderName(_ profile: ProfileDetails, fallback: String) -> String {
        if case .ready(let dn, _, _, _, _) = profile, let dn, !dn.isEmpty { return dn }
        return fallback
    }

    static func eventId(_ id: EventOrTransactionId) -> String? {
        if case .eventId(let e) = id { return e }
        return nil
    }

    static func date(_ ts: Timestamp) -> Date {
        Date(timeIntervalSince1970: TimeInterval(ts) / 1000)
    }
}

/// Plain-text descriptions of timeline content.
enum TimelineText {
    static func preview(_ content: TimelineItemContent, isOwn: Bool) -> String? {
        let prefix = isOwn ? "You: " : ""
        switch content {
        case .msgLike(let c):
            switch c.kind {
            case .message(let m): return prefix + MessageText.body(of: m.msgType)
            case .redacted: return "Message deleted"
            case .unableToDecrypt: return "Encrypted message"
            case .sticker: return prefix + "Sticker"
            case .poll(let q, _, _, _, _, _, _): return prefix + "Poll: \(q)"
            case .liveLocation: return prefix + "Live location"
            case .other: return nil
            }
        case .rtcNotification, .callInvite: return "Call"
        case .roomMembership(let userId, let display, let change, _): return membership(userId: userId, displayName: display, change: change)
        default: return nil
        }
    }

    static func membership(userId: String, displayName: String?, change: MembershipChange?) -> String {
        let n = displayName ?? userId
        switch change {
        case .joined, .invitationAccepted, .knockAccepted: return "\(n) joined"
        case .left: return "\(n) left"
        case .invited: return "\(n) was invited"
        case .invitationRejected: return "\(n) declined the invitation"
        case .invitationRevoked: return "\(n)'s invitation was withdrawn"
        case .kicked: return "\(n) was removed"
        case .banned, .kickedAndBanned: return "\(n) was banned"
        case .unbanned: return "\(n) was unbanned"
        case .knocked: return "\(n) asked to join"
        default: return "\(n) membership changed"
        }
    }

    static func state(_ content: OtherState, sender: String) -> String? {
        switch content {
        case .roomName(let name): return name.map { "\(sender) renamed the room to \($0)" }
        case .roomTopic(let topic): return topic.map { "\(sender) changed the topic to \($0)" }
        case .roomEncryption: return "Messages in this room are end-to-end encrypted."
        case .roomCreate: return "\(sender) created the room"
        case .roomAvatar: return "\(sender) changed the room picture"
        default: return nil
        }
    }

    static func utd(_ msg: EncryptedMessage) -> String {
        if case .megolmV1AesSha2(_, let cause) = msg {
            switch cause {
            case .sentBeforeWeJoined: return "Sent before you joined, so this device can't read it."
            case .verificationViolation: return "Hidden because the sender's verified identity changed."
            case .unsignedDevice: return "Hidden: sent from a device its owner hasn't verified."
            case .unknownDevice: return "Hidden: sent from a device that isn't known."
            case .historicalMessageAndBackupIsDisabled: return "Sent before this device signed in, and there's no key backup to restore it from."
            default: break
            }
        }
        return "The key for this message hasn't arrived yet. Verifying this device or entering your recovery key usually helps."
    }
}
