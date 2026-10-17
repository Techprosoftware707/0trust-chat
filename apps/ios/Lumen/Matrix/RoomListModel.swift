import Foundation
import LumenCore
import MatrixRustSDK
import Observation

struct RoomSummary: Identifiable, Equatable, Sendable {
    var id: String
    var name: String
    var isDirect: Bool
    var isInvite: Bool
    var inviterId: String?
    var unreadMessages: UInt64
    var unreadMentions: UInt64
    var isMarkedUnread: Bool
    var lastMessage: String?
    var lastTimestamp: Date?
    var avatarURL: String?
    var hasCall: Bool
    var isEncrypted: Bool
    var isFavourite: Bool

    var hasUnread: Bool { unreadMessages > 0 || isMarkedUnread }
}

@Observable @MainActor
final class RoomListModel {
    private(set) var summaries: [RoomSummary] = []
    private(set) var isLoading = true
    private(set) var loadError: String?
    var searchText = "" {
        didSet { if searchText != oldValue { applyFilter() } }
    }

    @ObservationIgnored private var rooms: [Room] = []
    @ObservationIgnored private var result: RoomListEntriesWithDynamicAdaptersResult?
    @ObservationIgnored private var streamHandle: TaskHandle?
    @ObservationIgnored private var consumer: Task<Void, Never>?
    @ObservationIgnored private var refreshTask: Task<Void, Never>?
    @ObservationIgnored private var service: RoomListService?

    var invites: [RoomSummary] { summaries.filter(\.isInvite) }
    var joined: [RoomSummary] { summaries.filter { !$0.isInvite } }

    func start(service: RoomListService) async {
        self.service = service
        do {
            let list = try await service.allRooms()
            let (stream, cont) = makeStream([RoomListEntriesUpdate].self)
            let r = list.entriesWithDynamicAdapters(pageSize: 200, listener: RoomEntriesListener(cont))
            result = r
            streamHandle = r.entriesStream()
            applyFilter()
            consumer = Task { [weak self] in
                for await updates in stream { self?.apply(updates) }
            }
        } catch {
            isLoading = false
            loadError = "The room list couldn't be loaded."
        }
    }

    func stop() {
        consumer?.cancel()
        refreshTask?.cancel()
        streamHandle?.cancel()
        result = nil
        rooms = []
    }

    func loadMore() {
        result?.controller().addOnePage()
    }

    #if DEBUG
    /// Fixed contents for DEBUG screenshots (no SDK).
    func showPreview(_ summaries: [RoomSummary], isLoading: Bool = false, loadError: String? = nil, searchText: String = "") {
        self.summaries = summaries
        self.isLoading = isLoading
        self.loadError = loadError
        self.searchText = searchText
    }
    #endif

    private func applyFilter() {
        var filters: [RoomListEntriesDynamicFilterKind] = [.nonLeft, .nonSpace, .deduplicateVersions]
        let q = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        if !q.isEmpty { filters.append(.normalizedMatchRoomName(pattern: q)) }
        _ = result?.controller().setFilter(kind: .all(filters: filters))
    }

    private func apply(_ updates: [RoomListEntriesUpdate]) {
        let diffs: [ListDiff<Room>] = updates.map { u in
            switch u {
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
            try ListDiffApplier.apply(diffs, to: &rooms)
        } catch {
            // Out of sync with the SDK: ask for a fresh list.
            rooms = []
            applyFilter()
        }
        scheduleRefresh()
    }

    /// Room summaries need async SDK calls; coalesce bursts of updates.
    private func scheduleRefresh() {
        refreshTask?.cancel()
        let snapshot = rooms
        refreshTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 120_000_000)
            guard !Task.isCancelled else { return }
            var out: [RoomSummary] = []
            out.reserveCapacity(snapshot.count)
            for room in snapshot {
                if let s = await RoomListModel.summary(for: room) { out.append(s) }
                if Task.isCancelled { return }
            }
            self?.summaries = out
            self?.isLoading = false
        }
    }

    static func summary(for room: Room) async -> RoomSummary? {
        guard let info = try? await room.roomInfo() else { return nil }
        var preview: String?
        var ts: Date?
        switch await room.latestEvent() {
        case .remote(let timestamp, _, let isOwn, _, let content):
            preview = TimelineText.preview(content, isOwn: isOwn)
            ts = Date(timeIntervalSince1970: TimeInterval(timestamp) / 1000)
        case .local(let timestamp, _, _, let content, _):
            preview = TimelineText.preview(content, isOwn: true)
            ts = Date(timeIntervalSince1970: TimeInterval(timestamp) / 1000)
        case .remoteInvite(let timestamp, _, _):
            ts = Date(timeIntervalSince1970: TimeInterval(timestamp) / 1000)
        case .none:
            break
        }
        let encrypted: Bool
        switch info.encryptionState {
        case .encrypted: encrypted = true
        default: encrypted = false
        }
        return RoomSummary(
            id: info.id,
            name: info.displayName ?? info.rawName ?? info.canonicalAlias ?? "Unnamed room",
            isDirect: info.isDirect,
            isInvite: info.membership == .invited,
            inviterId: info.inviter?.userId,
            unreadMessages: info.numUnreadMessages,
            unreadMentions: info.numUnreadMentions,
            isMarkedUnread: info.isMarkedUnread,
            lastMessage: preview,
            lastTimestamp: ts,
            avatarURL: info.avatarUrl,
            hasCall: info.hasRoomCall,
            isEncrypted: encrypted,
            isFavourite: info.isFavourite
        )
    }

    func room(id: String) -> Room? {
        if let r = rooms.first(where: { $0.id() == id }) { return r }
        return try? service?.room(roomId: id)
    }
}

/// Room creation, invitations and lookups.
@MainActor
struct RoomActions {
    let client: Client

    /// Opens the existing DM with `userId` or creates an encrypted one.
    func startDirectMessage(with userId: String) async throws -> String {
        if let existing = try client.getDmRoom(userId: userId) {
            return existing.id()
        }
        let params = CreateRoomParameters(
            name: nil, isEncrypted: true, isDirect: true,
            visibility: .private, preset: .trustedPrivateChat, invite: [userId]
        )
        return try await client.createRoom(request: params)
    }

    /// Creates an encrypted, invite-only group.
    func createGroup(name: String, topic: String?, invite: [String]) async throws -> String {
        let params = CreateRoomParameters(
            name: name, topic: topic, isEncrypted: true, isDirect: false,
            visibility: .private, preset: .privateChat, invite: invite.isEmpty ? nil : invite
        )
        return try await client.createRoom(request: params)
    }

    func searchUsers(_ term: String) async throws -> [UserProfile] {
        try await client.searchUsers(searchTerm: term, limit: 20).results
    }

    func accept(roomId: String) async throws {
        guard let room = try client.getRoom(roomId: roomId) else { return }
        try await room.join()
    }

    func decline(roomId: String) async throws {
        guard let room = try client.getRoom(roomId: roomId) else { return }
        try await room.leave()
    }

    func leave(roomId: String) async throws {
        guard let room = try client.getRoom(roomId: roomId) else { return }
        try await room.leave()
    }

    /// Joins a room from a link (after the user confirmed).
    func join(idOrAlias: String, via: [String]) async throws -> String {
        let room = try await client.joinRoomByIdOrAlias(roomIdOrAlias: idOrAlias, serverNames: via)
        return room.id()
    }
}
