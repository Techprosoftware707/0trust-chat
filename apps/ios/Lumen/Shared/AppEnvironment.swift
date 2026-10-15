import Foundation
import LumenCore

/// Process-wide configuration, read from the bundle's Info.plist (which the
/// build settings fill in). The app and the notification service extension
/// both carry the Lumen keys.
enum AppEnvironment {
    static let build: BuildConfiguration = {
        #if DEBUG
        let debug = true
        #else
        let debug = false
        #endif
        var info = Bundle.main.infoDictionary ?? [:]
        // The NSE's bundle ID is "<app>.LumenNSE"; the URL scheme and keychain
        // items belong to the containing app.
        if let id = info["CFBundleIdentifier"] as? String, id.hasSuffix(".LumenNSE") {
            info["CFBundleIdentifier"] = String(id.dropLast(".LumenNSE".count))
        }
        return BuildConfiguration(infoDictionary: info, isDebug: debug)
    }()

    static var appVersion: String {
        let v = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "?"
        let b = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "?"
        return "\(v) (\(b))"
    }

    static var userAgent: String { "LumenSecure-iOS/\(appVersion)" }
}

/// Where an account's Rust SDK stores live: the app group container (so the
/// NSE can open them), one directory per store ID.
struct StorePaths: Sendable {
    let root: URL
    /// False when the app group container isn't available (unsigned or
    /// misconfigured builds): the NSE then can't decrypt notifications.
    let isShared: Bool

    static func current(appGroup: String? = AppEnvironment.build.appGroup) -> StorePaths {
        #if os(iOS) || os(macOS)
        if let group = appGroup,
           let url = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) {
            return StorePaths(root: url.appendingPathComponent("Library/Application Support/Lumen", isDirectory: true), isShared: true)
        }
        #endif
        let fallback = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSTemporaryDirectory())
        return StorePaths(root: fallback.appendingPathComponent("Lumen", isDirectory: true), isShared: false)
    }

    func dataDirectory(storeID: String) -> URL {
        root.appendingPathComponent("Sessions/\(storeID)/data", isDirectory: true)
    }

    func cacheDirectory(storeID: String) -> URL {
        root.appendingPathComponent("Sessions/\(storeID)/cache", isDirectory: true)
    }

    /// Creates the directories with `completeUntilFirstUserAuthentication`
    /// protection: readable after the first unlock since boot, which the NSE
    /// needs while the device is locked. New files inherit the class.
    func prepare(storeID: String) throws -> (data: URL, cache: URL) {
        let data = dataDirectory(storeID: storeID)
        let cache = cacheDirectory(storeID: storeID)
        for dir in [root, root.appendingPathComponent("Sessions/\(storeID)", isDirectory: true), data, cache] {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true, attributes: StorePaths.protection)
            #if os(iOS)
            try? FileManager.default.setAttributes(StorePaths.protection, ofItemAtPath: dir.path)
            #endif
        }
        var excluded = URLResourceValues()
        excluded.isExcludedFromBackup = true
        var sessionDir = root.appendingPathComponent("Sessions", isDirectory: true)
        try? sessionDir.setResourceValues(excluded)
        return (data, cache)
    }

    func wipe(storeID: String) {
        try? FileManager.default.removeItem(at: root.appendingPathComponent("Sessions/\(storeID)", isDirectory: true))
    }

    func wipeAll() {
        try? FileManager.default.removeItem(at: root.appendingPathComponent("Sessions", isDirectory: true))
    }

    private static var protection: [FileAttributeKey: Any] {
        #if os(iOS)
        return [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
        #else
        return [:]
        #endif
    }
}

/// Persists the signed-in account. The app uses the Keychain implementation;
/// tests use an in-memory one.
protocol AccountStoring: Sendable {
    func load() -> StoredAccount?
    func save(_ account: StoredAccount) throws
    func delete() throws
}

/// User preferences in the app group's UserDefaults (readable by the NSE).
struct SharedPreferences: @unchecked Sendable {
    let defaults: UserDefaults

    static func current() -> SharedPreferences {
        let d = AppEnvironment.build.appGroup.flatMap { UserDefaults(suiteName: $0) } ?? .standard
        return SharedPreferences(defaults: d)
    }

    func load() -> LumenPreferences {
        LumenPreferences.decode(defaults.data(forKey: LumenPreferences.storageKey))
    }

    func save(_ p: LumenPreferences) {
        defaults.set(p.encoded(), forKey: LumenPreferences.storageKey)
    }

    func reset() {
        defaults.removeObject(forKey: LumenPreferences.storageKey)
    }
}
