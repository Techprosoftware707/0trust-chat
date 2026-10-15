import Foundation

/// One `org.matrix.msc4075.rtc.notification` timeline item, as the Rust SDK's
/// timeline aggregates it (`TimelineItemContent.rtcNotification`).
public struct RtcNotificationRecord: Equatable, Sendable {
    public var eventId: String?
    public var sender: String
    public var timestamp: Date
    /// "audio" / "video" (`m.call.intent`), if known.
    public var callIntent: String?
    public var declinedBy: [String]
    /// Members currently in the call, if it is still running.
    public var activeMembers: [String]
    public var callStart: Date?
    /// Whether this device's user is in the call right now.
    public var isJoined: Bool

    public init(eventId: String?, sender: String, timestamp: Date, callIntent: String?, declinedBy: [String], activeMembers: [String], callStart: Date?, isJoined: Bool) {
        self.eventId = eventId
        self.sender = sender
        self.timestamp = timestamp
        self.callIntent = callIntent
        self.declinedBy = declinedBy
        self.activeMembers = activeMembers
        self.callStart = callStart
        self.isJoined = isJoined
    }
}

public enum CallOutcome: String, Equatable, Sendable {
    case ongoing, outgoing, declined, declinedByOthers, missed

    public var title: String {
        switch self {
        case .ongoing: return "Ongoing call"
        case .outgoing: return "Outgoing call"
        case .declined: return "Declined"
        case .declinedByOthers: return "Declined by the other side"
        case .missed: return "Missed call"
        }
    }
}

public struct CallHistoryEntry: Equatable, Sendable, Identifiable {
    public var id: String
    public var timestamp: Date
    public var caller: String
    public var video: Bool
    public var outcome: CallOutcome
}

public enum CallHistoryBuilder {
    /// Derives the call list from the loaded timeline (newest first). Only what
    /// this device has loaded is considered; the UI says so.
    ///
    /// The timeline item does not say whether someone else answered after the
    /// call ended, so a finished incoming call that this user did not decline
    /// is listed as "missed" only if they were rung; group "notification"
    /// calls the user didn't join are listed as missed too.
    public static func build(_ records: [RtcNotificationRecord], ownUserId: String) -> [CallHistoryEntry] {
        records.enumerated().map { index, r in
            let outcome: CallOutcome
            if !r.activeMembers.isEmpty {
                outcome = .ongoing
            } else if r.sender == ownUserId {
                outcome = r.declinedBy.contains(where: { $0 != ownUserId }) ? .declinedByOthers : .outgoing
            } else if r.declinedBy.contains(ownUserId) {
                outcome = .declined
            } else {
                outcome = .missed
            }
            return CallHistoryEntry(
                id: r.eventId ?? "local-\(index)",
                timestamp: r.callStart ?? r.timestamp,
                caller: r.sender,
                video: r.callIntent == "video",
                outcome: outcome
            )
        }.sorted { $0.timestamp > $1.timestamp }
    }
}

/// Whether an incoming ring is still worth showing.
public enum IncomingRingPolicy {
    /// Rings older than this are ignored even without an explicit expiry (web: RING_LIFETIME_MS).
    public static let maxRingAge: TimeInterval = 45

    public static func shouldRing(sender: String, ownUserId: String, isRing: Bool, sentAt: Date, expiresAt: Date?, now: Date) -> Bool {
        guard isRing, sender != ownUserId else { return false }
        if let e = expiresAt, now >= e { return false }
        if now.timeIntervalSince(sentAt) > maxRingAge { return false }
        return true
    }
}
