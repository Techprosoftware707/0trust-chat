import Foundation
import LumenCore
import Security

/// Generic-password Keychain items, `AfterFirstUnlockThisDeviceOnly` (the NSE
/// must read them while the device is locked; never synced or restored to
/// another device), in the shared keychain access group when available.
struct KeychainStore: Sendable {
    let service: String
    let accessGroup: String?

    enum KeychainError: Error, LocalizedError {
        case status(OSStatus)
        var errorDescription: String? {
            if case .status(let s) = self { return "Keychain error \(s)" }
            return nil
        }
    }

    private func baseQuery(account: String, group: String?) -> [String: Any] {
        var q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecUseDataProtectionKeychain as String: true,
        ]
        if let group { q[kSecAttrAccessGroup as String] = group }
        return q
    }

    /// Unsigned simulator builds have no keychain-access-groups entitlement;
    /// fall back to the app's default group there (the NSE then can't read it).
    private func withGroupFallback<T>(_ body: (String?) -> (OSStatus, T)) -> (OSStatus, T) {
        let first = body(accessGroup)
        if first.0 == errSecMissingEntitlement, accessGroup != nil {
            return body(nil)
        }
        return first
    }

    func data(account: String) throws -> Data? {
        let (status, data): (OSStatus, Data?) = withGroupFallback { group in
            var q = baseQuery(account: account, group: group)
            q[kSecReturnData as String] = true
            q[kSecMatchLimit as String] = kSecMatchLimitOne
            var out: CFTypeRef?
            let s = SecItemCopyMatching(q as CFDictionary, &out)
            return (s, out as? Data)
        }
        switch status {
        case errSecSuccess: return data
        case errSecItemNotFound: return nil
        default: throw KeychainError.status(status)
        }
    }

    func set(_ data: Data, account: String) throws {
        let (status, _): (OSStatus, Void) = withGroupFallback { group in
            let q = baseQuery(account: account, group: group)
            let attrs: [String: Any] = [
                kSecValueData as String: data,
                kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
            ]
            var s = SecItemUpdate(q as CFDictionary, attrs as CFDictionary)
            if s == errSecItemNotFound {
                var add = q
                add.merge(attrs) { _, new in new }
                add[kSecAttrSynchronizable as String] = false
                s = SecItemAdd(add as CFDictionary, nil)
            }
            return (s, ())
        }
        guard status == errSecSuccess else { throw KeychainError.status(status) }
    }

    func remove(account: String) throws {
        let (status, _): (OSStatus, Void) = withGroupFallback { group in
            (SecItemDelete(baseQuery(account: account, group: group) as CFDictionary), ())
        }
        guard status == errSecSuccess || status == errSecItemNotFound else { throw KeychainError.status(status) }
    }
}

/// The signed-in account, as one JSON item in the Keychain.
struct KeychainAccountStore: AccountStoring {
    private let keychain: KeychainStore
    private static let item = "account.v1"

    init(build: BuildConfiguration = AppEnvironment.build) {
        keychain = KeychainStore(service: "\(build.bundleIdentifier).session", accessGroup: build.keychainAccessGroup)
    }

    func load() -> StoredAccount? {
        guard let data = try? keychain.data(account: Self.item) else { return nil }
        return try? JSONDecoder().decode(StoredAccount.self, from: data)
    }

    func save(_ account: StoredAccount) throws {
        try keychain.set(try JSONEncoder().encode(account), account: Self.item)
    }

    func delete() throws {
        try keychain.remove(account: Self.item)
    }
}
