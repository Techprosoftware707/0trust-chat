import CallKit
import Foundation
import LumenCore
import MatrixRustSDK
import UserNotifications

/// Decrypts `event_id_only` pushes (integration.md §7): the APNs payload has
/// only room ID, event ID and unread count. The extension opens the app
/// group's Rust SDK store with the shared Keychain session, fetches and
/// decrypts the event with `NotificationClient`, and shows it with the
/// user's preview policy (hidden by default). A MatrixRTC ring is handed to
/// the app with `CXProvider.reportNewIncomingVoIPPushPayload` so CallKit rings.
final class NotificationService: UNNotificationServiceExtension {
    private var contentHandler: ((UNNotificationContent) -> Void)?
    private var bestAttempt: UNMutableNotificationContent?
    private var task: Task<Void, Never>?

    override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        self.contentHandler = contentHandler
        let content = (request.content.mutableCopy() as? UNMutableNotificationContent) ?? UNMutableNotificationContent()
        let preview = SharedPreferences.current().load().notificationPreview
        let appName = Bundle.main.object(forInfoDictionaryKey: "LumenAppDisplayName") as? String ?? "Lumen"
        // Until decryption succeeds: the generic, content-free text.
        let generic = NotificationRenderer.render(kind: .message(body: ""), senderName: nil, roomName: nil, isDirect: true, preview: .hidden, appName: appName)
        content.title = generic.title
        content.body = generic.body
        bestAttempt = content

        guard let payload = PushPayload.parse(request.content.userInfo) else {
            deliver()
            return
        }
        if let n = payload.unreadCount { content.badge = NSNumber(value: n) }
        content.threadIdentifier = payload.roomId
        content.userInfo["room_id"] = payload.roomId

        task = Task { [weak self] in
            await self?.process(payload, content: content, preview: preview, appName: appName)
            self?.deliver()
        }
    }

    override func serviceExtensionTimeWillExpire() {
        task?.cancel()
        deliver()
    }

    private func deliver() {
        guard let handler = contentHandler, let content = bestAttempt else { return }
        contentHandler = nil
        handler(content)
    }

    private func process(_ payload: PushPayload, content: UNMutableNotificationContent, preview: NotificationPreview, appName: String) async {
        let store = KeychainAccountStore()
        guard let account = store.load() else { return }
        let paths = StorePaths.current()
        guard paths.isShared else { return }
        do {
            let client = try await ClientFactory(paths: paths).restoredClient(account: account, store: store, role: .notificationExtension)
            let nc = try await client.notificationClient(processSetup: .multipleProcesses)
            let status = try await nc.getNotification(roomId: payload.roomId, eventId: payload.eventId)
            guard case .event(let item) = status else { return }
            let mapped = NotificationMapper.map(item, roomId: payload.roomId, eventId: payload.eventId)
            if let ring = mapped.ring,
               IncomingRingPolicy.shouldRing(sender: ring.sender, ownUserId: account.userId, isRing: true, sentAt: ring.sentAt, expiresAt: ring.expiresAt, now: Date()) {
                await reportRing(ring)
            }
            let r = NotificationRenderer.render(kind: mapped.kind, senderName: mapped.senderName, roomName: mapped.roomName, isDirect: mapped.isDirect, preview: preview, appName: appName)
            content.title = r.title
            content.subtitle = r.subtitle
            content.body = r.body
            if !mapped.isNoisy { content.sound = nil } else { content.sound = .default }
        } catch {
            // Keep the generic text; nothing about the error is shown.
        }
    }

    /// Wakes the app through PushKit; the app reports the call to CallKit.
    /// Without the notification-filtering entitlement the regular
    /// notification ("Incoming call") is still shown as well.
    private func reportRing(_ ring: IncomingRing) async {
        await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
            CXProvider.reportNewIncomingVoIPPushPayload(ring.voipPayload) { _ in cont.resume() }
        }
    }
}
