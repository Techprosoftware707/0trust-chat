#if DEBUG
import Foundation
import LumenCore
import MatrixRustSDK

/// Made-up people, rooms and messages for the DEBUG screenshot harness
/// (Lumen/Debug). Nothing here talks to a server; none of it is compiled into
/// Release builds.
enum PreviewFixtures {
    static let server = "lumen.example"
    static let ownUserId = "@alex:lumen.example"
    static let ownName = "Alex Morgan"
    static let deviceId = "LUMENIOS7K"

    struct Person {
        let userId: String
        let name: String
    }

    static let maya = Person(userId: "@maya:lumen.example", name: "Maya Chen")
    static let sam = Person(userId: "@sam:lumen.example", name: "Sam Okafor")
    static let priya = Person(userId: "@priya:lumen.example", name: "Priya Raman")
    static let jonas = Person(userId: "@jonas:lumen.example", name: "Jonas Weber")
    static let ana = Person(userId: "@ana:lumen.example", name: "Ana Lima")

    static let designRoomId = "!design:lumen.example"
    static let priyaRoomId = "!priya:lumen.example"
    static let newRoomId = "!new:lumen.example"

    static func url(_ path: String) -> URL? { URL(string: "https://lumen.example\(path)") }

    static let lumenInfo = LumenAppInfo(
        brandName: "Lumen Secure", brandShortName: "Lumen",
        portalURL: url("/portal"), signupURL: url("/portal/signup"), accountURL: url("/portal/account"),
        accountDeleteURL: url("/portal/account/delete"), privacyURL: url("/privacy"), helpURL: url("/help"),
        ssoIdpId: "lumen", webAppURL: url("/app"), callWidgetURL: url("/widget/call"),
        pushGatewayURL: url("/_matrix/push/v1/notify")
    )

    static let account = StoredAccount(
        userId: ownUserId, deviceId: deviceId, accessToken: "preview", refreshToken: nil,
        homeserverURL: "https://matrix.lumen.example", oauthData: nil, slidingSyncVersion: "native",
        storeID: "preview", storePassphrase: "preview", serverName: server, lumenAppJSON: nil
    )

    static func discovery(sso: Bool = true) -> ServerDiscovery {
        ServerDiscovery(
            serverName: server,
            homeserverURL: URL(string: "https://matrix.lumen.example")!,
            lumen: lumenInfo,
            loginFlows: LoginFlows(password: !sso, token: sso, sso: sso ? [LoginFlows.IdentityProvider(id: "lumen", name: "Lumen")] : []),
            supportsNativeSlidingSync: true
        )
    }

    // MARK: - Dates

    /// Today at the given time, or that many days earlier.
    static func at(daysAgo: Int = 0, _ hour: Int, _ minute: Int, now: Date = Date()) -> Date {
        let cal = Calendar.current
        let day = cal.date(byAdding: .day, value: -daysAgo, to: cal.startOfDay(for: now)) ?? now
        return cal.date(bySettingHour: hour, minute: minute, second: 0, of: day) ?? day
    }

    // MARK: - Room list

    static func room(_ id: String, _ name: String, direct: Bool = false, unread: UInt64 = 0, mentions: UInt64 = 0, markedUnread: Bool = false,
                     last: String?, at date: Date?, call: Bool = false, encrypted: Bool = true, invite: Bool = false, inviter: String? = nil) -> RoomSummary {
        RoomSummary(id: id, name: name, isDirect: direct, isInvite: invite, inviterId: inviter, unreadMessages: unread, unreadMentions: mentions,
                    isMarkedUnread: markedUnread, lastMessage: last, lastTimestamp: date, avatarURL: nil, hasCall: call,
                    isEncrypted: encrypted, isFavourite: false)
    }

    static func rooms() -> [RoomSummary] {
        [
            room(designRoomId, "Design crew", unread: 3, last: "Maya: The new onboarding illustrations are in the shared folder", at: at(9, 41)),
            room(priyaRoomId, "Priya Raman", direct: true, unread: 2, mentions: 1, last: "Are we still on for 3 pm? I booked the small room.", at: at(9, 12)),
            room("!oncall:lumen.example", "Platform on-call", unread: 1, last: "Call", at: at(8, 55), call: true),
            room("!quarterly:lumen.example", "Quarterly planning: Northern Europe enterprise accounts and partner programme",
                 last: "You: I'll send the summary after lunch, with the revised targets for each region", at: at(daysAgo: 1, 17, 20)),
            room("!legal:lumen.example", "Legal review", unread: 4, last: "Encrypted message", at: at(daysAgo: 1, 15, 2)),
            room("!jonas:lumen.example", "Jonas Weber", direct: true, markedUnread: true, last: "Sounds good, see you Thursday", at: at(daysAgo: 2, 11, 30)),
            room("!family:lumen.example", "Family", unread: 128, last: "Ana: Photo", at: at(daysAgo: 3, 20, 4)),
            room("!news:lumen.example", "Product announcements", last: "Release notes for 1.4 are live", at: at(daysAgo: 5, 10, 0), encrypted: false),
            room("!ana:lumen.example", "Ana Lima", direct: true, last: "You: Thanks, talk soon", at: at(daysAgo: 9, 18, 45)),
            room("!office:lumen.example", "Office logistics", last: "Sam: Parking passes are at the front desk", at: at(daysAgo: 16, 9, 5)),
        ]
    }

    static func invites() -> [RoomSummary] {
        [
            room("!guild:lumen.example", "Security guild", last: nil, at: at(8, 2), invite: true, inviter: "@erik:lumen.example"),
            room("!noor:lumen.example", "Noor Haddad", direct: true, last: nil, at: at(daysAgo: 1, 19, 30), invite: true, inviter: "@noor:lumen.example"),
        ]
    }

    // MARK: - Timeline

    private static func message(_ id: String, _ who: Person?, at date: Date, _ body: MessageRow.Body, edited: Bool = false,
                                reply: ReplyPreview? = nil, reactions: [ReactionGroup] = [], delivery: DeliveryState? = nil) -> TimelineRow {
        let own = who == nil
        let pending: Bool
        switch delivery {
        case .sending?, .failed?: pending = true
        default: pending = false
        }
        let row = MessageRow(
            itemId: pending ? .transactionId(transactionId: "txn-\(id)") : .eventId(eventId: "$\(id)"),
            eventId: pending ? nil : "$\(id)",
            sender: who?.userId ?? ownUserId,
            senderName: who?.name ?? ownName,
            isOwn: own,
            timestamp: date,
            body: body,
            isEdited: edited,
            reply: reply,
            reactions: reactions,
            delivery: own ? (delivery ?? .sent) : nil,
            isEditable: own && !pending,
            canReply: !pending,
            readBy: delivery == .read ? [maya.userId, sam.userId] : []
        )
        return TimelineRow(id: id, kind: .message(row))
    }

    private static func divider(_ id: String, _ date: Date) -> TimelineRow {
        TimelineRow(id: id, kind: .dateDivider(Calendar.current.startOfDay(for: date)))
    }

    private static func state(_ id: String, _ text: String) -> TimelineRow {
        TimelineRow(id: id, kind: .state(text))
    }

    private static func mediaSource(_ name: String) -> MediaSource? {
        try? MediaSource.fromUrl(url: "mxc://lumen.example/\(name)")
    }

    private static func attachment(_ kind: Attachment.Kind, _ filename: String, mime: String, size: UInt64, width: UInt64? = nil, height: UInt64? = nil) -> Attachment? {
        guard let source = mediaSource(filename.lowercased().replacingOccurrences(of: ".", with: "-")) else { return nil }
        return Attachment(kind: kind, filename: filename, mimeType: mime, size: size, width: width, height: height, source: source, thumbnailSource: nil)
    }

    private static func attachmentRow(_ id: String, _ who: Person?, at date: Date, _ a: Attachment?, caption: String? = nil, delivery: DeliveryState? = nil) -> TimelineRow {
        guard let a else { return message(id, who, at: date, .text(caption ?? "Attachment"), delivery: delivery) }
        return message(id, who, at: date, .attachment(a, caption: caption), delivery: delivery)
    }

    private static func call(_ id: String, _ who: Person?, at date: Date, video: Bool, active: [String] = [], declinedBy: [String] = [], joined: Bool = false) -> TimelineRow {
        let record = RtcNotificationRecord(eventId: "$\(id)", sender: who?.userId ?? ownUserId, timestamp: date, callIntent: video ? "video" : "audio",
                                           declinedBy: declinedBy, activeMembers: active, callStart: date, isJoined: joined)
        return TimelineRow(id: id, kind: .call(CallRow(record: record, senderName: who?.name ?? ownName)))
    }

    /// A busy group conversation: replies, reactions, edits, links, receipts
    /// and every delivery state.
    static func conversation() -> [TimelineRow] {
        let y = 1
        return [
            divider("d1", at(daysAgo: y, 9, 0)),
            state("s1", "Maya Chen created the room"),
            state("s2", "Messages in this room are end-to-end encrypted."),
            message("m1", maya, at: at(daysAgo: y, 9, 14), .text("Morning! I pushed the new onboarding flow to the shared board."),
                    reactions: [ReactionGroup(key: "👍", count: 3, includesMe: true), ReactionGroup(key: "🎉", count: 1, includesMe: false)]),
            message("m2", sam, at: at(daysAgo: y, 9, 20), .text("Nice. I went through it on the train: the **welcome screen** reads much better now, and the copy on step two finally explains *why* we ask for a recovery key. One question about the [verification spec](https://lumen.example/spec): do we show the emoji step before or after the device name? Either works for me, but `step 3` should stay short.")),
            message("m3", nil, at: at(daysAgo: y, 9, 26), .text("Looks great. Two small notes on the second screen, I'll add them to the board."), delivery: .read),
            message("m4", nil, at: at(daysAgo: y, 9, 27), .text("Agreed, let's keep step 3 short."),
                    reply: ReplyPreview(eventId: "$m2", senderName: sam.name, text: "Nice. I went through it on the train: the welcome screen reads much better now"), delivery: .read),
            divider("d2", at(9, 0)),
            message("m5", maya, at: at(9, 2), .text("Updated the illustrations (v3), softer colours and more space around the mark."), edited: true,
                    reactions: [ReactionGroup(key: "❤️", count: 2, includesMe: false)]),
            attachmentRow("m6", maya, at: at(9, 3), attachment(.image, "Onboarding-v3.png", mime: "image/png", size: 482_133, width: 1600, height: 1000), caption: "Final mockups"),
            TimelineRow(id: "rm", kind: .readMarker),
            attachmentRow("m7", priya, at: at(9, 20), attachment(.file, "Launch-plan-Q4.pdf", mime: "application/pdf", size: 2_411_520)),
            message("m8", sam, at: at(9, 31), .redacted),
            message("m9", nil, at: at(9, 38), .text("On my way, five minutes"), delivery: .sent),
            message("m10", nil, at: at(9, 40), .text("Can someone share the link to the call notes?"), delivery: .sending),
            message("m11", nil, at: at(9, 41), .text("Sent from the lift, no signal"), delivery: .failed(isRecoverable: true)),
        ]
    }

    /// Images, files, video and audio attachments.
    static func media() -> [TimelineRow] {
        [
            divider("d1", at(10, 0)),
            attachmentRow("a1", ana, at: at(10, 2), attachment(.image, "Harbour.jpg", mime: "image/jpeg", size: 1_204_224, width: 1200, height: 1600), caption: "Sunrise at the harbour"),
            attachmentRow("a2", nil, at: at(10, 5), attachment(.image, "Whiteboard.png", mime: "image/png", size: 845_002, width: 1600, height: 900), delivery: .read),
            attachmentRow("a3", jonas, at: at(10, 9), attachment(.video, "Demo-walkthrough.mov", mime: "video/quicktime", size: 48_234_496)),
            attachmentRow("a4", priya, at: at(10, 12), attachment(.audio, "Voice-note.m4a", mime: "audio/mp4", size: 312_010)),
            attachmentRow("a5", nil, at: at(10, 15), attachment(.file, "Quarterly-planning-Northern-Europe-enterprise-accounts-final-v7.xlsx", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", size: 734_003), delivery: .sending),
        ]
    }

    /// Messages that can't be shown normally: undecryptable, deleted,
    /// unsupported, plus call events and room changes.
    static func specialEvents() -> [TimelineRow] {
        [
            divider("d1", at(daysAgo: 2, 8, 0)),
            state("s1", "Jonas Weber joined"),
            message("u1", jonas, at: at(daysAgo: 2, 8, 4), .unableToDecrypt("Waiting for the key to decrypt this message. Verify this device or enter your recovery key.")),
            message("u2", sam, at: at(daysAgo: 2, 8, 6), .unableToDecrypt("You can't read this message: it was sent before you joined.")),
            message("u3", jonas, at: at(daysAgo: 2, 8, 7), .unableToDecrypt("Blocked: sent from a device its owner hasn't verified.")),
            message("x1", maya, at: at(daysAgo: 2, 8, 30), .redacted),
            message("x2", sam, at: at(daysAgo: 2, 8, 40), .unsupported("Poll: Team lunch on Friday? (open the web app to vote)")),
            call("c1", maya, at: at(daysAgo: 2, 9, 0), video: true),
            call("c2", nil, at: at(daysAgo: 2, 11, 0), video: false, declinedBy: [sam.userId]),
            divider("d2", at(10, 0)),
            state("s2", "Sam Okafor changed the topic to Weekly design sync"),
            message("e1", sam, at: at(10, 2), .emote("waves at everyone")),
            message("n1", maya, at: at(10, 3), .notice("Reminder: design review at 11:00")),
            call("c3", priya, at: at(10, 30), video: true, active: [priya.userId, maya.userId]),
        ]
    }

    /// A direct chat.
    static func directChat() -> [TimelineRow] {
        [
            divider("d1", at(9, 0)),
            state("s1", "Messages in this room are end-to-end encrypted."),
            message("p1", priya, at: at(9, 5), .text("Hi Alex, quick one before the review.")),
            message("p2", priya, at: at(9, 6), .text("Are we still on for 3 pm? I booked the small room.")),
            message("p3", nil, at: at(9, 10), .text("Yes, 3 pm works. I'll bring the printouts."), delivery: .read),
        ]
    }

    static func newRoom() -> [TimelineRow] {
        [
            divider("d1", at(9, 30)),
            state("s1", "You created the room"),
            state("s2", "Messages in this room are end-to-end encrypted."),
        ]
    }

    static func members() -> [MemberSummary] {
        [
            MemberSummary(userId: ownUserId, displayName: ownName),
            MemberSummary(userId: jonas.userId, displayName: jonas.name),
            MemberSummary(userId: maya.userId, displayName: maya.name),
            MemberSummary(userId: priya.userId, displayName: priya.name),
            MemberSummary(userId: sam.userId, displayName: sam.name),
            MemberSummary(userId: "@lee.wong-the-very-long-handle:lumen.example", displayName: nil, isInvited: true),
        ]
    }

    static let verifiedMembers: Set<String> = [maya.userId, priya.userId]

    @MainActor
    static func timeline(_ id: String, name: String, rows: [TimelineRow], direct: Bool = false, encrypted: Bool = true, reachedStart: Bool = true,
                         typing: [String] = [], warnings: [IdentityWarning] = [], loadError: String? = nil, call: Bool = false) -> TimelineModel {
        TimelineModel(preview: id, roomName: name, ownUserId: ownUserId, rows: rows, isDirect: direct, isEncrypted: encrypted,
                      hasActiveCall: call, reachedStart: reachedStart, typingUserIds: typing, identityWarnings: warnings, loadError: loadError,
                      members: direct ? members().filter { $0.userId == ownUserId || $0.userId == priya.userId } : members(),
                      verifiedUserIds: verifiedMembers)
    }

    // MARK: - Session

    @MainActor
    static func session(rooms: [RoomSummary]? = nil, loading: Bool = false, loadError: String? = nil, searchText: String = "",
                        recovery: RecoveryState = .enabled, verification: VerificationState = .verified, backup: BackupState = .enabled,
                        hasOtherDevices: Bool = true, verificationPhase: VerificationModel.Phase = .idle, verifyingUser: String? = nil,
                        data: SessionPreviewData = SessionPreviewData(), timelines: [TimelineModel] = [], media: MediaLoading) -> SessionModel {
        let list = RoomListModel()
        list.showPreview(rooms ?? (invites() + Self.rooms()), isLoading: loading, loadError: loadError, searchText: searchText)
        var data = data
        if data.displayName == nil { data.displayName = ownName }
        if data.callTransports.isEmpty { data.callTransports = ["livekit: https://rtc.lumen.example"] }
        for t in timelines { data.timelines[t.roomId] = t }
        let paths = StorePaths(root: FileManager.default.temporaryDirectory.appendingPathComponent("lumen-preview", isDirectory: true), isShared: false)
        return SessionModel(
            preview: data, account: account, lumen: lumenInfo, roomList: list,
            encryption: EncryptionModel(preview: recovery, backup: backup, verification: verification, hasOtherDevices: hasOtherDevices),
            verification: VerificationModel(preview: verificationPhase, otherUserId: verifyingUser),
            media: media, http: PreviewHTTPClient(), paths: paths
        )
    }

    static var sasEmoji: [VerificationModel.Emoji] { [
        .init(symbol: "🐶", name: "Dog"), .init(symbol: "🔑", name: "Key"), .init(symbol: "🌍", name: "Globe"),
        .init(symbol: "🎸", name: "Guitar"), .init(symbol: "🚀", name: "Rocket"), .init(symbol: "🍄", name: "Mushroom"),
        .init(symbol: "⏰", name: "Clock"),
    ] }

    static let recoveryKey = "EsTc 9Xh2 Lm4Q pR7v Wd3N k8Zs Yf6B uJ1e Ga5H qT0x Vn2C"
}

/// Answers the device list for preview sessions; every other request fails.
struct PreviewHTTPClient: HTTPClient {
    func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        guard request.url.path.hasSuffix("/devices") else { return HTTPResponse(status: 404, body: Data()) }
        let now = Date().timeIntervalSince1970 * 1000
        let devices: [[String: Any]] = [
            ["device_id": PreviewFixtures.deviceId, "display_name": "Lumen on iPhone", "last_seen_ip": "203.0.113.7", "last_seen_ts": now - 60_000],
            ["device_id": "MACBOOKQ2", "display_name": "Lumen on Mac", "last_seen_ts": now - 3_600_000 * 5],
            ["device_id": "WEBFIREFOX", "display_name": "Lumen Web (Firefox on Linux)", "last_seen_ts": now - 86_400_000 * 3],
            ["device_id": "OLDIPAD01"],
        ]
        let body = try JSONSerialization.data(withJSONObject: ["devices": devices])
        return HTTPResponse(status: 200, body: body)
    }
}
#endif
