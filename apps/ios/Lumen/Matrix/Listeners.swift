import Foundation
import MatrixRustSDK

// Adapters from the SDK's callback interfaces (called on Rust threads) to
// AsyncStreams consumed by one task on the main actor, so updates are applied
// in the order the SDK produced them.

func makeStream<T>(_ type: T.Type = T.self) -> (AsyncStream<T>, AsyncStream<T>.Continuation) {
    var c: AsyncStream<T>.Continuation!
    let s = AsyncStream<T>(bufferingPolicy: .unbounded) { c = $0 }
    return (s, c)
}

final class SyncStateListener: SyncServiceStateObserver {
    let continuation: AsyncStream<SyncServiceState>.Continuation
    init(_ c: AsyncStream<SyncServiceState>.Continuation) { continuation = c }
    func onUpdate(state: SyncServiceState) { continuation.yield(state) }
}

final class SyncIndicatorListener: RoomListServiceSyncIndicatorListener {
    let continuation: AsyncStream<RoomListServiceSyncIndicator>.Continuation
    init(_ c: AsyncStream<RoomListServiceSyncIndicator>.Continuation) { continuation = c }
    func onUpdate(syncIndicator: RoomListServiceSyncIndicator) { continuation.yield(syncIndicator) }
}

final class RoomEntriesListener: RoomListEntriesListener {
    let continuation: AsyncStream<[RoomListEntriesUpdate]>.Continuation
    init(_ c: AsyncStream<[RoomListEntriesUpdate]>.Continuation) { continuation = c }
    func onUpdate(roomEntriesUpdate: [RoomListEntriesUpdate]) { continuation.yield(roomEntriesUpdate) }
}

final class TimelineDiffListener: TimelineListener {
    let continuation: AsyncStream<[TimelineDiff]>.Continuation
    init(_ c: AsyncStream<[TimelineDiff]>.Continuation) { continuation = c }
    func onUpdate(diff: [TimelineDiff]) { continuation.yield(diff) }
}

final class BackPaginationListener: PaginationStatusListener {
    let continuation: AsyncStream<PaginationStatus>.Continuation
    init(_ c: AsyncStream<PaginationStatus>.Continuation) { continuation = c }
    func onUpdate(status: PaginationStatus) { continuation.yield(status) }
}

final class TypingListener: TypingNotificationsListener {
    let continuation: AsyncStream<[String]>.Continuation
    init(_ c: AsyncStream<[String]>.Continuation) { continuation = c }
    func call(typingUserIds: [String]) { continuation.yield(typingUserIds) }
}

final class IdentityChangeListener: IdentityStatusChangeListener {
    let continuation: AsyncStream<[IdentityStatusChange]>.Continuation
    init(_ c: AsyncStream<[IdentityStatusChange]>.Continuation) { continuation = c }
    func call(identityStatusChange: [IdentityStatusChange]) { continuation.yield(identityStatusChange) }
}

final class RecoveryListener: RecoveryStateListener {
    let continuation: AsyncStream<RecoveryState>.Continuation
    init(_ c: AsyncStream<RecoveryState>.Continuation) { continuation = c }
    func onUpdate(status: RecoveryState) { continuation.yield(status) }
}

final class BackupListener: BackupStateListener {
    let continuation: AsyncStream<BackupState>.Continuation
    init(_ c: AsyncStream<BackupState>.Continuation) { continuation = c }
    func onUpdate(status: BackupState) { continuation.yield(status) }
}

final class VerificationListener: VerificationStateListener {
    let continuation: AsyncStream<VerificationState>.Continuation
    init(_ c: AsyncStream<VerificationState>.Continuation) { continuation = c }
    func onUpdate(status: VerificationState) { continuation.yield(status) }
}

final class EnableRecoveryListener: EnableRecoveryProgressListener {
    let continuation: AsyncStream<EnableRecoveryProgress>.Continuation
    init(_ c: AsyncStream<EnableRecoveryProgress>.Continuation) { continuation = c }
    func onUpdate(status: EnableRecoveryProgress) { continuation.yield(status) }
}

final class IgnoredListener: IgnoredUsersListener {
    let continuation: AsyncStream<[String]>.Continuation
    init(_ c: AsyncStream<[String]>.Continuation) { continuation = c }
    func call(ignoredUserIds: [String]) { continuation.yield(ignoredUserIds) }
}

final class ClientEventsListener: ClientDelegate {
    let continuation: AsyncStream<Bool>.Continuation
    init(_ c: AsyncStream<Bool>.Continuation) { continuation = c }
    /// `isSoftLogout`
    func didReceiveAuthError(isSoftLogout: Bool) { continuation.yield(isSoftLogout) }
    func onBackgroundTaskErrorReport(taskName: String, error: BackgroundTaskFailureReason) {}
}

struct SyncNotification: @unchecked Sendable {
    let item: NotificationItem
    let roomId: String
}

final class SyncNotificationsListener: SyncNotificationListener {
    let continuation: AsyncStream<SyncNotification>.Continuation
    init(_ c: AsyncStream<SyncNotification>.Continuation) { continuation = c }
    func onNotification(notification: NotificationItem, roomId: String) {
        continuation.yield(SyncNotification(item: notification, roomId: roomId))
    }
}

final class CallDeclinedListener: CallDeclineListener {
    let continuation: AsyncStream<String>.Continuation
    init(_ c: AsyncStream<String>.Continuation) { continuation = c }
    func call(declinerUserId: String) { continuation.yield(declinerUserId) }
}

/// Grants the call widget exactly the MatrixRTC capability set the SDK
/// defines for Element-Call-compatible widgets (integration.md §6.2).
final class CallCapabilitiesProvider: WidgetCapabilitiesProvider {
    let ownUserId: String
    let ownDeviceId: String
    init(ownUserId: String, ownDeviceId: String) {
        self.ownUserId = ownUserId
        self.ownDeviceId = ownDeviceId
    }
    func acquireCapabilities(capabilities: WidgetCapabilities) async -> WidgetCapabilities {
        getElementCallRequiredPermissions(ownUserId: ownUserId, ownDeviceId: ownDeviceId)
    }
}
