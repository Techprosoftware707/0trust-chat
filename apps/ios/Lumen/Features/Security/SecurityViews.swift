import LumenCore
import MatrixRustSDK
import SwiftUI
import UIKit

/// After sign-in: verify this device with another one or the recovery key,
/// or set up recovery if the account has none.
struct SecurityOnboardingView: View {
    let session: SessionModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.lumen) private var c
    @State private var mode: Mode = .choose

    enum Mode { case choose, enterKey, setup }

    var body: some View {
        NavigationStack {
            Group {
                switch mode {
                case .choose: choose
                case .enterKey: EnterRecoveryKeyView(encryption: session.encryption) { dismiss() }
                case .setup: SetupRecoveryView(encryption: session.encryption) { dismiss() }
                }
            }
            .navigationTitle("Secure your messages")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Later") { dismiss() } } }
        }
        .interactiveDismissDisabled(mode != .choose)
    }

    private var choose: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: LumenDimens.space4) {
                let enc = session.encryption
                if enc.needsVerification || enc.needsRecoveryKey {
                    Text("Confirm it's you")
                        .font(.title2.weight(.bold))
                    Text("This device can't read your earlier encrypted messages yet, and your contacts can't tell it's really yours. Confirm with another device that's signed in, or with your recovery key.")
                        .foregroundStyle(c.textMuted)
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
                        Text("No other device and no recovery key are set up for this account. Set up recovery now; messages sent before this device signed in can't be restored.")
                            .foregroundStyle(c.warning)
                        Button { mode = .setup } label: { Text("Set up recovery") }
                            .buttonStyle(PrimaryButtonStyle())
                    }
                } else if enc.needsRecoverySetup {
                    Text("Set up recovery")
                        .font(.title2.weight(.bold))
                    Text("A recovery key lets you read your encrypted history on a new device if you lose this one. Your keys are encrypted with it before they're stored on the server; the server never sees the key.")
                        .foregroundStyle(c.textMuted)
                    Button { mode = .setup } label: { Text("Create recovery key") }
                        .buttonStyle(PrimaryButtonStyle())
                } else {
                    Label("This device is verified and recovery is set up.", systemImage: "checkmark.shield.fill")
                        .foregroundStyle(c.success)
                }
            }
            .padding(LumenDimens.space5)
        }
    }
}

struct EnterRecoveryKeyView: View {
    let encryption: EncryptionModel
    var done: () -> Void
    @State private var key = ""
    @State private var error: String?
    @Environment(\.lumen) private var c

    var body: some View {
        Form {
            Section {
                TextField("Recovery key", text: $key, axis: .vertical)
                    .font(.system(.body, design: .monospaced))
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .textContentType(.password)
                    .accessibilityLabel("Recovery key")
            } footer: {
                Text("The key you saved when you set up recovery (it starts with \"Es\"). Spaces don't matter.")
            }
            if let error { Text(error).foregroundStyle(c.danger) }
            AsyncButton {
                do {
                    try await encryption.recover(with: key)
                    key = ""
                    done()
                } catch {
                    self.error = "That recovery key didn't work. Check it and try again."
                }
            } label: { Text("Confirm") }
            .disabled(RecoveryKeyFormat.normalise(key).isEmpty)
        }
    }
}

/// Creates the recovery key, shows it once and asks the user to type it back.
struct SetupRecoveryView: View {
    let encryption: EncryptionModel
    var done: () -> Void
    @State private var step: Step = .intro
    @State private var key: String?
    @State private var saved = false
    @State private var typed = ""
    @State private var error: String?
    @Environment(\.lumen) private var c

    enum Step { case intro, show, confirm, done }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: LumenDimens.space4) {
                switch step {
                case .intro:
                    Label("Your keys are encrypted with the recovery key before they're stored on the server.", systemImage: "checkmark.circle")
                    Label("Keep it somewhere safe, like a password manager. Anyone with it and your account can read your history.", systemImage: "checkmark.circle")
                    if let p = encryption.recoveryProgress { ProgressView(p) }
                    if let error { Text(error).foregroundStyle(c.danger) }
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
                    Text("Your recovery key").font(.title3.weight(.semibold))
                    Text("It is shown only now. Save it before you continue.").foregroundStyle(c.warning)
                    Text(RecoveryKeyFormat.grouped(key ?? ""))
                        .font(.system(.title3, design: .monospaced))
                        .textSelection(.enabled)
                        .padding()
                        .frame(maxWidth: .infinity)
                        .background(c.surface2, in: RoundedRectangle(cornerRadius: LumenDimens.radiusMd))
                        .accessibilityLabel("Recovery key")
                    HStack {
                        Button {
                            UIPasteboard.general.setItems([[UIPasteboard.typeAutomatic: key ?? ""]], options: [.expirationDate: Date().addingTimeInterval(120), .localOnly: true])
                        } label: { Label("Copy", systemImage: "doc.on.doc") }
                        .accessibilityHint("Copies the key for two minutes, this device only")
                        if let key {
                            ShareLink(item: key) { Label("Save…", systemImage: "square.and.arrow.up") }
                        }
                    }
                    Toggle("I've saved my recovery key somewhere safe", isOn: $saved)
                    Button("Continue") { step = .confirm }
                        .buttonStyle(PrimaryButtonStyle())
                        .disabled(!saved)
                case .confirm:
                    Text("To make sure you saved it, enter your recovery key.")
                    TextField("Recovery key", text: $typed, axis: .vertical)
                        .font(.system(.body, design: .monospaced))
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .padding()
                        .background(c.surface2, in: RoundedRectangle(cornerRadius: LumenDimens.radiusMd))
                        .accessibilityLabel("Recovery key")
                    if let error { Text(error).foregroundStyle(c.danger) }
                    HStack {
                        Button("Back") { step = .show; error = nil }
                            .buttonStyle(SecondaryButtonStyle())
                        Button("Confirm") {
                            if RecoveryKeyFormat.matches(typed: typed, shown: key ?? "") {
                                key = nil
                                typed = ""
                                step = .done
                            } else {
                                error = "That doesn't match the key shown on the previous step."
                            }
                        }
                        .buttonStyle(PrimaryButtonStyle())
                    }
                case .done:
                    Label("Recovery is set up.", systemImage: "checkmark.shield.fill").foregroundStyle(c.success)
                    Button("Done", action: done).buttonStyle(PrimaryButtonStyle())
                }
            }
            .padding(LumenDimens.space5)
        }
    }
}

/// SAS emoji verification.
struct VerificationView: View {
    let verification: VerificationModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.lumen) private var c

    var body: some View {
        NavigationStack {
            VStack(spacing: LumenDimens.space5) {
                switch verification.phase {
                case .idle:
                    EmptyView()
                case .requesting, .waitingForOther:
                    ProgressView()
                    Text(verification.otherUserId == nil ? "Accept the request on your other device." : "Waiting for them to accept…")
                        .multilineTextAlignment(.center)
                case .incoming(let sender, let deviceName, let deviceId):
                    Image(systemName: "checkmark.shield").font(.system(size: 48)).foregroundStyle(c.accent)
                    Text("\(sender) wants to verify").font(.title3.weight(.semibold))
                    Text("Device: \(deviceName ?? deviceId)").foregroundStyle(c.textMuted)
                    AsyncButton { await verification.acceptIncoming() } label: { Text("Start") }
                        .buttonStyle(PrimaryButtonStyle())
                    AsyncButton { await verification.cancel() } label: { Text("Ignore") }
                        .buttonStyle(SecondaryButtonStyle())
                case .sasStarted, .confirming:
                    ProgressView()
                case .emojis(let emojis):
                    Text("Confirm the emoji below appear on the other device, in the same order.")
                        .multilineTextAlignment(.center)
                    LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: 4), spacing: LumenDimens.space4) {
                        ForEach(emojis) { e in
                            VStack {
                                Text(e.symbol).font(.system(size: 40))
                                Text(e.name).font(.caption).foregroundStyle(c.textMuted)
                            }
                            .accessibilityElement(children: .ignore)
                            .accessibilityLabel(e.name)
                        }
                    }
                    AsyncButton { await verification.confirm() } label: { Text("They match") }
                        .buttonStyle(PrimaryButtonStyle())
                    AsyncButton { await verification.mismatch() } label: { Text("They don't match") }
                        .buttonStyle(SecondaryButtonStyle())
                case .decimals(let values):
                    Text("Confirm these numbers appear on the other device.")
                    Text(values.map(String.init).joined(separator: "  ")).font(.system(.title, design: .monospaced))
                    AsyncButton { await verification.confirm() } label: { Text("They match") }
                        .buttonStyle(PrimaryButtonStyle())
                    AsyncButton { await verification.mismatch() } label: { Text("They don't match") }
                        .buttonStyle(SecondaryButtonStyle())
                case .verified:
                    Image(systemName: "checkmark.seal.fill").font(.system(size: 56)).foregroundStyle(c.success)
                    Text("Verified").font(.title2.weight(.bold))
                    Button("Done") { verification.reset(); dismiss() }.buttonStyle(PrimaryButtonStyle())
                case .cancelled(let why):
                    Text(why).multilineTextAlignment(.center)
                    Button("Close") { verification.reset(); dismiss() }.buttonStyle(PrimaryButtonStyle())
                case .failed:
                    Text("Verification failed. Try again.").multilineTextAlignment(.center)
                    Button("Close") { verification.reset(); dismiss() }.buttonStyle(PrimaryButtonStyle())
                }
            }
            .padding(LumenDimens.space5)
            .frame(maxWidth: 520)
            .navigationTitle(verification.otherUserId == nil ? "Verify this device" : "Verify contact")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { Task { await verification.cancel(); dismiss() } }
                }
            }
        }
    }
}

/// What end-to-end encryption protects in this app, and what it doesn't.
struct SecurityInfoView: View {
    @Environment(\.lumen) private var c

    var body: some View {
        List {
            Section("Protected") {
                Label("Message text, files, images, reactions and edits in encrypted rooms: encrypted on your device, decrypted only on the devices of the people in the room (Olm/Megolm via the Matrix Rust SDK).", systemImage: "lock.fill")
                Label("Call audio and video, when the call screen says \"End-to-end encrypted\": each frame is encrypted with keys the server never receives. The label comes from the call itself, not from this screen.", systemImage: "phone.badge.checkmark")
                Label("Your key backup: encrypted with your recovery key before it's stored on the server.", systemImage: "key.fill")
            }
            Section("Not protected from the server") {
                Label("Who you talk to, when, how much, room names and topics, member lists, profile names and pictures, device names and IP addresses.", systemImage: "eye")
                Label("Read receipts and typing notices (you can turn both off).", systemImage: "eye")
                Label("Push notifications: Apple and the push gateway learn that a notification was sent to this device, the room and event IDs and the unread count, not the message.", systemImage: "bell")
            }
            Section("Limits") {
                Label("The server can add devices to accounts it hosts. Verify your contacts and watch for identity-change warnings.", systemImage: "exclamationmark.shield")
                Label("Encryption uses classical cryptography (Curve25519, AES). It is not post-quantum.", systemImage: "atom")
                Label("App lock protects against someone picking up your unlocked phone. It does not protect against a compromised operating system.", systemImage: "lock.iphone")
                Label("Messages already on another person's device stay readable to them, even after you delete them.", systemImage: "trash.slash")
            }
        }
        .navigationTitle("How your data is protected")
    }
}
