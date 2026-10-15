import Foundation
import LumenCore
import MatrixRustSDK

enum ProcessRole: Sendable {
    case app
    case notificationExtension

    var lockHolderName: String {
        switch self {
        case .app: return "LumenApp"
        case .notificationExtension: return "LumenNSE"
        }
    }
}

enum SessionError: Error, LocalizedError {
    case noAccount
    case storeUnavailable(String)

    var errorDescription: String? {
        switch self {
        case .noAccount: return "You're not signed in."
        case .storeUnavailable(let m): return "The local message store couldn't be opened: \(m)"
        }
    }
}

/// Builds Rust SDK clients with the store, crypto and sync settings Lumen uses.
/// TLS validation uses the platform defaults; `disableSslVerification()` is
/// never called (CI greps for it).
struct ClientFactory: Sendable {
    let paths: StorePaths
    let userAgent: String

    init(paths: StorePaths = .current(), userAgent: String = AppEnvironment.userAgent) {
        self.paths = paths
        self.userAgent = userAgent
    }

    func builder(storeID: String, passphrase: String, role: ProcessRole) throws -> ClientBuilder {
        let dirs = try paths.prepare(storeID: storeID)
        var store = SqliteStoreBuilder(dataPath: dirs.data.path, cachePath: dirs.cache.path)
            .passphrase(passphrase: passphrase)
        if role == .notificationExtension {
            store = store.systemIsMemoryConstrained()
        }
        var builder = ClientBuilder()
            .sqliteStore(config: store)
            .slidingSyncVersionBuilder(versionBuilder: .discoverNative)
            .autoEnableCrossSigning(autoEnableCrossSigning: true)
            .autoEnableBackups(autoEnableBackups: false)
            .backupDownloadStrategy(backupDownloadStrategy: .afterDecryptionFailure)
            .userAgent(userAgent: userAgent)
            // The app and the NSE open the same store: the cross-process lock
            // keeps their crypto state and token refreshes consistent.
            .crossProcessLockConfig(crossProcessLockConfig: .multiProcess(holderName: role.lockHolderName))
        if role == .notificationExtension {
            builder = builder.systemIsMemoryConstrained()
        }
        return builder
    }

    /// A fresh client for signing in.
    func newClient(homeserverURL: URL, storeID: String, passphrase: String) async throws -> Client {
        try await builder(storeID: storeID, passphrase: passphrase, role: .app)
            .homeserverUrl(url: homeserverURL.absoluteString)
            .build()
    }

    /// Restores the stored session.
    func restoredClient(account: StoredAccount, store: AccountStoring, role: ProcessRole) async throws -> Client {
        let client = try await builder(storeID: account.storeID, passphrase: account.storePassphrase, role: role)
            .homeserverUrl(url: account.homeserverURL)
            .setSessionDelegate(sessionDelegate: StoredSessionDelegate(store: store))
            .build()
        try await client.restoreSession(session: account.sdkSession)
        return client
    }
}

extension StoredAccount {
    var sdkSession: Session {
        Session(
            accessToken: accessToken,
            refreshToken: refreshToken,
            userId: userId,
            deviceId: deviceId,
            homeserverUrl: homeserverURL,
            oauthData: oauthData,
            slidingSyncVersion: slidingSyncVersion == "native" ? .native : .none
        )
    }

    /// Copies the SDK's (possibly refreshed) tokens into the stored account.
    mutating func update(from session: Session) {
        accessToken = session.accessToken
        refreshToken = session.refreshToken
        deviceId = session.deviceId
        homeserverURL = session.homeserverUrl
        oauthData = session.oauthData
        slidingSyncVersion = session.slidingSyncVersion == .native ? "native" : "none"
    }

    static func from(session: Session, storeID: String, passphrase: String, serverName: String, lumen: LumenAppInfo?) -> StoredAccount {
        StoredAccount(
            userId: session.userId,
            deviceId: session.deviceId,
            accessToken: session.accessToken,
            refreshToken: session.refreshToken,
            homeserverURL: session.homeserverUrl,
            oauthData: session.oauthData,
            slidingSyncVersion: session.slidingSyncVersion == .native ? "native" : "none",
            storeID: storeID,
            storePassphrase: passphrase,
            serverName: serverName,
            lumenAppJSON: lumen?.jsonData()
        )
    }
}

/// Lets the SDK persist refreshed tokens and read the latest ones written by
/// the other process (app or NSE).
final class StoredSessionDelegate: ClientSessionDelegate {
    private let store: AccountStoring

    init(store: AccountStoring) {
        self.store = store
    }

    func retrieveSessionFromKeychain(userId: String) throws -> Session {
        guard let account = store.load(), account.userId == userId else {
            throw ClientError.Generic(msg: "No stored session for this user", details: nil)
        }
        return account.sdkSession
    }

    func saveSessionInKeychain(session: Session) {
        guard var account = store.load(), account.userId == session.userId else { return }
        account.update(from: session)
        try? store.save(account)
    }
}
