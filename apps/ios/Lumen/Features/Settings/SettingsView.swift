import LumenCore
import MatrixRustSDK
import SwiftUI
import UIKit

struct SettingsView: View {
    let session: SessionModel
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @Environment(\.lumen) private var c
    @State private var safariURL: IdentifiedURL?
    @State private var confirmSignOut = false
    @State private var showRecovery = false
    @State private var newRecoveryKey: String?
    @State private var lockError: String?
    @State private var displayName: String?

    var body: some View {
        @Bindable var app = app
        NavigationStack {
            Form {
                Section("Account") {
                    LabeledContent("Signed in as", value: session.userId)
                    if let displayName { LabeledContent("Name", value: displayName) }
                    LabeledContent("Server", value: session.serverName)
                    if let account = session.lumen?.accountURL {
                        Button { safariURL = IdentifiedURL(url: account) } label: {
                            Label("Manage account (password, MFA, sessions)", systemImage: "person.crop.circle")
                        }
                    }
                    NavigationLink { DevicesView(session: session) } label: { Label("Devices", systemImage: "laptopcomputer.and.iphone") }
                }

                Section {
                    LabeledContent("This device", value: session.encryption.verificationState == .verified ? "Verified" : (session.encryption.verificationState == .unverified ? "Not verified" : "Checking…"))
                    LabeledContent("Recovery", value: recoveryLabel)
                    LabeledContent("Key backup", value: session.encryption.backupLabel)
                    if session.encryption.verificationState != .verified || session.encryption.recoveryState != .enabled {
                        Button("Secure your messages…") { showRecovery = true }
                    }
                    if session.encryption.recoveryState == .enabled {
                        AsyncButton {
                            newRecoveryKey = try? await session.encryption.resetRecoveryKey()
                        } label: { Text("Change recovery key") }
                    }
                    NavigationLink { SecurityInfoView() } label: { Text("How your data is protected") }
                    NavigationLink { BlockedUsersView(session: session) } label: { Text("Blocked people (\(session.ignoredUsers.count))") }
                } header: {
                    Text("Security")
                }

                Section {
                    Toggle("Send read receipts", isOn: $app.preferences.sendReadReceipts)
                    Toggle("Send typing notices", isOn: $app.preferences.sendTypingNotices)
                } header: {
                    Text("Privacy")
                } footer: {
                    Text("With read receipts off, your read position is still synced between your own devices with private receipts.")
                }

                Section {
                    Picker("Notification previews", selection: $app.preferences.notificationPreview) {
                        ForEach(NotificationPreview.allCases, id: \.self) { Text($0.title).tag($0) }
                    }
                    Text(app.pushAvailability.explanation)
                        .font(.footnote)
                        .foregroundStyle(c.textMuted)
                    switch app.pushAvailability {
                    case .notDetermined:
                        AsyncButton { await app.requestNotificationPermission() } label: { Text("Allow notifications") }
                    case .permissionDenied:
                        Button("Open iOS Settings") {
                            if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                        }
                    default:
                        EmptyView()
                    }
                    if !app.storesShared {
                        Text("This build has no shared app group, so notifications can't be decrypted while the app is closed.")
                            .font(.footnote).foregroundStyle(c.warning)
                    }
                } header: {
                    Text("Notifications")
                } footer: {
                    Text("Previews are hidden by default: notifications say only that there's a new message.")
                }

                Section {
                    Toggle("Require \(Biometrics.label)", isOn: Binding(get: { app.preferences.appLockEnabled }, set: { on in
                        Task {
                            if !(await app.setAppLock(enabled: on)) {
                                lockError = Biometrics.kind == .unavailable ? "Set a device passcode in iOS Settings first." : "App lock wasn't changed."
                            }
                        }
                    }))
                    if app.preferences.appLockEnabled {
                        Picker("Lock", selection: $app.preferences.appLockTimeout) {
                            ForEach(AppLockTimeout.allCases) { Text($0.title).tag($0) }
                        }
                    }
                    if let lockError { Text(lockError).foregroundStyle(c.danger) }
                } header: {
                    Text("App lock")
                } footer: {
                    Text("App lock protects against someone picking up your unlocked device. It does not protect against a compromised operating system. The app's content is also hidden in the app switcher.")
                }

                Section {
                    NavigationLink { AboutView(session: session) } label: { Text("About") }
                    if let help = session.lumen?.helpURL { Button("Help") { safariURL = IdentifiedURL(url: help) } }
                    if let privacy = session.lumen?.privacyURL { Button("Privacy policy") { safariURL = IdentifiedURL(url: privacy) } }
                }

                if let deleteURL = session.lumen?.accountDeleteURL {
                    Section {
                        Button(role: .destructive) {
                            safariURL = IdentifiedURL(url: deleteURL)
                        } label: {
                            Text("Delete account…")
                        }
                        .accessibilityHint("Opens the account portal")
                    } footer: {
                        Text("Your account is deleted in the account portal after you sign in again there. Your encrypted message history can't be recovered afterwards.")
                    }
                }

                Section {
                    Button("Sign out", role: .destructive) { confirmSignOut = true }
                    if let e = app.signOutError {
                        Text(e).font(.footnote).foregroundStyle(c.danger)
                        AsyncButton { await app.signOut(force: true) } label: { Text("Sign out on this device only") }
                            .foregroundStyle(c.danger)
                    }
                } footer: {
                    Text("Signing out removes this device from your account and deletes its messages, keys and settings. Make sure recovery is set up or another device is signed in, or you'll lose your encrypted history.")
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .sheet(item: $safariURL) { SafariView(url: $0.url).ignoresSafeArea() }
            .sheet(isPresented: $showRecovery) { SecurityOnboardingView(session: session).lumenTheme() }
            .sheet(item: Binding(get: { newRecoveryKey.map { IdentifiedString(value: $0) } }, set: { newRecoveryKey = $0?.value })) { k in
                NavigationStack {
                    VStack(alignment: .leading, spacing: LumenDimens.space4) {
                        Text("Your new recovery key. The old one no longer works. Save this one now: it isn't shown again.")
                        Text(RecoveryKeyFormat.grouped(k.value))
                            .font(.system(.title3, design: .monospaced))
                            .textSelection(.enabled)
                        ShareLink(item: k.value) { Label("Save…", systemImage: "square.and.arrow.up") }
                        Spacer()
                    }
                    .padding()
                    .toolbar { ToolbarItem(placement: .confirmationAction) { Button("I've saved it") { newRecoveryKey = nil } } }
                }
                .interactiveDismissDisabled()
            }
            .confirmationDialog("Sign out?", isPresented: $confirmSignOut, titleVisibility: .visible) {
                Button("Sign out", role: .destructive) {
                    Task {
                        await app.signOut(force: false)
                        if app.signOutError == nil { dismiss() }
                    }
                }
            } message: {
                Text(session.encryption.recoveryState == .enabled ? "Your recovery key restores your history on other devices." : "Recovery isn't set up. Without another signed-in device you'll lose access to your encrypted history.")
            }
            .task { displayName = await session.displayName() }
        }
    }

    private var recoveryLabel: String {
        switch session.encryption.recoveryState {
        case .enabled: return "Set up"
        case .incomplete: return "Needs your recovery key"
        case .disabled: return "Not set up"
        case .unknown: return "Checking…"
        }
    }
}

struct IdentifiedString: Identifiable {
    let value: String
    var id: String { value }
}

/// `GET /devices`; removal with user-interactive auth through the SSO fallback page.
struct DevicesView: View {
    let session: SessionModel
    @Environment(\.lumen) private var c
    @State private var devices: [DeviceInfo] = []
    @State private var loading = true
    @State private var error: String?
    @State private var removing: DeviceInfo?
    @State private var web = WebAuthenticator()

    var body: some View {
        List {
            Section {
                ForEach(devices) { d in
                    VStack(alignment: .leading, spacing: 2) {
                        HStack {
                            Text(d.displayName ?? d.deviceId).font(.body.weight(.medium))
                            if d.deviceId == session.deviceId {
                                Text("This device").font(.caption.weight(.semibold)).foregroundStyle(c.accent)
                            }
                        }
                        Text(d.deviceId).font(.caption.monospaced()).foregroundStyle(c.textMuted)
                        if d.deviceId == session.deviceId {
                            Text(session.encryption.verificationState == .verified ? "Verified" : "Not verified")
                                .font(.caption).foregroundStyle(session.encryption.verificationState == .verified ? c.success : c.warning)
                        }
                        if let seen = d.lastSeen {
                            Text("Last active \(seen.formatted(date: .abbreviated, time: .shortened))").font(.caption).foregroundStyle(c.textSubtle)
                        }
                    }
                    .accessibilityElement(children: .combine)
                    .swipeActions {
                        if d.deviceId != session.deviceId {
                            Button("Remove", role: .destructive) { removing = d }
                        }
                    }
                }
            } footer: {
                Text("Swipe a device to remove it; you'll confirm with your account's sign-in page. This app shows the verification status of this device only; other devices' status is shown on those devices and in the web app.")
            }
            if let error { Text(error).foregroundStyle(c.danger) }
        }
        .overlay { if loading { ProgressView() } }
        .navigationTitle("Devices")
        .refreshable { await load() }
        .task { await load() }
        .confirmationDialog("Remove \(removing?.displayName ?? removing?.deviceId ?? "")?", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }), titleVisibility: .visible) {
            Button("Remove", role: .destructive) {
                guard let d = removing else { return }
                Task { await remove(d) }
            }
        } message: {
            Text("The device is signed out and can no longer read new messages.")
        }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            devices = try await session.devicesAPI().list()
            error = nil
        } catch {
            self.error = "The device list couldn't be loaded."
        }
    }

    private func remove(_ d: DeviceInfo) async {
        let api = session.devicesAPI()
        do {
            try await api.delete(deviceId: d.deviceId, uiaSession: nil)
        } catch DevicesError.authRequired(let uia, let url) {
            // The fallback page has no app callback: the user closes the sheet when done.
            await web.openUntilDismissed(url: url, callbackScheme: AppEnvironment.build.urlScheme)
            do {
                try await api.delete(deviceId: d.deviceId, uiaSession: uia)
            } catch {
                self.error = "The device wasn't removed: the confirmation wasn't completed."
            }
        } catch let e as DevicesError {
            self.error = e.userMessage
        } catch {
            self.error = "The device couldn't be removed."
        }
        await load()
    }
}

struct BlockedUsersView: View {
    let session: SessionModel
    @State private var error: String?

    var body: some View {
        List {
            if session.ignoredUsers.isEmpty {
                Text("You haven't blocked anyone.").foregroundStyle(.secondary)
            }
            ForEach(session.ignoredUsers, id: \.self) { id in
                HStack {
                    Text(id)
                    Spacer()
                    AsyncButton {
                        do { try await session.unignore(userId: id) } catch { self.error = "Unblocking didn't work." }
                    } label: { Text("Unblock") }
                }
            }
            if let error { Text(error).foregroundStyle(.red) }
        }
        .navigationTitle("Blocked people")
    }
}

struct AboutView: View {
    let session: SessionModel
    @Environment(\.lumen) private var c
    @State private var transports: [String] = []

    var body: some View {
        List {
            Section("App") {
                LabeledContent("Version", value: AppEnvironment.appVersion)
                LabeledContent("Matrix Rust SDK", value: "26.10.02 (\(String(sdkGitSha().prefix(10))))")
                LabeledContent("Bundle ID", value: AppEnvironment.build.bundleIdentifier)
            }
            Section("Calls") {
                LabeledContent("Call widget", value: widgetSourceLabel)
                ForEach(transports, id: \.self) { Text($0).font(.caption) }
            }
            Section {
                ForEach(Diagnostics.entries.reversed(), id: \.self) { line in
                    Text(line).font(.caption.monospaced()).textSelection(.enabled)
                }
                if Diagnostics.entries.isEmpty { Text("No events.").foregroundStyle(c.textMuted) }
            } header: {
                Text("Diagnostics")
            } footer: {
                Text("Stored only on this device, without tokens, keys, message text, user IDs or room names. Nothing is sent anywhere.")
            }
            Section("Licences") {
                Text("Matrix Rust SDK (Apache-2.0), Lumen call widget with matrix-js-sdk and livekit-client (Apache-2.0), Lucide icons (ISC). Lumen Secure is free software; see the source repository for its licence.")
                    .font(.footnote)
            }
        }
        .navigationTitle("About")
        .task { transports = await session.callTransports() }
    }

    private var widgetSourceLabel: String {
        let insecure = UserDefaults.standard.string(forKey: "lumen.widget.bundledInsecure") == AppEnvironment.appVersion
        if WidgetSchemeHandler.hasBundledWidget && !insecure { return WidgetSource.bundled.label }
        if let url = session.lumen?.callWidgetURL {
            return WidgetSource.server(url).label + (insecure ? " (the bundled copy isn't a secure context in WebKit)" : " (no bundled copy in this build)")
        }
        return "Not available"
    }
}
