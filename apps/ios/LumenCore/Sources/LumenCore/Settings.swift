import Foundation

/// User preferences. Stored in the app group's UserDefaults so the
/// notification service extension can read the preview setting.
public struct LumenPreferences: Codable, Equatable, Sendable {
    /// Public read receipts (`m.read`). Off: private receipts (`m.read.private`) are sent instead.
    public var sendReadReceipts: Bool = true
    public var sendTypingNotices: Bool = true
    public var notificationPreview: NotificationPreview = .default
    public var appLockEnabled: Bool = false
    public var appLockTimeout: AppLockTimeout = .oneMinute

    public init() {}

    public static let storageKey = "lumen.preferences.v1"

    public static func decode(_ data: Data?) -> LumenPreferences {
        guard let data, let p = try? JSONDecoder().decode(LumenPreferences.self, from: data) else { return LumenPreferences() }
        return p
    }

    public func encoded() -> Data {
        (try? JSONEncoder().encode(self)) ?? Data()
    }

    // Tolerate missing keys from older versions.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let d = LumenPreferences()
        sendReadReceipts = (try? c.decode(Bool.self, forKey: .sendReadReceipts)) ?? d.sendReadReceipts
        sendTypingNotices = (try? c.decode(Bool.self, forKey: .sendTypingNotices)) ?? d.sendTypingNotices
        notificationPreview = (try? c.decode(NotificationPreview.self, forKey: .notificationPreview)) ?? d.notificationPreview
        appLockEnabled = (try? c.decode(Bool.self, forKey: .appLockEnabled)) ?? d.appLockEnabled
        appLockTimeout = (try? c.decode(AppLockTimeout.self, forKey: .appLockTimeout)) ?? d.appLockTimeout
    }
}

/// Persisted per-account session data (the SDK `Session` plus local store
/// information). Kept in the Keychain only.
public struct StoredAccount: Codable, Equatable, Sendable {
    public var userId: String
    public var deviceId: String
    public var accessToken: String
    public var refreshToken: String?
    public var homeserverURL: String
    public var oauthData: String?
    /// "native" or "none"
    public var slidingSyncVersion: String
    /// Directory name of this account's stores in the app group container.
    public var storeID: String
    /// Base64 of 32 random bytes; the SQLite store passphrase.
    public var storePassphrase: String
    /// The server's discovery data at sign-in, for links and push.
    public var serverName: String
    public var lumenAppJSON: Data?

    public init(userId: String, deviceId: String, accessToken: String, refreshToken: String?, homeserverURL: String, oauthData: String?, slidingSyncVersion: String, storeID: String, storePassphrase: String, serverName: String, lumenAppJSON: Data?) {
        self.userId = userId
        self.deviceId = deviceId
        self.accessToken = accessToken
        self.refreshToken = refreshToken
        self.homeserverURL = homeserverURL
        self.oauthData = oauthData
        self.slidingSyncVersion = slidingSyncVersion
        self.storeID = storeID
        self.storePassphrase = storePassphrase
        self.serverName = serverName
        self.lumenAppJSON = lumenAppJSON
    }

    /// 32 bytes from the system CSPRNG, base64.
    public static func makeStorePassphrase() -> String {
        var g = SystemRandomNumberGenerator()
        let bytes = (0..<32).map { _ in UInt8.random(in: 0...255, using: &g) }
        return Data(bytes).base64EncodedString()
    }

    /// A store directory name: a UUID, never derived from the user ID.
    public static func makeStoreID() -> String { UUID().uuidString.lowercased() }
}

extension LumenAppInfo {
    /// Serialises the parsed block back to the well-known shape, so it can be
    /// stored with the account and re-parsed (and re-validated) on launch.
    public func jsonData() -> Data? {
        var o: [String: Any] = ["version": 1]
        var brand: [String: Any] = [:]
        if let b = brandName { brand["name"] = b }
        if let b = brandShortName { brand["short_name"] = b }
        if !brand.isEmpty { o["brand"] = brand }
        let urls: [(String, URL?)] = [
            ("portal_url", portalURL), ("signup_url", signupURL), ("account_url", accountURL),
            ("account_delete_url", accountDeleteURL),
            ("privacy_url", privacyURL), ("help_url", helpURL), ("web_app_url", webAppURL),
            ("call_widget_url", callWidgetURL), ("push_gateway_url", pushGatewayURL),
        ]
        for (k, v) in urls { if let v { o[k] = v.absoluteString } }
        if let i = ssoIdpId { o["sso_idp_id"] = i }
        return try? JSONSerialization.data(withJSONObject: o, options: [.sortedKeys])
    }

    public static func fromJSONData(_ data: Data?) -> LumenAppInfo? {
        guard let data, let obj = try? JSONSerialization.jsonObject(with: data) else { return nil }
        return parse(obj)
    }
}
