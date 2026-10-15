import Foundation
import LocalAuthentication
import LumenCore
import Network
import UIKit

/// Face ID / Touch ID with the device passcode as fallback.
enum Biometrics {
    enum Kind { case faceID, touchID, opticID, passcodeOnly, unavailable }

    static var kind: Kind {
        let ctx = LAContext()
        var error: NSError?
        guard ctx.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else { return .unavailable }
        _ = ctx.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil)
        switch ctx.biometryType {
        case .faceID: return .faceID
        case .touchID: return .touchID
        case .opticID: return .opticID
        default: return .passcodeOnly
        }
    }

    static var label: String {
        switch kind {
        case .faceID: return "Face ID"
        case .touchID: return "Touch ID"
        case .opticID: return "Optic ID"
        case .passcodeOnly: return "Device passcode"
        case .unavailable: return "Unavailable (no passcode set)"
        }
    }

    static func authenticate(reason: String) async -> Bool {
        let ctx = LAContext()
        ctx.localizedCancelTitle = "Cancel"
        do {
            return try await ctx.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason)
        } catch {
            return false
        }
    }
}

/// Seconds since boot, unaffected by wall-clock changes (declared in the
/// privacy manifest under "system boot time", reason 35F9.1).
enum MonotonicClock {
    static var now: TimeInterval { ProcessInfo.processInfo.systemUptime }
}

/// Network reachability for the offline banner.
@MainActor
final class NetworkMonitor {
    private let monitor = NWPathMonitor()
    var onChange: ((Bool) -> Void)?

    func start() {
        monitor.pathUpdateHandler = { [weak self] path in
            let ok = path.status == .satisfied
            Task { @MainActor in self?.onChange?(ok) }
        }
        monitor.start(queue: DispatchQueue(label: "io.lumen.network"))
    }

    func stop() { monitor.cancel() }
}

/// A short, redacted diagnostics log for Settings → About (no tokens, keys,
/// message bodies or room names; see integration.md §9).
enum Diagnostics {
    private static let key = "lumen.diagnostics.v1"
    private static let maxEntries = 50

    static func log(_ message: String) {
        let line = "\(ISO8601DateFormatter().string(from: Date())) \(LogRedactor.redact(message))"
        var entries = UserDefaults.standard.stringArray(forKey: key) ?? []
        entries.append(line)
        if entries.count > maxEntries { entries.removeFirst(entries.count - maxEntries) }
        UserDefaults.standard.set(entries, forKey: key)
    }

    static var entries: [String] { UserDefaults.standard.stringArray(forKey: key) ?? [] }

    static func clear() { UserDefaults.standard.removeObject(forKey: key) }
}

enum DeviceInfoProvider {
    @MainActor static var model: String { UIDevice.current.model }
}
