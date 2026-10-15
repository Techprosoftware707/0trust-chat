import Foundation

// MARK: - Delivery state

/// The SDK's send state of an own event, without the SDK types
/// (the app maps `EventSendState` onto this).
public enum SendStateInput: Equatable, Sendable {
    /// Local echo: queued or uploading, not acknowledged by the server.
    case notSentYet
    case sendingFailed(isRecoverable: Bool)
    /// The server returned an event ID.
    case sent(eventId: String)
}

/// What the message bubble shows (integration.md §5): "Sent" means the server
/// returned an event ID; "Read" means a receipt from someone else. A local
/// echo is "Sending", never delivered.
public enum DeliveryState: Equatable, Sendable {
    case sending
    case failed(isRecoverable: Bool)
    case sent
    case read

    public var label: String {
        switch self {
        case .sending: return "Sending"
        case .failed: return "Not sent"
        case .sent: return "Sent"
        case .read: return "Read"
        }
    }

    public var accessibilityLabel: String {
        switch self {
        case .sending: return "Sending, not yet on the server"
        case .failed(let r): return r ? "Not sent. Tap to retry." : "Not sent. Tap to retry or delete."
        case .sent: return "Sent to the server"
        case .read: return "Read"
        }
    }
}

public enum DeliveryStateMapper {
    /// - Parameters:
    ///   - isOwn: the event was sent by this account.
    ///   - isRemote: the event came from the server (sync or pagination).
    ///   - sendState: the SDK's local send state, nil for remote events.
    ///   - receiptUserIds: users with a read receipt on this event.
    /// - Returns: nil for other people's messages.
    public static func map(isOwn: Bool, isRemote: Bool, sendState: SendStateInput?, receiptUserIds: [String], ownUserId: String) -> DeliveryState? {
        guard isOwn else { return nil }
        let acknowledged: Bool
        switch sendState {
        case .notSentYet:
            return .sending
        case .sendingFailed(let r):
            return .failed(isRecoverable: r)
        case .sent:
            acknowledged = true
        case nil:
            // Without a send state only an event that came from the server counts as sent.
            acknowledged = isRemote
        }
        guard acknowledged else { return .sending }
        return receiptUserIds.contains(where: { $0 != ownUserId }) ? .read : .sent
    }
}

// MARK: - Ordered list diffs (timeline and room list)

/// The diff shape shared by the SDK's `TimelineDiff` and `RoomListEntriesUpdate`.
public enum ListDiff<Element> {
    case append([Element])
    case clear
    case pushFront(Element)
    case pushBack(Element)
    case popFront
    case popBack
    case insert(Int, Element)
    case set(Int, Element)
    case remove(Int)
    case truncate(Int)
    case reset([Element])
}

extension ListDiff: Sendable where Element: Sendable {}

public enum ListDiffError: Error, Equatable, Sendable {
    case indexOutOfRange(operation: String, index: Int, count: Int)
}

public enum ListDiffApplier {
    /// Applies the diffs in order. An out-of-range index throws: the caller then
    /// asks the SDK for a full reset instead of showing a corrupted list.
    public static func apply<E>(_ diffs: [ListDiff<E>], to list: inout [E]) throws {
        for d in diffs {
            switch d {
            case .append(let v): list.append(contentsOf: v)
            case .clear: list.removeAll()
            case .pushFront(let v): list.insert(v, at: 0)
            case .pushBack(let v): list.append(v)
            case .popFront:
                guard !list.isEmpty else { throw ListDiffError.indexOutOfRange(operation: "popFront", index: 0, count: 0) }
                list.removeFirst()
            case .popBack:
                guard !list.isEmpty else { throw ListDiffError.indexOutOfRange(operation: "popBack", index: 0, count: 0) }
                list.removeLast()
            case .insert(let i, let v):
                guard i >= 0, i <= list.count else { throw ListDiffError.indexOutOfRange(operation: "insert", index: i, count: list.count) }
                list.insert(v, at: i)
            case .set(let i, let v):
                guard i >= 0, i < list.count else { throw ListDiffError.indexOutOfRange(operation: "set", index: i, count: list.count) }
                list[i] = v
            case .remove(let i):
                guard i >= 0, i < list.count else { throw ListDiffError.indexOutOfRange(operation: "remove", index: i, count: list.count) }
                list.remove(at: i)
            case .truncate(let n):
                guard n >= 0 else { throw ListDiffError.indexOutOfRange(operation: "truncate", index: n, count: list.count) }
                if n < list.count { list.removeSubrange(n..<list.count) }
            case .reset(let v): list = v
            }
        }
    }
}

// MARK: - Connection banner

/// The SDK's `SyncServiceState`, without the SDK type.
public enum SyncStatus: Equatable, Sendable {
    case idle, running, terminated, error, offline
}

public enum ConnectionBanner: Equatable, Sendable {
    case offline
    case reconnecting
    case error
    case connectedAgain

    public var message: String {
        switch self {
        case .offline: return "You're offline. New messages can't be sent until you reconnect."
        case .reconnecting: return "Reconnecting to the server…"
        case .error: return "Connection problem: the server can't be reached."
        case .connectedAgain: return "Connected again."
        }
    }

    /// Which banner to show, from the real sync state. `syncIndicatorVisible` is
    /// the room list service's own "something is slow" indicator.
    public static func from(sync: SyncStatus, networkReachable: Bool, syncIndicatorVisible: Bool, wasDisconnected: Bool) -> ConnectionBanner? {
        if !networkReachable || sync == .offline { return .offline }
        switch sync {
        case .error: return .error
        case .terminated: return .reconnecting
        case .idle: return wasDisconnected ? .reconnecting : nil
        case .running: return syncIndicatorVisible ? .reconnecting : (wasDisconnected ? .connectedAgain : nil)
        case .offline: return .offline
        }
    }
}

// MARK: - Identity changes

/// The crypto crate's `IdentityState`, without the SDK type.
public enum IdentityStatus: Equatable, Sendable {
    case verified, pinned, pinViolation, verificationViolation
}

public struct IdentityWarning: Equatable, Sendable, Identifiable {
    public enum Kind: Equatable, Sendable {
        /// Identity changed since first seen: acknowledge (pin the new identity).
        case changed
        /// A previously verified identity changed: verify again or withdraw verification.
        case verifiedChanged
    }

    public var userId: String
    public var kind: Kind
    public var id: String { userId }

    public init(userId: String, kind: Kind) {
        self.userId = userId
        self.kind = kind
    }

    public func message(displayName: String) -> String {
        switch kind {
        case .changed:
            return "\(displayName)'s identity appears to have changed. This happens when they reset their encryption, or if someone is impersonating them."
        case .verifiedChanged:
            return "\(displayName)'s verified identity has changed. Until you verify them again, you can't be sure messages are really from them."
        }
    }

    public var actionTitle: String {
        switch kind {
        case .changed: return "OK"
        case .verifiedChanged: return "Withdraw verification"
        }
    }
}

/// Keeps the latest identity status per user in a room and derives the banners.
public struct IdentityWarningTracker: Equatable, Sendable {
    public private(set) var statuses: [String: IdentityStatus] = [:]
    public init() {}

    public mutating func apply(_ changes: [(userId: String, status: IdentityStatus)]) {
        for c in changes { statuses[c.userId] = c.status }
    }

    /// Warnings sorted by severity, then user ID; own user excluded.
    public func warnings(ownUserId: String) -> [IdentityWarning] {
        statuses.compactMap { userId, status -> IdentityWarning? in
            guard userId != ownUserId else { return nil }
            switch status {
            case .pinViolation: return IdentityWarning(userId: userId, kind: .changed)
            case .verificationViolation: return IdentityWarning(userId: userId, kind: .verifiedChanged)
            case .verified, .pinned: return nil
            }
        }.sorted { a, b in
            if a.kind != b.kind { return a.kind == .verifiedChanged }
            return a.userId < b.userId
        }
    }
}

// MARK: - Recovery key

public enum RecoveryKeyFormat {
    /// Whitespace-insensitive, like the web client's `normaliseRecoveryKey`.
    public static func normalise(_ s: String) -> String {
        String(s.unicodeScalars.filter { !CharacterSet.whitespacesAndNewlines.contains($0) }.map(Character.init))
    }

    public static func matches(typed: String, shown: String) -> Bool {
        let a = normalise(typed), b = normalise(shown)
        return !a.isEmpty && a == b
    }

    /// Groups of four for display ("EsTx abcd …").
    public static func grouped(_ key: String) -> String {
        let n = normalise(key)
        var out: [String] = []
        var i = n.startIndex
        while i < n.endIndex {
            let j = n.index(i, offsetBy: 4, limitedBy: n.endIndex) ?? n.endIndex
            out.append(String(n[i..<j]))
            i = j
        }
        return out.joined(separator: " ")
    }
}
