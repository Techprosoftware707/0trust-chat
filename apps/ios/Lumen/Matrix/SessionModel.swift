import Foundation
import LumenCore
import MatrixRustSDK
import Observation

/// One signed-in account: the Rust SDK client, its sync loop and the models
/// the screens use.
@Observable @MainActor
final class SessionModel {
    /// The Rust SDK client. Only DEBUG preview sessions (screenshots) have
    /// none; they never reach code that needs it.
    private let sdkClient: Client?
    var client: Client {
        guard let sdkClient else { preconditionFailure("A preview session has no SDK client") }
        return sdkClient
    }
    private(set) var account: StoredAccount
    let lumen: LumenAppInfo?
    let userId: String
    let deviceId: String

    private(set) var syncStatus: SyncStatus = .idle
    private(set) var syncIndicatorVisible = false
    private(set) var wasDisconnected = false
    var networkReachable = true
    private(set) var ignoredUsers: [String] = []
    private(set) var authError: String?

    let roomList: RoomListModel
    let encryption: EncryptionModel
    let verification: VerificationModel
    /// Attachment images and files for the timeline.
    @ObservationIgnored let media: MediaLoading
    /// Canned data of a DEBUG preview session; nil for real sessions.
    @ObservationIgnored private let preview: SessionPreviewData?

    /// Called for rings and for notifications that should be shown locally
    /// (background refresh or other rooms while in the foreground).
    var onRing: ((IncomingRing) -> Void)?
    var onLocalNotification: ((MappedNotification, String, String?) -> Void)?

    @ObservationIgnored private let accountStore: AccountStoring
    @ObservationIgnored private let paths: StorePaths
    @ObservationIgnored private let http: HTTPClient
    @ObservationIgnored private var syncService: SyncService?
    @ObservationIgnored private var handles: [TaskHandle] = []
    @ObservationIgnored private var tasks: [Task<Void, Never>] = []

    var banner: ConnectionBanner? {
        ConnectionBanner.from(sync: syncStatus, networkReachable: networkReachable, syncIndicatorVisible: syncIndicatorVisible, wasDisconnected: wasDisconnected)
    }

    var brandName: String { lumen?.displayName ?? LumenAppInfo.defaultBrandName }
    var brandShortName: String { lumen?.displayShortName ?? "Lumen" }
    var serverName: String { account.serverName }

    init(client: Client, account: StoredAccount, accountStore: AccountStoring, paths: StorePaths) throws {
        self.sdkClient = client
        self.account = account
        self.accountStore = accountStore
        self.paths = paths
        self.http = URLSessionHTTPClient()
        self.lumen = LumenAppInfo.fromJSONData(account.lumenAppJSON)
        self.userId = try client.userId()
        self.deviceId = try client.deviceId()
        self.roomList = RoomListModel()
        self.encryption = EncryptionModel(encryption: client.encryption())
        self.verification = VerificationModel(client: client)
        self.media = SDKMediaLoader(client: client)
        self.preview = nil
    }

    #if DEBUG
    /// A session without a server for DEBUG screenshots: the given models and
    /// canned data, no SDK client, no sync.
    init(preview data: SessionPreviewData, account: StoredAccount, lumen: LumenAppInfo?, roomList: RoomListModel,
         encryption: EncryptionModel, verification: VerificationModel, media: MediaLoading, http: HTTPClient, paths: StorePaths) {
        self.sdkClient = nil
        self.account = account
        self.accountStore = PreviewAccountStore()
        self.paths = paths
        self.http = http
        self.lumen = lumen
        self.userId = account.userId
        self.deviceId = account.deviceId
        self.roomList = roomList
        self.encryption = encryption
        self.verification = verification
        self.media = media
        self.preview = data
        self.syncStatus = data.syncStatus
        self.networkReachable = data.networkReachable
        self.wasDisconnected = data.wasDisconnected
        self.syncIndicatorVisible = data.syncIndicatorVisible
        self.ignoredUsers = data.ignoredUsers
        self.authError = data.authError
    }
    #endif

    // MARK: - Lifecycle

    func start() async {
        let (authStream, authCont) = makeStream(Bool.self)
        if let h = try? client.setDelegate(delegate: ClientEventsListener(authCont)) { handles.append(h) }
        tasks.append(Task { [weak self] in
            for await soft in authStream {
                self?.authError = soft ? "Your session needs to be signed in again." : "This device was signed out by the server."
            }
        })

        let (ignoredStream, ignoredCont) = makeStream([String].self)
        handles.append(client.subscribeToIgnoredUsers(listener: IgnoredListener(ignoredCont)))
        tasks.append(Task { [weak self] in
            for await ids in ignoredStream { self?.ignoredUsers = ids }
        })
        ignoredUsers = (try? await client.ignoredUsers()) ?? []

        let (notifStream, notifCont) = makeStream(SyncNotification.self)
        await client.registerNotificationHandler(listener: SyncNotificationsListener(notifCont))
        tasks.append(Task { [weak self] in
            for await n in notifStream { self?.handleSyncNotification(n) }
        })

        do {
            let service = try await client.syncService().withOfflineMode().finish()
            syncService = service
            let (stateStream, stateCont) = makeStream(SyncServiceState.self)
            handles.append(service.state(listener: SyncStateListener(stateCont)))
            tasks.append(Task { [weak self] in
                for await s in stateStream { self?.apply(syncState: s) }
            })
            let rls = service.roomListService()
            let (indStream, indCont) = makeStream(RoomListServiceSyncIndicator.self)
            handles.append(rls.syncIndicator(delayBeforeShowingInMs: 1500, delayBeforeHidingInMs: 500, listener: SyncIndicatorListener(indCont)))
            tasks.append(Task { [weak self] in
                for await i in indStream { self?.syncIndicatorVisible = (i == .show) }
            })
            await roomList.start(service: rls)
            await service.start()
        } catch {
            syncStatus = .error
        }
        encryption.start()
        verification.start()
    }

    private func apply(syncState: SyncServiceState) {
        let mapped: SyncStatus
        switch syncState {
        case .idle: mapped = .idle
        case .running: mapped = .running
        case .terminated: mapped = .terminated
        case .error: mapped = .error
        case .offline: mapped = .offline
        }
        if mapped == .error || mapped == .offline || mapped == .terminated { wasDisconnected = true }
        if mapped == .running && wasDisconnected {
            syncStatus = mapped
            Task { [weak self] in
                try? await Task.sleep(nanoseconds: 4_000_000_000)
                self?.wasDisconnected = false
            }
            return
        }
        syncStatus = mapped
        if mapped == .error {
            // The SDK stops on errors; restart with a short delay.
            Task { [weak self] in
                try? await Task.sleep(nanoseconds: 3_000_000_000)
                await self?.syncService?.start()
            }
        }
    }

    func retrySync() {
        Task { await syncService?.start() }
    }

    /// Background: stop the sync loop (iOS suspends the app anyway).
    func pauseSync() async {
        await syncService?.stop()
    }

    func resumeSync() async {
        await syncService?.start()
    }

    /// A short sync for BGAppRefreshTask when there is no push gateway.
    func backgroundRefresh(seconds: Double) async {
        await syncService?.start()
        try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
        await syncService?.stop()
    }

    func tearDown() async {
        await syncService?.stop()
        for t in tasks { t.cancel() }
        for h in handles { h.cancel() }
        tasks.removeAll()
        handles.removeAll()
        roomList.stop()
        encryption.stop()
        verification.stop()
    }

    // MARK: - Notifications from sync

    var activeRoomId: String?
    var isInForeground = true

    private func handleSyncNotification(_ n: SyncNotification) {
        var eventId: String?
        if case .timeline(let ev) = n.item.event { eventId = ev.eventId() }
        let mapped = NotificationMapper.map(n.item, roomId: n.roomId, eventId: eventId)
        if let ring = mapped.ring {
            if IncomingRingPolicy.shouldRing(sender: ring.sender, ownUserId: userId, isRing: true, sentAt: ring.sentAt, expiresAt: ring.expiresAt, now: Date()) {
                onRing?(ring)
            }
            return
        }
        guard mapped.isNoisy || mapped.kind == .invite else { return }
        if isInForeground && activeRoomId == n.roomId { return }
        onLocalNotification?(mapped, n.roomId, eventId)
    }

    // MARK: - Account actions

    func ignore(userId: String) async throws {
        try await client.ignoreUser(userId: userId)
    }

    func unignore(userId: String) async throws {
        try await client.unignoreUser(userId: userId)
    }

    func devicesAPI() -> DevicesAPI {
        let client = sdkClient
        return DevicesAPI(http: http, homeserverURL: URL(string: account.homeserverURL)!, accessToken: {
            guard let client else { return "" }
            return try client.session().accessToken
        })
    }

    func displayName() async -> String? {
        guard let sdkClient else { return preview?.displayName }
        return try? await sdkClient.displayName()
    }

    /// The server's MatrixRTC transports (Settings → About).
    func callTransports() async -> [String] {
        guard let sdkClient else { return preview?.callTransports ?? [] }
        return await CallRoomActions(client: sdkClient).transports()
    }

    /// The live timeline of a room, or nil when the room isn't known here.
    func makeTimelineModel(roomId: String) -> TimelineModel? {
        guard let sdkClient else { return preview?.timelines[roomId] }
        guard let room = roomList.room(id: roomId) else { return nil }
        return TimelineModel(room: room, ownUserId: userId, encryption: sdkClient.encryption())
    }

    /// Signs out: `POST /logout` (the server deletes the device and its
    /// pushers), then deletes the local stores and the Keychain item. With
    /// `force`, local data is deleted even if the server can't be reached.
    func signOut(force: Bool) async throws {
        do {
            try await client.logout()
        } catch {
            if !force { throw error }
        }
        await tearDown()
        paths.wipe(storeID: account.storeID)
        try? accountStore.delete()
        SharedPreferences.current().reset()
    }
}

/// Canned data shown by a DEBUG preview session (screenshots).
struct SessionPreviewData {
    var displayName: String?
    var callTransports: [String] = []
    var timelines: [String: TimelineModel] = [:]
    var syncStatus: SyncStatus = .running
    var networkReachable = true
    var wasDisconnected = false
    var syncIndicatorVisible = false
    var ignoredUsers: [String] = []
    var authError: String?
}

#if DEBUG
/// Preview sessions store nothing.
struct PreviewAccountStore: AccountStoring {
    func load() -> StoredAccount? { nil }
    func save(_ account: StoredAccount) throws {}
    func delete() throws {}
}
#endif
