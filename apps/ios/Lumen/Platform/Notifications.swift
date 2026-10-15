import Foundation
import LumenCore
import UIKit
import UserNotifications

/// Local notifications (foreground and background refresh) and the
/// notification-centre delegate. Remote notifications are rendered by the
/// LumenNSE extension with the same policy.
@MainActor
final class NotificationCoordinator: NSObject, UNUserNotificationCenterDelegate {
    static let shared = NotificationCoordinator()

    /// Called when the user taps a notification for a room.
    var onOpenRoom: ((String) -> Void)?

    func permission() async -> PushPermission {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        switch settings.authorizationStatus {
        case .authorized, .provisional, .ephemeral: return .granted
        case .denied: return .denied
        case .notDetermined: return .notDetermined
        @unknown default: return .notDetermined
        }
    }

    func requestPermission() async -> Bool {
        (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])) ?? false
    }

    func registerForRemoteNotifications() {
        UIApplication.shared.registerForRemoteNotifications()
    }

    /// Shows a local notification with the user's preview policy.
    func post(_ n: MappedNotification, roomId: String, eventId: String?, preview: NotificationPreview, appName: String) {
        let r = NotificationRenderer.render(kind: n.kind, senderName: n.senderName, roomName: n.roomName, isDirect: n.isDirect, preview: preview, appName: appName)
        let content = UNMutableNotificationContent()
        content.title = r.title
        content.subtitle = r.subtitle
        content.body = r.body
        content.sound = .default
        content.threadIdentifier = roomId
        content.userInfo = ["room_id": roomId]
        let id = eventId ?? UUID().uuidString
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: id, content: content, trigger: nil))
    }

    func clearDelivered(roomId: String) {
        let center = UNUserNotificationCenter.current()
        center.getDeliveredNotifications { list in
            let ids = list.filter { ($0.request.content.userInfo["room_id"] as? String) == roomId }.map(\.request.identifier)
            center.removeDeliveredNotifications(withIdentifiers: ids)
        }
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound]
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        guard let roomId = response.notification.request.content.userInfo["room_id"] as? String, MatrixID.isValidRoomId(roomId) else { return }
        await MainActor.run { self.onOpenRoom?(roomId) }
    }
}
