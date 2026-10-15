import BackgroundTasks
import Foundation
import LumenCore
import MatrixRustSDK
import Observation
import SwiftUI
import UIKit

/// The composition root: sign-in state, preferences, app lock, push and calls.
@Observable @MainActor
final class AppModel {
    static let shared = AppModel()

    enum Phase {
        case launching
        case signedOut
        case signedIn(SessionModel)
        case failed(String)
    }

    private(set) var phase: Phase = .launching
    let build = AppEnvironment.build
    let auth: AuthModel
    let calls = CallCoordinator()
    var preferences: LumenPreferences {
        didSet {
            prefsStore.save(preferences)
            lock.timeout = preferences.appLockTimeout
            if preferences.appLockEnabled != oldValue.appLockEnabled { lock.setEnabled(preferences.appLockEnabled) }
        }
    }
    private(set) var lock: AppLockState
    private(set) var sceneActive = true
    private(set) var pushPermission: PushPermission = .notDetermined
    private(set) var pusherRegistered = false
    private(set) var pushError: String?
    /// A link waiting for the user's confirmation before opening or joining.
    var pendingLink: DeepLinkRoute?
    var selectedRoomId: String?
    var signOutError: String?

    @ObservationIgnored let accountStore: AccountStoring = KeychainAccountStore()
    @ObservationIgnored let factory = ClientFactory()
    @ObservationIgnored let http: HTTPClient = URLSessionHTTPClient()
    @ObservationIgnored private let prefsStore = SharedPreferences.current()
    @ObservationIgnored private let network = NetworkMonitor()
    @ObservationIgnored private var deviceToken: Data?
    @ObservationIgnored private var launched = false

    static let refreshTaskId = "\(AppEnvironment.build.bundleIdentifier).refresh"

    init() {
        let prefs = SharedPreferences.current().load()
        preferences = prefs
        lock = AppLockState(enabled: prefs.appLockEnabled, timeout: prefs.appLockTimeout)
        auth = AuthModel(build: AppEnvironment.build, http: URLSessionHTTPClient(), factory: ClientFactory(), accountStore: KeychainAccountStore())
        NotificationCoordinator.shared.onOpenRoom = { [weak self] roomId in self?.selectedRoomId = roomId }
    }

    var session: SessionModel? {
        if case .signedIn(let s) = phase { return s }
        return nil
    }

    var storesShared: Bool { factory.paths.isShared }

    // MARK: - Launch and sign-in

    func launch() async {
        guard !launched else { return }
        launched = true
        network.onChange = { [weak self] ok in self?.session?.networkReachable = ok }
        network.start()
        do {
            if case let (account, client)? = try await AuthModel.restore(store: accountStore, factory: factory) {
                try await enter(account: account, client: client)
            } else {
                phase = .signedOut
            }
        } catch {
            Diagnostics.log("Session restore failed: \(error.localizedDescription)")
            phase = .failed("Your session couldn't be opened. You can try again, or sign out to start over on this device.")
        }
    }

    func retryLaunch() async {
        launched = false
        phase = .launching
        await launch()
    }

    func completeSignIn(account: StoredAccount, client: Client) async {
        do {
            try await enter(account: account, client: client)
        } catch {
            phase = .failed("Signed in, but the session couldn't be started: \(error.localizedDescription)")
        }
    }

    private func enter(account: StoredAccount, client: Client) async throws {
        let s = try SessionModel(client: client, account: account, accountStore: accountStore, paths: factory.paths)
        s.onLocalNotification = { [weak self] n, roomId, eventId in
            guard let self else { return }
            NotificationCoordinator.shared.post(n, roomId: roomId, eventId: eventId, preview: self.preferences.notificationPreview, appName: s.brandShortName)
        }
        phase = .signedIn(s)
        calls.attach(s)
        await s.start()
        await refreshPushStatus()
        if pushPermission == .granted { NotificationCoordinator.shared.registerForRemoteNotifications() }
    }

    func signOut(force: Bool) async {
        guard let s = session else { return }
        signOutError = nil
        do {
            if let token = deviceToken {
                try? await PusherRegistrar(client: s.client, lumen: s.lumen, appId: build.pushAppId).unregister(deviceToken: token)
            }
            try await s.signOut(force: force)
            calls.attach(nil)
            preferences = LumenPreferences()
            lock = AppLockState(enabled: false, timeout: preferences.appLockTimeout)
            pusherRegistered = false
            selectedRoomId = nil
            auth.reset()
            phase = .signedOut
        } catch {
            signOutError = "The server couldn't be reached to sign out. You can sign out on this device only; the device then stays listed in your account until you remove it from another device."
        }
    }

    /// The restored session failed to open: delete local data and start over.
    func resetLocalData() {
        if let account = accountStore.load() { factory.paths.wipe(storeID: account.storeID) }
        factory.paths.wipeAll()
        try? accountStore.delete()
        prefsStore.reset()
        preferences = LumenPreferences()
        phase = .signedOut
    }

    // MARK: - Scene and lock

    func scenePhaseChanged(_ p: ScenePhase) {
        switch p {
        case .active:
            sceneActive = true
            lock.willEnterForeground(at: MonotonicClock.now)
            session?.isInForeground = true
            Task { await session?.resumeSync() }
        case .inactive:
            sceneActive = false
        case .background:
            sceneActive = false
            lock.didEnterBackground(at: MonotonicClock.now)
            session?.isInForeground = false
            scheduleBackgroundRefresh()
        @unknown default:
            break
        }
    }

    func unlock() async {
        guard lock.isLocked else { return }
        if await Biometrics.authenticate(reason: "Unlock \(session?.brandShortName ?? "Lumen")") {
            lock.didAuthenticate()
        }
    }

    func setAppLock(enabled: Bool) async -> Bool {
        if enabled {
            guard Biometrics.kind != .unavailable else { return false }
            guard await Biometrics.authenticate(reason: "Turn on app lock") else { return false }
        }
        preferences.appLockEnabled = enabled
        if enabled { lock.didAuthenticate() }
        return true
    }

    // MARK: - Push

    var pushAvailability: PushAvailability {
        PushAvailability.evaluate(gatewayConfigured: session?.lumen?.pushGatewayURL != nil, permission: pushPermission, pusherRegistered: pusherRegistered, lastError: pushError)
    }

    func refreshPushStatus() async {
        pushPermission = await NotificationCoordinator.shared.permission()
    }

    func requestNotificationPermission() async {
        _ = await NotificationCoordinator.shared.requestPermission()
        await refreshPushStatus()
        if pushPermission == .granted { NotificationCoordinator.shared.registerForRemoteNotifications() }
    }

    func didRegister(deviceToken: Data) {
        self.deviceToken = deviceToken
        guard let s = session, s.lumen?.pushGatewayURL != nil else { return }
        let registrar = PusherRegistrar(client: s.client, lumen: s.lumen, appId: build.pushAppId)
        let deviceName = DeviceDisplayName.make(brandShortName: s.brandShortName, deviceModel: DeviceInfoProvider.model)
        Task {
            do {
                try await registrar.register(deviceToken: deviceToken, appDisplayName: s.brandName, deviceDisplayName: deviceName)
                pusherRegistered = true
                pushError = nil
            } catch {
                pusherRegistered = false
                pushError = "the server refused the pusher"
                Diagnostics.log("Pusher registration failed: \(error.localizedDescription)")
            }
        }
    }

    func didFailToRegister(error: Error) {
        pushError = "iOS couldn't register for notifications"
        Diagnostics.log("APNs registration failed: \(error.localizedDescription)")
    }

    // MARK: - Background refresh (servers without a push gateway)

    func scheduleBackgroundRefresh() {
        guard session != nil, session?.lumen?.pushGatewayURL == nil else { return }
        let request = BGAppRefreshTaskRequest(identifier: Self.refreshTaskId)
        request.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
        try? BGTaskScheduler.shared.submit(request)
    }

    func runBackgroundRefresh(_ task: BGAppRefreshTask) {
        let work = Task {
            await session?.backgroundRefresh(seconds: 20)
            task.setTaskCompleted(success: true)
        }
        task.expirationHandler = { work.cancel() }
        scheduleBackgroundRefresh()
    }

    // MARK: - Links

    func handle(url: URL) {
        let lumen = session?.lumen
        let router = DeepLinkRouter(appScheme: build.urlScheme, webAppHost: lumen?.webAppURL?.host, portalHost: lumen?.portalURL?.host)
        let route = router.route(url.absoluteString, pendingSsoNonce: auth.pendingSsoNonce)
        switch route {
        case .ssoCallback:
            // Sign-in callbacks are delivered to the ASWebAuthenticationSession
            // that started them; a stray one is ignored.
            Diagnostics.log("Ignored an SSO callback outside the sign-in sheet")
        case .room, .user:
            pendingLink = route
        case .portalInvite(let u):
            UIApplication.shared.open(u)
        case .reject:
            break
        }
    }
}
