import BackgroundTasks
import SwiftUI
import UIKit
import UserNotifications

@main
struct LumenApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var model = AppModel.shared
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .lumenTheme()
                .onOpenURL { model.handle(url: $0) }
                .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { activity in
                    if let url = activity.webpageURL { model.handle(url: url) }
                }
                .task { await model.launch() }
        }
        .onChange(of: scenePhase) { _, phase in
            model.scenePhaseChanged(phase)
        }
    }
}

final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = NotificationCoordinator.shared
        // PushKit must be set up during launch: a VoIP push handed over by the
        // notification service extension launches the app in the background.
        CallKitController.shared.registerVoIP()
        BGTaskScheduler.shared.register(forTaskWithIdentifier: AppModel.refreshTaskId, using: nil) { task in
            guard let refresh = task as? BGAppRefreshTask else { task.setTaskCompleted(success: false); return }
            Task { @MainActor in AppModel.shared.runBackgroundRefresh(refresh) }
        }
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Task { @MainActor in AppModel.shared.didRegister(deviceToken: deviceToken) }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        Task { @MainActor in AppModel.shared.didFailToRegister(error: error) }
    }
}
