import Foundation
import LumenCore
import MatrixRustSDK
import Observation

/// One room's live timeline and the actions on it.
@Observable @MainActor
final class TimelineModel {
    let roomId: String
    let ownUserId: String
    private(set) var rows: [TimelineRow] = []
    private(set) var isPaginating = false
    private(set) var reachedStart = false
    private(set) var typingUserIds: [String] = []
    private(set) var identityWarnings: [IdentityWarning] = []
    private(set) var roomName: String
    private(set) var isDirect = false
    private(set) var isEncrypted = false
    /// `isEncrypted` has been read from the room (so the UI never flashes
    /// "not encrypted" while it loads).
    private(set) var encryptionKnown = false
    private(set) var hasActiveCall = false
    private(set) var loadError: String?
    private(set) var callHistory: [CallHistoryEntry] = []

    /// The SDK room; nil only for DEBUG screenshot previews.
    @ObservationIgnored private let room: Room?
    @ObservationIgnored private let encryption: Encryption?
    /// Members shown by a DEBUG preview (no SDK room).
    @ObservationIgnored private var previewMembers: [MemberSummary] = []
    @ObservationIgnored private var previewVerified: Set<String> = []
    @ObservationIgnored private var timeline: Timeline?
    @ObservationIgnored private var items: [TimelineItem] = []
    @ObservationIgnored private var handles: [TaskHandle] = []
    @ObservationIgnored private var tasks: [Task<Void, Never>] = []
    @ObservationIgnored private var identityTracker = IdentityWarningTracker()
    @ObservationIgnored private var typingSent = false
    @ObservationIgnored var preferences: () -> LumenPreferences = { LumenPreferences() }

    init(room: Room, ownUserId: String, encryption: Encryption) {
        self.room = room
        self.roomId = room.id()
        self.ownUserId = ownUserId
        self.encryption = encryption
        self.roomName = room.displayName() ?? "Room"
        self.hasActiveCall = room.hasActiveRoomCall()
    }

    #if DEBUG
    /// A timeline without a server for DEBUG screenshots.
    init(preview roomId: String, roomName: String, ownUserId: String, rows: [TimelineRow], isDirect: Bool, isEncrypted: Bool,
         hasActiveCall: Bool = false, reachedStart: Bool = true, typingUserIds: [String] = [], identityWarnings: [IdentityWarning] = [],
         loadError: String? = nil, members: [MemberSummary] = [], verifiedUserIds: Set<String> = []) {
        self.room = nil
        self.encryption = nil
        self.roomId = roomId
        self.ownUserId = ownUserId
        self.roomName = roomName
        self.isDirect = isDirect
        self.isEncrypted = isEncrypted
        self.encryptionKnown = true
        self.hasActiveCall = hasActiveCall
        self.reachedStart = reachedStart
        self.typingUserIds = typingUserIds
        self.identityWarnings = identityWarnings
        self.loadError = loadError
        self.rows = rows
        self.previewMembers = members
        self.previewVerified = verifiedUserIds
        let calls: [RtcNotificationRecord] = rows.compactMap { if case .call(let c) = $0.kind { return c.record } else { return nil } }
        self.callHistory = CallHistoryBuilder.build(calls, ownUserId: ownUserId)
    }
    #endif

    func start() async {
        guard let room else { return }
        do {
            let t = try await room.timeline()
            timeline = t
            let (stream, cont) = makeStream([TimelineDiff].self)
            handles.append(await t.addListener(listener: TimelineDiffListener(cont)))
            tasks.append(Task { [weak self] in
                for await diff in stream { self?.apply(diff) }
            })
            let (pStream, pCont) = makeStream(PaginationStatus.self)
            handles.append(try await t.subscribeToBackPaginationStatus(listener: BackPaginationListener(pCont)))
            tasks.append(Task { [weak self] in
                for await s in pStream {
                    switch s {
                    case .idle(let hitStart): self?.isPaginating = false; self?.reachedStart = hitStart
                    case .paginating: self?.isPaginating = true
                    }
                }
            })
        } catch {
            loadError = "This room's messages couldn't be loaded."
            return
        }

        let (tStream, tCont) = makeStream([String].self)
        handles.append(room.subscribeToTypingNotifications(listener: TypingListener(tCont)))
        tasks.append(Task { [weak self, ownUserId] in
            for await ids in tStream { self?.typingUserIds = ids.filter { $0 != ownUserId } }
        })

        if let h = try? await room.subscribeToIdentityStatusChanges(listener: IdentityChangeListener(identityContinuation())) {
            handles.append(h)
        }

        isDirect = await room.isDirect()
        isEncrypted = await room.isEncrypted()
        encryptionKnown = true
        if let info = try? await room.roomInfo() {
            roomName = info.displayName ?? roomName
            hasActiveCall = info.hasRoomCall
        }
        await paginateBackwards()
    }

    private func identityContinuation() -> AsyncStream<[IdentityStatusChange]>.Continuation {
        let (stream, cont) = makeStream([IdentityStatusChange].self)
        tasks.append(Task { [weak self] in
            for await changes in stream { self?.applyIdentity(changes) }
        })
        return cont
    }

    func stop() {
        for t in tasks { t.cancel() }
        for h in handles { h.cancel() }
        tasks.removeAll()
        handles.removeAll()
        timeline = nil
        if typingSent, let room { Task { [room] in try? await room.typingNotice(isTyping: false) } }
    }

    // MARK: - Diffs

    private func apply(_ diffs: [TimelineDiff]) {
        let mapped: [ListDiff<TimelineItem>] = diffs.map { d in
            switch d {
            case .append(let v): return .append(v)
            case .clear: return .clear
            case .pushFront(let v): return .pushFront(v)
            case .pushBack(let v): return .pushBack(v)
            case .popFront: return .popFront
            case .popBack: return .popBack
            case .insert(let i, let v): return .insert(Int(i), v)
            case .set(let i, let v): return .set(Int(i), v)
            case .remove(let i): return .remove(Int(i))
            case .truncate(let n): return .truncate(Int(n))
            case .reset(let v): return .reset(v)
            }
        }
        do {
            try ListDiffApplier.apply(mapped, to: &items)
        } catch {
            loadError = "The timeline got out of sync. Reopen the room."
        }
        rows = items.compactMap { TimelineRowMapper.map($0, ownUserId: ownUserId) }
        let calls: [RtcNotificationRecord] = rows.compactMap { if case .call(let c) = $0.kind { return c.record } else { return nil } }
        callHistory = CallHistoryBuilder.build(calls, ownUserId: ownUserId)
    }

    private func applyIdentity(_ changes: [IdentityStatusChange]) {
        identityTracker.apply(changes.map { c in
            let s: IdentityStatus
            switch c.changedTo {
            case .verified: s = .verified
            case .pinned: s = .pinned
            case .pinViolation: s = .pinViolation
            case .verificationViolation: s = .verificationViolation
            }
            return (userId: c.userId, status: s)
        })
        identityWarnings = identityTracker.warnings(ownUserId: ownUserId)
    }

    // MARK: - Actions

    func paginateBackwards() async {
        guard let timeline, !isPaginating, !reachedStart else { return }
        isPaginating = true
        defer { isPaginating = false }
        if let hitStart = try? await timeline.paginateBackwards(numEvents: 40) {
            reachedStart = hitStart
        }
    }

    func send(text: String, replyTo eventId: String?) async throws {
        guard let timeline else { return }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let content = messageEventContentFromMarkdown(md: trimmed)
        if let eventId {
            _ = try await timeline.sendReply(msg: content, eventId: eventId)
        } else {
            _ = try await timeline.send(msg: content)
        }
        await setTyping(false)
    }

    func edit(_ item: EventOrTransactionId, newText: String) async throws {
        guard let timeline else { return }
        let trimmed = newText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        try await timeline.edit(eventOrTransactionId: item, newContent: .roomMessage(content: messageEventContentFromMarkdown(md: trimmed)))
    }

    func toggleReaction(_ item: EventOrTransactionId, key: String) async throws {
        _ = try await timeline?.toggleReaction(itemId: item, key: key)
    }

    func redact(_ item: EventOrTransactionId) async throws {
        try await timeline?.redactEvent(eventOrTransactionId: item, reason: nil)
    }

    func retrySend(_ item: EventOrTransactionId) async throws {
        _ = try await timeline?.retrySend(itemId: item, target: .event)
    }

    func cancelSend(_ item: EventOrTransactionId) async throws {
        _ = try await timeline?.abortSend(itemId: item, target: .event)
    }

    /// Sends a file. In encrypted rooms the SDK encrypts it (AES-CTR,
    /// `EncryptedFile`) before upload.
    func sendFile(at url: URL, mimeType: String?, isImage: Bool, width: UInt64?, height: UInt64?, caption: String?) async throws {
        guard let timeline else { return }
        let size = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber)?.uint64Value
        let params = UploadParameters(source: .file(filename: url.path), caption: caption, formattedCaption: nil, mentions: nil, inReplyTo: nil, extraContentJson: nil)
        let handle: SendAttachmentJoinHandle
        if isImage {
            let info = ImageInfo(height: height, width: width, mimetype: mimeType, size: size, thumbnailInfo: nil, thumbnailSource: nil, blurhash: nil, isAnimated: nil)
            handle = try timeline.sendImage(params: params, thumbnailSource: nil, imageInfo: info)
        } else {
            let info = FileInfo(mimetype: mimeType, size: size, thumbnailInfo: nil, thumbnailSource: nil)
            handle = try timeline.sendFile(params: params, fileInfo: info)
        }
        try await handle.join()
    }

    /// Read receipts follow the privacy setting: public `m.read`, or private
    /// `m.read.private` when the user turned receipts off.
    func markAsRead() async {
        let type: ReceiptType = preferences().sendReadReceipts ? .read : .readPrivate
        try? await timeline?.markAsRead(receiptType: type)
    }

    /// Typing notices are sent only when the user allows them.
    func setTyping(_ typing: Bool) async {
        guard preferences().sendTypingNotices || (!typing && typingSent) else { return }
        guard typing != typingSent else { return }
        typingSent = typing
        try? await room?.typingNotice(isTyping: typing)
    }

    /// Acknowledge a changed identity (pin it) or withdraw a broken verification.
    func resolve(_ warning: IdentityWarning) async throws {
        guard let encryption, let identity = try await encryption.userIdentity(userId: warning.userId, fallbackToServer: true) else { return }
        switch warning.kind {
        case .changed: try await identity.pin()
        case .verifiedChanged: try await identity.withdrawVerification()
        }
    }

    /// Reports a message to the server's administrators (App Review 1.2).
    /// In encrypted rooms the server receives only the event ID and the reason,
    /// not the decrypted text.
    func report(eventId: String, reason: String?) async throws {
        try await room?.reportContent(eventId: eventId, reason: reason)
    }

    /// Names of the people typing, from their messages in the loaded
    /// timeline (else the user ID's localpart).
    var typingNames: [String] {
        typingUserIds.map { id in
            for row in rows.reversed() {
                if case .message(let m) = row.kind, m.sender == id { return m.senderName }
            }
            return Self.localpart(id)
        }
    }

    nonisolated static func localpart(_ userId: String) -> String {
        guard userId.hasPrefix("@") else { return userId }
        return String(userId.dropFirst().prefix { $0 != ":" })
    }

    func displayName(of userId: String) async -> String {
        guard let room else { return previewMembers.first { $0.userId == userId }?.displayName ?? userId }
        return (try? await room.memberDisplayName(userId: userId)).flatMap { $0 } ?? userId
    }

    func leave() async throws {
        try await room?.leave()
    }

    /// Joined and invited members sorted by name (at most about 500 loaded).
    func loadMembers() async -> [MemberSummary] {
        guard let room else { return previewMembers }
        guard let it = try? await room.members() else { return [] }
        var all: [RoomMember] = []
        while let chunk = it.nextChunk(chunkSize: 100), all.count < 500 {
            all.append(contentsOf: chunk)
        }
        return all.filter { $0.membership == .join || $0.membership == .invite }
            .map { MemberSummary(userId: $0.userId, displayName: $0.displayName, isInvited: $0.membership == .invite) }
            .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    /// Which of the first 50 other members have a verified identity, from
    /// this device's crypto store (no server request).
    func verifiedUserIds(among members: [MemberSummary]) async -> Set<String> {
        guard let encryption else { return previewVerified }
        var verified: Set<String> = []
        for m in members.prefix(50) where m.userId != ownUserId {
            if let identity = try? await encryption.userIdentity(userId: m.userId, fallbackToServer: false), identity.isVerified() {
                verified.insert(m.userId)
            }
        }
        return verified
    }
}

/// A room member as the details screen shows it.
struct MemberSummary: Identifiable, Equatable, Sendable {
    var userId: String
    var displayName: String?
    var isInvited = false
    var id: String { userId }
    var name: String { displayName ?? userId }
}
