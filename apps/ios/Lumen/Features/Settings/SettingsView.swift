import LumenCore
import MatrixRustSDK
import SwiftUI
import UIKit

/// A Settings-style row label: a white glyph on a small tinted square.
struct SettingsLabel: View {
    let title: String
    let systemImage: String
    let tint: Color
    @ScaledMetric(relativeTo: .body) private var side: CGFloat = 28

    var body: some View {
        Label {
            Text(title)
        } icon: {
            Image(systemName: systemImage)
                .font(.system(size: side * 0.5, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: side, height: side)
                .background(tint, in: RoundedRectangle(cornerRadius: side * 0.26, style: .continuous))
                .accessibilityHidden(true)
        }
    }
}

/// A status value: a coloured symbol and text ("Verified", "Not set up").
struct StatusValue: View {
    let text: String
    let systemImage: String
    let tint: Color

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: systemImage).imageScale(.small)
            Text(text)
        }
        .foregroundStyle(tint)
    }
}

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
                Section {
                    HStack(spacing: LumenDimens.space4) {
                        AvatarView(name: displayName ?? session.userId, size: 60, ring: true)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(displayName ?? MatrixIDText.localpart(session.userId))
                                .font(.title3.weight(.semibold))
                                .foregroundStyle(c.text)
                                .lineLimit(2)
                            Text(session.userId)
                                .font(.subheadline)
                                .foregroundStyle(c.textMuted)
                                .lineLimit(2)
                                .textSelection(.enabled)
                        }
                    }
                    .padding(.vertical, LumenDimens.space1)
                    .accessibilityElement(children: .combine)
                    if let account = session.lumen?.accountURL {
                        Button { safariURL = IdentifiedURL(url: account) } label: {
                            SettingsLabel(title: "Manage account", systemImage: "person.crop.circle", tint: LumenPalette.cyan600)
                        }
                        .accessibilityHint("Password, two-factor sign-in and sessions, in the account portal")
                    }
                    NavigationLink { DevicesView(session: session) } label: {
                        SettingsLabel(title: "Devices", systemImage: "laptopcomputer.and.iphone", tint: LumenPalette.midnight600)
                    }
                }

                Section {
                    LabeledContent {
                        deviceStatus
                    } label: {
                        SettingsLabel(title: "This device", systemImage: "iphone", tint: LumenPalette.teal600)
                    }
                    LabeledContent {
                        recoveryStatus
                    } label: {
                        SettingsLabel(title: "Recovery", systemImage: "key.fill", tint: LumenPalette.violet600)
                    }
                    LabeledContent {
                        Text(session.encryption.backupLabel).foregroundStyle(c.textMuted)
                    } label: {
                        SettingsLabel(title: "Key backup", systemImage: "externaldrive.badge.icloud", tint: LumenPalette.cyan600)
                    }
                    if session.encryption.verificationState != .verified || session.encryption.recoveryState != .enabled {
                        Button { showRecovery = true } label: {
                            Label("Secure your messages", systemImage: "checkmark.shield")
                                .font(.body.weight(.semibold))
                        }
                    }
                    if session.encryption.recoveryState == .enabled {
                        AsyncButton {
                            newRecoveryKey = try? await session.encryption.resetRecoveryKey()
                        } label: { Text("Change recovery key") }
                    }
                    NavigationLink { SecurityInfoView() } label: {
                        SettingsLabel(title: "How your data is protected", systemImage: "lock.shield", tint: LumenPalette.green600)
                    }
                    NavigationLink { BlockedUsersView(session: session) } label: {
                        LabeledContent {
                            Text("\(session.ignoredUsers.count)").monospacedDigit()
                        } label: {
                            SettingsLabel(title: "Blocked people", systemImage: "hand.raised.fill", tint: LumenPalette.red600)
                        }
                    }
                } header: {
                    Text("Security")
                } footer: {
                    Text("End-to-end encrypted with Matrix. Verified devices and a recovery key keep your history readable and your identity trusted.")
                }

                Section {
                    Toggle(isOn: $app.preferences.sendReadReceipts) {
                        SettingsLabel(title: "Send read receipts", systemImage: "checkmark.message", tint: LumenPalette.teal600)
                    }
                    Toggle(isOn: $app.preferences.sendTypingNotices) {
                        SettingsLabel(title: "Send typing notices", systemImage: "ellipsis.bubble", tint: LumenPalette.teal600)
                    }
                } header: {
                    Text("Privacy")
                } footer: {
                    Text("With read receipts off, your read position still syncs between your own devices, privately.")
                }

                Section {
                    Picker(selection: $app.preferences.notificationPreview) {
                        ForEach(NotificationPreview.allCases, id: \.self) { Text($0.title).tag($0) }
                    } label: {
                        SettingsLabel(title: "Previews", systemImage: "bell.badge.fill", tint: LumenPalette.red600)
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
                    if Biometrics.kind == .unavailable && !app.preferences.appLockEnabled {
                        Toggle(isOn: .constant(false)) {
                            SettingsLabel(title: "App lock", systemImage: "lock.fill", tint: LumenPalette.midnight600)
                        }
                        .disabled(true)
                    } else {
                        Toggle(isOn: Binding(get: { app.preferences.appLockEnabled }, set: { on in
                            Task {
                                if !(await app.setAppLock(enabled: on)) {
                                    lockError = Biometrics.kind == .unavailable ? "Set a device passcode in iOS Settings first." : "App lock wasn't changed. Try again."
                                }
                            }
                        })) {
                            SettingsLabel(title: lockTitle, systemImage: lockSymbol, tint: LumenPalette.midnight600)
                        }
                    }
                    if app.preferences.appLockEnabled {
                        Picker("Lock", selection: $app.preferences.appLockTimeout) {
                            ForEach(AppLockTimeout.allCases) { Text($0.title).tag($0) }
                        }
                    }
                    if let lockError { Text(lockError).font(.footnote).foregroundStyle(c.danger) }
                } header: {
                    Text("App lock")
                } footer: {
                    Text(Biometrics.kind == .unavailable
                         ? "To use app lock, turn on a passcode in iOS Settings. App lock protects against someone picking up your unlocked device; it doesn't protect against a compromised operating system."
                         : "App lock protects against someone picking up your unlocked device. It doesn't protect against a compromised operating system. Lumen's content is also hidden in the app switcher.")
                }

                Section {
                    NavigationLink { AboutView(session: session) } label: {
                        SettingsLabel(title: "About Lumen", systemImage: "info.circle.fill", tint: LumenPalette.cyan600)
                    }
                    if let help = session.lumen?.helpURL {
                        Button { safariURL = IdentifiedURL(url: help) } label: {
                            SettingsLabel(title: "Help", systemImage: "questionmark.circle.fill", tint: LumenPalette.violet600)
                        }
                    }
                    if let privacy = session.lumen?.privacyURL {
                        Button { safariURL = IdentifiedURL(url: privacy) } label: {
                            SettingsLabel(title: "Privacy policy", systemImage: "hand.raised.circle.fill", tint: LumenPalette.teal600)
                        }
                    }
                }

                Section {
                    Button("Sign out", role: .destructive) { confirmSignOut = true }
                    if let e = app.signOutError {
                        Text(e).font(.footnote).foregroundStyle(c.danger)
                        AsyncButton(role: .destructive) { await app.signOut(force: true) } label: { Text("Sign out on this device only") }
                    }
                } footer: {
                    Text("Signing out removes this device from your account and deletes its messages, keys and settings. Make sure recovery is set up or another device is signed in, so you keep your encrypted history.")
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
            }
            .scrollContentBackground(.hidden)
            .background(c.bg)
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .sheet(item: $safariURL) { SafariView(url: $0.url).ignoresSafeArea() }
            .sheet(isPresented: $showRecovery) { SecurityOnboardingView(session: session).lumenTheme() }
            .sheet(item: Binding(get: { newRecoveryKey.map { IdentifiedString(value: $0) } }, set: { newRecoveryKey = $0?.value })) { k in
                NewRecoveryKeyView(key: k.value) { newRecoveryKey = nil }
                    .lumenTheme()
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

    private var lockTitle: String {
        switch Biometrics.kind {
        case .faceID: return "Require Face ID"
        case .touchID: return "Require Touch ID"
        case .opticID: return "Require Optic ID"
        case .passcodeOnly, .unavailable: return "Require device passcode"
        }
    }

    private var lockSymbol: String {
        switch Biometrics.kind {
        case .faceID: return "faceid"
        case .touchID: return "touchid"
        case .opticID: return "opticid"
        case .passcodeOnly, .unavailable: return "lock.fill"
        }
    }

    @ViewBuilder
    private var deviceStatus: some View {
        switch session.encryption.verificationState {
        case .verified: StatusValue(text: "Verified", systemImage: "checkmark.seal.fill", tint: c.success)
        case .unverified: StatusValue(text: "Not verified", systemImage: "exclamationmark.circle.fill", tint: c.warning)
        case .unknown: Text("Checking…").foregroundStyle(c.textMuted)
        }
    }

    @ViewBuilder
    private var recoveryStatus: some View {
        switch session.encryption.recoveryState {
        case .enabled: StatusValue(text: "Set up", systemImage: "checkmark.circle.fill", tint: c.success)
        case .incomplete: StatusValue(text: "Needs your key", systemImage: "key", tint: c.warning)
        case .disabled: StatusValue(text: "Not set up", systemImage: "exclamationmark.circle.fill", tint: c.warning)
        case .unknown: Text("Checking…").foregroundStyle(c.textMuted)
        }
    }
}

/// Matrix ID helpers for display.
enum MatrixIDText {
    static func localpart(_ userId: String) -> String { TimelineModel.localpart(userId) }

    static func server(_ userId: String) -> String {
        guard let colon = userId.firstIndex(of: ":") else { return userId }
        return String(userId[userId.index(after: colon)...])
    }
}

/// Shown once after "Change recovery key".
struct NewRecoveryKeyView: View {
    let key: String
    var done: () -> Void
    @Environment(\.lumen) private var c

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: LumenDimens.space4) {
                    Text("Your new recovery key")
                        .font(.title2.weight(.bold))
                        .foregroundStyle(c.text)
                    Text("The old key no longer works. Save this one now; it isn't shown again.")
                        .foregroundStyle(c.textMuted)
                    RecoveryKeyCard(key: key)
                    ShareLink(item: key) { Label("Save to Files or a password manager", systemImage: "square.and.arrow.up") }
                        .buttonStyle(SecondaryButtonStyle())
                }
                .padding(LumenDimens.space5)
                .frame(maxWidth: 560)
                .frame(maxWidth: .infinity)
            }
            .background(c.bg)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("I've saved it", action: done) } }
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
                    HStack(spacing: LumenDimens.space3) {
                        Image(systemName: Self.symbol(for: d))
                            .font(.title3)
                            .foregroundStyle(d.deviceId == session.deviceId ? c.accent : c.textMuted)
                            .frame(width: 40, height: 40)
                            .background(Circle().fill(d.deviceId == session.deviceId ? c.accentSoft : c.surface2))
                            .accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: 3) {
                            HStack(spacing: LumenDimens.space2) {
                                Text(d.displayName ?? "Unnamed device")
                                    .font(.body.weight(.medium))
                                    .foregroundStyle(c.text)
                                    .lineLimit(2)
                                if d.deviceId == session.deviceId {
                                    CapsuleLabel(text: "This device", tint: c.accent, background: c.accentSoft)
                                }
                            }
                            Text(d.deviceId).font(.caption.monospaced()).foregroundStyle(c.textMuted)
                            if d.deviceId == session.deviceId {
                                if session.encryption.verificationState == .verified {
                                    StatusValue(text: "Verified", systemImage: "checkmark.seal.fill", tint: c.success).font(.caption)
                                } else {
                                    StatusValue(text: "Not verified", systemImage: "exclamationmark.circle.fill", tint: c.warning).font(.caption)
                                }
                            }
                            if let seen = d.lastSeen {
                                Text("Active \(seen.formatted(.relative(presentation: .named)))")
                                    .font(.caption)
                                    .foregroundStyle(c.textSubtle)
                            }
                        }
                    }
                    .padding(.vertical, 2)
                    .accessibilityElement(children: .combine)
                    .swipeActions {
                        if d.deviceId != session.deviceId {
                            Button("Remove", role: .destructive) { removing = d }
                        }
                    }
                    .contextMenu {
                        if d.deviceId != session.deviceId {
                            Button(role: .destructive) { removing = d } label: { Label("Remove", systemImage: "trash") }
                        }
                    }
                }
            } footer: {
                Text("Swipe a device to remove it; you'll confirm on your account's sign-in page. Only this device's verification is shown here; other devices show their own status, and the web app shows all of them.")
            }
            if let error {
                Section { Text(error).foregroundStyle(c.danger) }
            }
        }
        .scrollContentBackground(.hidden)
        .background(c.bg)
        .overlay { if loading && devices.isEmpty { ProgressView() } }
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

    static func symbol(for d: DeviceInfo) -> String {
        let name = (d.displayName ?? "").lowercased()
        if name.contains("ipad") { return "ipad" }
        if name.contains("iphone") || name.contains("android") || name.contains("phone") { return "iphone" }
        if name.contains("mac") || name.contains("laptop") { return "laptopcomputer" }
        if name.contains("web") || name.contains("firefox") || name.contains("chrome") || name.contains("safari") { return "globe" }
        return "desktopcomputer"
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            devices = try await session.devicesAPI().list()
            error = nil
        } catch {
            self.error = "The device list didn't load. Pull down to try again."
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
            self.error = "The device couldn't be removed. Check your connection and try again."
        }
        await load()
    }
}

struct BlockedUsersView: View {
    let session: SessionModel
    @Environment(\.lumen) private var c
    @State private var error: String?

    var body: some View {
        List {
            ForEach(session.ignoredUsers, id: \.self) { id in
                HStack(spacing: LumenDimens.space3) {
                    AvatarView(name: id, size: 36)
                    Text(id)
                        .foregroundStyle(c.text)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Spacer(minLength: LumenDimens.space2)
                    AsyncButton {
                        do { try await session.unignore(userId: id) } catch { self.error = "Unblocking didn't go through. Try again." }
                    } label: { Text("Unblock") }
                    .buttonStyle(ChipButtonStyle())
                }
            }
            if let error { Text(error).foregroundStyle(c.danger) }
        }
        .scrollContentBackground(.hidden)
        .background(c.bg)
        .overlay {
            if session.ignoredUsers.isEmpty {
                EmptyStateView(systemImage: "hand.raised", title: "No one is blocked",
                               message: "When you block someone, you stop seeing their messages and invitations. They show up here.")
            }
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
            Section {
                HStack(alignment: .top, spacing: LumenDimens.space3) {
                    BrandMark(size: 44)
                    VStack(alignment: .leading, spacing: LumenDimens.space1) {
                        Text("Lumen runs on Matrix")
                            .font(.headline)
                            .foregroundStyle(c.text)
                        Text("Matrix is the open standard for secure, decentralised messaging. Lumen is new, and built on it.")
                            .font(.subheadline)
                            .foregroundStyle(c.textMuted)
                    }
                }
                .padding(.vertical, LumenDimens.space1)
                .accessibilityElement(children: .combine)
                LabeledContent("Homeserver", value: URL(string: session.account.homeserverURL)?.host ?? session.serverName)
                LabeledContent("Matrix ID") { Text(session.userId).textSelection(.enabled) }
                LabeledContent("Device ID") { Text(session.deviceId).font(.body.monospaced()).textSelection(.enabled) }
                LabeledContent("Encryption") {
                    StatusValue(text: "End-to-end (Olm and Megolm)", systemImage: "lock.fill", tint: c.success)
                }
                LabeledContent("This device") {
                    switch session.encryption.verificationState {
                    case .verified: StatusValue(text: "Verified", systemImage: "checkmark.seal.fill", tint: c.success)
                    case .unverified: StatusValue(text: "Not verified", systemImage: "exclamationmark.circle.fill", tint: c.warning)
                    case .unknown: Text("Checking…").foregroundStyle(c.textMuted)
                    }
                }
            } footer: {
                Text("Matrix servers talk to each other, so you can chat with people on any Matrix server, and other Matrix apps can sign in to your account. No lock-in.")
            }

            Section {
                Label {
                    Text("Lumen servers include WireGuard for private administration. It's optional for operators and protects the server's admin console; your messages don't travel through it, they're end-to-end encrypted on their own.")
                        .font(.subheadline)
                        .foregroundStyle(c.textMuted)
                } icon: {
                    Image(systemName: "network.badge.shield.half.filled").foregroundStyle(c.accent)
                }
            } header: {
                Text("Server administration")
            }

            Section("App") {
                LabeledContent("Version", value: AppEnvironment.appVersion)
                LabeledContent("Matrix Rust SDK", value: "26.10.02 (\(String(sdkGitSha().prefix(10))))")
                LabeledContent("Bundle ID", value: AppEnvironment.build.bundleIdentifier)
            }
            Section("Calls") {
                LabeledContent("Call widget", value: widgetSourceLabel)
                ForEach(transports, id: \.self) { Text($0).font(.caption).foregroundStyle(c.textMuted) }
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
                Text("Built on open standards: Matrix and MatrixRTC. Includes the Matrix Rust SDK (Apache-2.0), the Lumen call widget with matrix-js-sdk and livekit-client (Apache-2.0), and Lucide icons (ISC).")
                    .font(.footnote)
                    .foregroundStyle(c.textMuted)
            }
        }
        .scrollContentBackground(.hidden)
        .background(c.bg)
        .navigationTitle("About Lumen")
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
