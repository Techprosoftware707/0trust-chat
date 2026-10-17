import LumenCore
import MatrixRustSDK
import SwiftUI
import UIKit

/// A round brand glyph at the top of security screens.
struct SecurityHero: View {
    let systemImage: String
    var tint: Color?
    @Environment(\.lumen) private var c

    var body: some View {
        ZStack {
            Circle().fill(c.accentSoft)
            Circle().strokeBorder(c.brandGradient, lineWidth: 1.5).opacity(0.7)
            Image(systemName: systemImage)
                .font(.system(size: 38, weight: .medium))
                .foregroundStyle(tint.map { AnyShapeStyle($0) } ?? AnyShapeStyle(c.brandGradient))
        }
        .frame(width: 96, height: 96)
        .accessibilityHidden(true)
    }
}

/// After sign-in: verify this device with another one or the recovery key,
/// or set up recovery if the account has none.
struct SecurityOnboardingView: View {
    let session: SessionModel
    /// Shown on the setup step's "your recovery key" page (DEBUG screenshots).
    private let previewKey: String?
    @Environment(\.dismiss) private var dismiss
    @Environment(\.lumen) private var c
    @State private var mode: Mode = .choose

    enum Mode { case choose, enterKey, setup }

    init(session: SessionModel, startIn mode: Mode = .choose, previewKey: String? = nil) {
        self.session = session
        self.previewKey = previewKey
        _mode = State(initialValue: mode)
    }

    var body: some View {
        NavigationStack {
            Group {
                switch mode {
                case .choose: choose
                case .enterKey: EnterRecoveryKeyView(encryption: session.encryption) { dismiss() }
                case .setup: SetupRecoveryView(encryption: session.encryption, done: { dismiss() }, initialKey: previewKey)
                }
            }
            .background { BrandWash().ignoresSafeArea() }
            .navigationTitle("Secure your messages")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Later") { dismiss() } } }
        }
        .interactiveDismissDisabled(mode != .choose)
    }

    private var choose: some View {
        ScrollView {
            VStack(spacing: LumenDimens.space4) {
                let enc = session.encryption
                if enc.needsVerification || enc.needsRecoveryKey {
                    SecurityHero(systemImage: "checkmark.shield.fill")
                    titleBlock("Confirm it's you",
                               "Confirm with another device that's signed in, or with your recovery key. Then this device can read your earlier messages, and your contacts can see it's really yours.")
                    VStack(spacing: LumenDimens.space3) {
                        if enc.hasOtherDevices {
                            Button {
                                dismiss()
                                Task { await session.verification.requestDeviceVerification() }
                            } label: { Label("Use another device", systemImage: "laptopcomputer.and.iphone") }
                            .buttonStyle(PrimaryButtonStyle())
                        }
                        if enc.recoveryState == .enabled || enc.recoveryState == .incomplete {
                            if enc.hasOtherDevices {
                                Button { mode = .enterKey } label: { Label("Enter recovery key", systemImage: "key") }
                                    .buttonStyle(SecondaryButtonStyle())
                            } else {
                                Button { mode = .enterKey } label: { Label("Enter recovery key", systemImage: "key") }
                                    .buttonStyle(PrimaryButtonStyle())
                            }
                        }
                        if !enc.hasOtherDevices && enc.recoveryState == .disabled {
                            BannerView(style: .warning, systemImage: "exclamationmark.triangle",
                                       text: "There's no other signed-in device and no recovery key for this account yet. Set up recovery now; messages sent before this device signed in can't be restored.")
                            Button { mode = .setup } label: { Text("Set up recovery") }
                                .buttonStyle(PrimaryButtonStyle())
                        }
                    }
                } else if enc.needsRecoverySetup {
                    SecurityHero(systemImage: "key.fill")
                    titleBlock("Set up recovery",
                               "A recovery key lets you read your encrypted history on a new device if you lose this one. Your keys are encrypted with it before they're stored on the server; the server never sees the key.")
                    Button { mode = .setup } label: { Text("Create recovery key") }
                        .buttonStyle(PrimaryButtonStyle())
                } else {
                    SecurityHero(systemImage: "checkmark.seal.fill", tint: c.success)
                    titleBlock("You're all set", "This device is verified and recovery is set up.")
                    Button("Done") { dismiss() }
                        .buttonStyle(PrimaryButtonStyle())
                }
            }
            .padding(LumenDimens.space5)
            .frame(maxWidth: 520)
            .frame(maxWidth: .infinity)
        }
    }

    private func titleBlock(_ title: String, _ message: String) -> some View {
        VStack(spacing: LumenDimens.space2) {
            Text(title)
                .font(.title2.weight(.bold))
                .foregroundStyle(c.text)
                .accessibilityAddTraits(.isHeader)
            Text(message)
                .font(.body)
                .foregroundStyle(c.textMuted)
        }
        .multilineTextAlignment(.center)
        .fixedSize(horizontal: false, vertical: true)
        .padding(.bottom, LumenDimens.space2)
    }
}

struct EnterRecoveryKeyView: View {
    let encryption: EncryptionModel
    var done: () -> Void
    @State private var key = ""
    @State private var error: String?
    @State private var succeeded = 0
    @Environment(\.lumen) private var c
    @FocusState private var focused: Bool

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: LumenDimens.space4) {
                VStack(alignment: .leading, spacing: LumenDimens.space2) {
                    Text("Enter your recovery key")
                        .font(.title2.weight(.bold))
                        .foregroundStyle(c.text)
                        .accessibilityAddTraits(.isHeader)
                    Text("The key you saved when you set up recovery. It starts with \"Es\"; spaces don't matter.")
                        .foregroundStyle(c.textMuted)
                        .fixedSize(horizontal: false, vertical: true)
                }
                TextField("Recovery key", text: $key, axis: .vertical)
                    .font(.system(.body, design: .monospaced))
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .textContentType(.password)
                    .focused($focused)
                    .lineLimit(2...4)
                    .padding(LumenDimens.space3)
                    .background(c.surface, in: RoundedRectangle(cornerRadius: LumenDimens.radiusMd, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: LumenDimens.radiusMd, style: .continuous)
                        .strokeBorder(focused ? c.accent : c.border, lineWidth: focused ? 1.5 : 1))
                    .accessibilityLabel("Recovery key")
                if let error {
                    BannerView(style: .danger, systemImage: "exclamationmark.triangle", text: error)
                }
                AsyncButton {
                    do {
                        try await encryption.recover(with: key)
                        key = ""
                        succeeded += 1
                        done()
                    } catch {
                        self.error = "That recovery key didn't work. Check it and try again."
                    }
                } label: { Text("Confirm") }
                .buttonStyle(PrimaryButtonStyle())
                .disabled(RecoveryKeyFormat.normalise(key).isEmpty)
            }
            .padding(LumenDimens.space5)
            .frame(maxWidth: 520)
            .frame(maxWidth: .infinity)
        }
        .sensoryFeedback(.success, trigger: succeeded)
        .sensoryFeedback(.error, trigger: error) { _, new in new != nil }
    }
}

/// The recovery key in a card, grouped for reading, with a short-lived copy.
struct RecoveryKeyCard: View {
    let key: String
    @Environment(\.lumen) private var c
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: LumenDimens.space3) {
            Text(RecoveryKeyFormat.grouped(key))
                .font(.system(.title3, design: .monospaced).weight(.medium))
                .foregroundStyle(c.text)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityLabel("Recovery key")
            Button {
                UIPasteboard.general.setItems([[UIPasteboard.typeAutomatic: key]], options: [.expirationDate: Date().addingTimeInterval(120), .localOnly: true])
                copied = true
            } label: {
                Label(copied ? "Copied for 2 minutes" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc")
            }
            .buttonStyle(ChipButtonStyle())
            .accessibilityHint("Copies the key for two minutes, this device only")
        }
        .lumenCard()
        .sensoryFeedback(.success, trigger: copied) { _, new in new }
    }
}

/// Creates the recovery key, shows it once and asks the user to type it back.
struct SetupRecoveryView: View {
    let encryption: EncryptionModel
    var done: () -> Void
    /// Start on the "your recovery key" step with this key (DEBUG screenshots).
    var initialKey: String? = nil
    @State private var step: Step = .intro
    @State private var key: String?
    @State private var saved = false
    @State private var typed = ""
    @State private var error: String?
    @State private var celebrate = false
    @Environment(\.lumen) private var c
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    enum Step { case intro, show, confirm, done }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: LumenDimens.space4) {
                switch step {
                case .intro:
                    SecurityHero(systemImage: "key.fill")
                        .frame(maxWidth: .infinity)
                    Text("Create your recovery key")
                        .font(.title2.weight(.bold))
                        .foregroundStyle(c.text)
                        .frame(maxWidth: .infinity)
                    point("lock.fill", "Your message keys are encrypted with it before they're stored on the server.")
                    point("tray.full.fill", "Keep it somewhere safe, like a password manager. Anyone with it and your account can read your history.")
                    point("arrow.triangle.2.circlepath", "With it, a new device can read everything you've sent and received.")
                    if let p = encryption.recoveryProgress { ProgressView(p).frame(maxWidth: .infinity) }
                    if let error { BannerView(style: .danger, systemImage: "exclamationmark.triangle", text: error) }
                    AsyncButton {
                        do {
                            key = try await encryption.enableRecovery()
                            step = .show
                        } catch {
                            self.error = "Recovery couldn't be set up. Check your connection and try again."
                        }
                    } label: { Text("Create recovery key") }
                    .buttonStyle(PrimaryButtonStyle())
                case .show:
                    Text("Your recovery key")
                        .font(.title2.weight(.bold))
                        .foregroundStyle(c.text)
                    Label("It's shown only now. Save it before you continue.", systemImage: "exclamationmark.circle")
                        .font(.subheadline)
                        .foregroundStyle(c.warning)
                    RecoveryKeyCard(key: key ?? "")
                    if let key {
                        ShareLink(item: key) { Label("Save to Files or a password manager", systemImage: "square.and.arrow.up") }
                            .buttonStyle(SecondaryButtonStyle())
                    }
                    Toggle("I've saved my recovery key somewhere safe", isOn: $saved)
                        .font(.subheadline)
                        .tint(c.accent)
                        .padding(.vertical, LumenDimens.space1)
                    Button("Continue") { step = .confirm }
                        .buttonStyle(PrimaryButtonStyle())
                        .disabled(!saved)
                case .confirm:
                    Text("Check your key")
                        .font(.title2.weight(.bold))
                        .foregroundStyle(c.text)
                    Text("To make sure you saved it, type your recovery key.")
                        .foregroundStyle(c.textMuted)
                    TextField("Recovery key", text: $typed, axis: .vertical)
                        .font(.system(.body, design: .monospaced))
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .lineLimit(2...4)
                        .padding(LumenDimens.space3)
                        .background(c.surface, in: RoundedRectangle(cornerRadius: LumenDimens.radiusMd, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: LumenDimens.radiusMd, style: .continuous).strokeBorder(c.border))
                        .accessibilityLabel("Recovery key")
                    if let error { BannerView(style: .danger, systemImage: "exclamationmark.triangle", text: error) }
                    HStack(spacing: LumenDimens.space3) {
                        Button("Back") { step = .show; error = nil }
                            .buttonStyle(SecondaryButtonStyle())
                        Button("Confirm") {
                            if RecoveryKeyFormat.matches(typed: typed, shown: key ?? "") {
                                key = nil
                                typed = ""
                                error = nil
                                step = .done
                            } else {
                                error = "That doesn't match the key on the previous step. Go back to check it."
                            }
                        }
                        .buttonStyle(PrimaryButtonStyle())
                    }
                case .done:
                    VStack(spacing: LumenDimens.space3) {
                        Image(systemName: "checkmark.seal.fill")
                            .font(.system(size: 64, weight: .medium))
                            .foregroundStyle(c.success)
                            .symbolEffect(.bounce, value: celebrate)
                            .onAppear { if !reduceMotion { celebrate = true } }
                            .accessibilityHidden(true)
                        Text("You're all set")
                            .font(.title2.weight(.bold))
                            .foregroundStyle(c.text)
                        Text("Recovery is set up. If you lose this device, your recovery key brings your messages back.")
                            .foregroundStyle(c.textMuted)
                            .multilineTextAlignment(.center)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, LumenDimens.space4)
                    Button("Done", action: done).buttonStyle(PrimaryButtonStyle())
                }
            }
            .padding(LumenDimens.space5)
            .frame(maxWidth: 520)
            .frame(maxWidth: .infinity)
        }
        .animation(reduceMotion ? nil : Animation.lumenEaseOut, value: step)
        .sensoryFeedback(.success, trigger: step) { _, new in new == .done }
        .onAppear {
            if let initialKey, key == nil {
                key = initialKey
                step = .show
            }
        }
    }

    private func point(_ symbol: String, _ text: String) -> some View {
        Label {
            Text(text).foregroundStyle(c.text).fixedSize(horizontal: false, vertical: true)
        } icon: {
            Image(systemName: symbol)
                .foregroundStyle(c.accent)
                .frame(width: 28)
        }
        .font(.subheadline)
    }
}

/// SAS emoji verification, from the request to the result.
struct VerificationView: View {
    let verification: VerificationModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.lumen) private var c
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @ScaledMetric(relativeTo: .largeTitle) private var emojiSize: CGFloat = 40
    @State private var celebrate = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: LumenDimens.space5) {
                    content
                }
                .padding(LumenDimens.space5)
                .frame(maxWidth: 520)
                .frame(maxWidth: .infinity)
            }
            .background { BrandWash().ignoresSafeArea() }
            .navigationTitle(verification.otherUserId == nil ? "Verify this device" : "Verify contact")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    if verification.isActive {
                        Button("Cancel") { Task { await verification.cancel(); dismiss() } }
                    }
                }
            }
        }
        .sensoryFeedback(.success, trigger: verification.phase) { _, new in new == .verified }
        .sensoryFeedback(.warning, trigger: verification.phase) { _, new in
            if case .cancelled = new { return true }
            return new == .failed
        }
    }

    @ViewBuilder
    private var content: some View {
        switch verification.phase {
        case .idle:
            EmptyView()
        case .requesting, .waitingForOther:
            SecurityHero(systemImage: verification.otherUserId == nil ? "laptopcomputer.and.iphone" : "person.2.fill")
            ProgressView()
            Text(verification.otherUserId == nil ? "Accept the request on your other device." : "Waiting for them to accept…")
                .font(.headline)
                .foregroundStyle(c.text)
                .multilineTextAlignment(.center)
            Text("Keep this screen open. You'll compare a few emoji next.")
                .font(.subheadline)
                .foregroundStyle(c.textMuted)
                .multilineTextAlignment(.center)
        case .incoming(let sender, let deviceName, let deviceId):
            SecurityHero(systemImage: "checkmark.shield")
            VStack(spacing: LumenDimens.space2) {
                Text("\(sender) wants to verify")
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(c.text)
                Text("From \(deviceName ?? deviceId)")
                    .foregroundStyle(c.textMuted)
            }
            .multilineTextAlignment(.center)
            VStack(spacing: LumenDimens.space3) {
                AsyncButton { await verification.acceptIncoming() } label: { Text("Start") }
                    .buttonStyle(PrimaryButtonStyle())
                AsyncButton { await verification.cancel() } label: { Text("Not now") }
                    .buttonStyle(SecondaryButtonStyle())
            }
        case .sasStarted, .confirming:
            ProgressView()
                .padding(.top, LumenDimens.space6)
            Text(verification.phase == .confirming ? "Confirming…" : "Getting the emoji ready…")
                .foregroundStyle(c.textMuted)
        case .emojis(let emojis):
            Text("Check that these emoji appear on the other device, in the same order.")
                .font(.headline)
                .foregroundStyle(c.text)
                .multilineTextAlignment(.center)
            emojiGrid(emojis)
            VStack(spacing: LumenDimens.space3) {
                AsyncButton { await verification.confirm() } label: { Text("They match") }
                    .buttonStyle(PrimaryButtonStyle())
                AsyncButton(role: .destructive) { await verification.mismatch() } label: { Text("They don't match") }
                    .buttonStyle(SecondaryButtonStyle())
            }
        case .decimals(let values):
            Text("Check that these numbers appear on the other device.")
                .font(.headline)
                .foregroundStyle(c.text)
                .multilineTextAlignment(.center)
            Text(values.map(String.init).joined(separator: "  "))
                .font(.system(.title, design: .monospaced).weight(.semibold))
                .foregroundStyle(c.text)
                .lumenCard()
            VStack(spacing: LumenDimens.space3) {
                AsyncButton { await verification.confirm() } label: { Text("They match") }
                    .buttonStyle(PrimaryButtonStyle())
                AsyncButton(role: .destructive) { await verification.mismatch() } label: { Text("They don't match") }
                    .buttonStyle(SecondaryButtonStyle())
            }
        case .verified:
            VStack(spacing: LumenDimens.space3) {
                Image(systemName: "checkmark.seal.fill")
                    .font(.system(size: 64, weight: .medium))
                    .foregroundStyle(c.success)
                    .symbolEffect(.bounce, value: celebrate)
                    .onAppear { if !reduceMotion { celebrate = true } }
                    .accessibilityHidden(true)
                Text("Verified")
                    .font(.title2.weight(.bold))
                    .foregroundStyle(c.text)
                Text(verification.otherUserId == nil
                     ? "This device is now trusted. It can read your encrypted history, and your contacts can see it's yours."
                     : "You've confirmed this contact. Their verified identity is now marked as trusted.")
                    .foregroundStyle(c.textMuted)
                    .multilineTextAlignment(.center)
            }
            .padding(.top, LumenDimens.space5)
            Button("Done") { verification.reset(); dismiss() }
                .buttonStyle(PrimaryButtonStyle())
        case .cancelled(let why):
            SecurityHero(systemImage: "xmark.shield", tint: c.warning)
            Text(why)
                .foregroundStyle(c.text)
                .multilineTextAlignment(.center)
            Button("Close") { verification.reset(); dismiss() }
                .buttonStyle(PrimaryButtonStyle())
        case .failed:
            SecurityHero(systemImage: "exclamationmark.shield", tint: c.warning)
            Text("Verification didn't finish. Try again in a moment.")
                .foregroundStyle(c.text)
                .multilineTextAlignment(.center)
            Button("Close") { verification.reset(); dismiss() }
                .buttonStyle(PrimaryButtonStyle())
        }
    }

    /// Seven emoji as rows of four, the last row centred.
    private func emojiGrid(_ emojis: [VerificationModel.Emoji]) -> some View {
        let rows = stride(from: 0, to: emojis.count, by: 4).map { Array(emojis[$0..<min($0 + 4, emojis.count)]) }
        return VStack(spacing: LumenDimens.space3) {
            ForEach(rows.indices, id: \.self) { r in
                HStack(spacing: LumenDimens.space3) {
                    ForEach(rows[r]) { e in
                        VStack(spacing: LumenDimens.space1) {
                            Text(e.symbol).font(.system(size: emojiSize))
                            Text(e.name)
                                .font(.caption.weight(.medium))
                                .foregroundStyle(c.textMuted)
                                .lineLimit(1)
                                .minimumScaleFactor(0.8)
                        }
                        .frame(maxWidth: 76)
                        .padding(.vertical, LumenDimens.space2)
                        .frame(maxWidth: .infinity)
                        .background(c.surface, in: RoundedRectangle(cornerRadius: LumenDimens.radiusMd, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: LumenDimens.radiusMd, style: .continuous).strokeBorder(c.border))
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel(e.name)
                    }
                }
                .frame(maxWidth: r == rows.count - 1 && rows[r].count < 4 ? CGFloat(rows[r].count) * 88 : .infinity)
            }
        }
    }
}

/// What end-to-end encryption protects in this app, and what it doesn't.
struct SecurityInfoView: View {
    @Environment(\.lumen) private var c

    var body: some View {
        List {
            Section {
                row("lock.fill", c.success, "Message text, files, images, reactions and edits in encrypted rooms: encrypted on your device, decrypted only on the devices of the people in the room (Olm/Megolm via the Matrix Rust SDK).")
                row("phone.badge.checkmark", c.success, "Call audio and video, when the call screen says \"End-to-end encrypted\": each frame is encrypted with keys the server never receives. The label comes from the call itself, not from this screen.")
                row("key.fill", c.success, "Your key backup: encrypted with your recovery key before it's stored on the server.")
            } header: {
                Text("Protected")
            }
            Section {
                row("eye", c.warning, "Who you talk to, when, how much, room names and topics, member lists, profile names and pictures, device names and IP addresses.")
                row("eye", c.warning, "Read receipts and typing notices (you can turn both off).")
                row("bell", c.warning, "Push notifications: Apple and the push gateway learn that a notification was sent to this device, the room and event IDs and the unread count, not the message.")
            } header: {
                Text("Not protected from the server")
            }
            Section {
                row("exclamationmark.shield", c.info, "The server can add devices to accounts it hosts. Verify your contacts and watch for identity-change warnings.")
                row("atom", c.info, "Encryption uses classical cryptography (Curve25519, AES). It is not post-quantum.")
                row("lock.iphone", c.info, "App lock protects against someone picking up your unlocked phone. It does not protect against a compromised operating system.")
                row("trash.slash", c.info, "Messages already on another person's device stay readable to them, even after you delete them.")
            } header: {
                Text("Limits")
            }
        }
        .scrollContentBackground(.hidden)
        .background(c.bg)
        .navigationTitle("How your data is protected")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func row(_ symbol: String, _ tint: Color, _ text: String) -> some View {
        Label {
            Text(text).foregroundStyle(c.text).fixedSize(horizontal: false, vertical: true)
        } icon: {
            Image(systemName: symbol).foregroundStyle(tint)
        }
        .padding(.vertical, 2)
    }
}
