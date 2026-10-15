import Foundation

/// How long the app may stay in the background before it asks for Face ID,
/// Touch ID or the device passcode again.
public enum AppLockTimeout: Int, CaseIterable, Codable, Sendable, Identifiable {
    case immediately = 0
    case oneMinute = 60
    case fiveMinutes = 300
    case fifteenMinutes = 900
    case oneHour = 3600

    public var id: Int { rawValue }
    public var seconds: TimeInterval { TimeInterval(rawValue) }

    public var title: String {
        switch self {
        case .immediately: return "Immediately"
        case .oneMinute: return "After 1 minute"
        case .fiveMinutes: return "After 5 minutes"
        case .fifteenMinutes: return "After 15 minutes"
        case .oneHour: return "After 1 hour"
        }
    }
}

/// App-lock state machine. Times come from a monotonic clock (seconds since
/// boot) supplied by the caller, so changing the wall clock can't skip the lock.
///
/// App lock protects against someone picking up an unlocked device. It does
/// not protect against a compromised operating system.
public struct AppLockState: Equatable, Sendable {
    public var enabled: Bool
    public var timeout: AppLockTimeout
    public private(set) var isLocked: Bool
    public private(set) var backgroundedAt: TimeInterval?

    /// A cold start with app lock enabled starts locked.
    public init(enabled: Bool, timeout: AppLockTimeout) {
        self.enabled = enabled
        self.timeout = timeout
        self.isLocked = enabled
        self.backgroundedAt = nil
    }

    public mutating func didEnterBackground(at now: TimeInterval) {
        guard enabled else { return }
        if backgroundedAt == nil { backgroundedAt = now }
        if timeout == .immediately { isLocked = true }
    }

    /// Returns true when the user must authenticate before seeing content.
    @discardableResult
    public mutating func willEnterForeground(at now: TimeInterval) -> Bool {
        defer { backgroundedAt = nil }
        guard enabled else { isLocked = false; return false }
        if isLocked { return true }
        guard let since = backgroundedAt else { return false }
        // A clock that went backwards (reboot) counts as expired.
        if now < since || now - since >= timeout.seconds { isLocked = true }
        return isLocked
    }

    public mutating func didAuthenticate() {
        isLocked = false
        backgroundedAt = nil
    }

    public mutating func lockNow() {
        if enabled { isLocked = true }
    }

    public mutating func setEnabled(_ on: Bool) {
        enabled = on
        if !on { isLocked = false; backgroundedAt = nil }
    }
}

/// The privacy cover shown in the app switcher snapshot.
public enum PrivacyCover {
    /// Cover the content whenever the scene isn't active (app switcher, Control
    /// Centre, incoming system alerts), and always while locked.
    public static func shouldCover(sceneIsActive: Bool, isLocked: Bool) -> Bool {
        isLocked || !sceneIsActive
    }
}
