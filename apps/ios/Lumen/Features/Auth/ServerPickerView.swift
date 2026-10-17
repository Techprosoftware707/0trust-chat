import LumenCore
import SwiftUI

/// Welcome, server picker and sign-in (integration.md §2–3). The server field
/// is pre-filled with the build's `LUMEN_DEFAULT_SERVER`.
struct ServerPickerView: View {
    @Bindable var auth: AuthModel
    /// A sign-in error to show from the start (DEBUG screenshots).
    var initialError: String? = nil
    @Environment(AppModel.self) private var model
    @Environment(\.lumen) private var c
    @State private var error: String?
    @State private var safariURL: IdentifiedURL?
    @State private var webAuth = WebAuthenticator()
    @FocusState private var fieldFocused: Bool

    var body: some View {
        ScrollView {
            VStack(spacing: LumenDimens.space5) {
                hero

                VStack(alignment: .leading, spacing: LumenDimens.space4) {
                    switch auth.phase {
                    case .ready(let d), .signingIn(let d):
                        signInSection(d)
                    default:
                        serverSection
                    }
                    if case .failed(let message) = auth.phase {
                        BannerView(style: .danger, systemImage: "exclamationmark.triangle", text: message)
                    }
                    if let error {
                        BannerView(style: .danger, systemImage: "exclamationmark.triangle", text: error)
                    }
                }
                .lumenCard(padding: LumenDimens.space5)

                Label("End-to-end encrypted by default · Works with any Matrix server", systemImage: "lock.shield")
                    .font(.footnote)
                    .foregroundStyle(c.textMuted)
                    .multilineTextAlignment(.center)
            }
            .padding(.horizontal, LumenDimens.space5)
            .padding(.vertical, LumenDimens.space6)
            .frame(maxWidth: 520)
            .frame(maxWidth: .infinity)
        }
        .scrollDismissesKeyboard(.interactively)
        .background { WelcomeBackground().ignoresSafeArea() }
        .sheet(item: $safariURL) { SafariView(url: $0.url).ignoresSafeArea() }
        .sensoryFeedback(.error, trigger: errorCount) { old, new in new > old }
        .onAppear { if let initialError, error == nil { error = initialError } }
        .task {
            // A pre-configured server is looked up straight away.
            if case .idle = auth.phase, !auth.serverInput.isEmpty { await auth.discover() }
        }
    }

    private var errorCount: Int {
        var n = error == nil ? 0 : 1
        if case .failed = auth.phase { n += 2 }
        return n
    }

    private var hero: some View {
        VStack(spacing: LumenDimens.space3) {
            BrandMarkHero(size: 76)
            CapsuleLabel(text: "New · Built on Matrix", systemImage: "sparkles", tint: c.accent, background: c.accentSoft)
            Text("Welcome to \(auth.discovery?.brandName ?? LumenAppInfo.defaultBrandName)")
                .font(.title.weight(.bold))
                .foregroundStyle(c.text)
                .multilineTextAlignment(.center)
                .accessibilityAddTraits(.isHeader)
            Text("Secure messaging built on Matrix, the open standard.")
                .font(.body)
                .foregroundStyle(c.textMuted)
                .multilineTextAlignment(.center)
        }
        .padding(.top, LumenDimens.space4)
        .accessibilityElement(children: .combine)
    }

    private var discovering: Bool { auth.phase == .discovering }

    private var serverSection: some View {
        VStack(alignment: .leading, spacing: LumenDimens.space3) {
            Text("Your server")
                .font(.headline)
                .foregroundStyle(c.text)
            HStack(spacing: LumenDimens.space2) {
                Image(systemName: "server.rack")
                    .foregroundStyle(c.textSubtle)
                    .accessibilityHidden(true)
                TextField("example.com", text: $auth.serverInput)
                    .textContentType(.URL)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.go)
                    .focused($fieldFocused)
                    .onSubmit { lookUp() }
                    .onChange(of: auth.serverInput) { _, _ in
                        if case .ready = auth.phase { auth.reset() }
                        if case .failed = auth.phase { auth.reset() }
                    }
                    .accessibilityLabel("Server name or address")
                    .accessibilityIdentifier("serverField")
            }
            .padding(.horizontal, LumenDimens.space3)
            .frame(minHeight: 50)
            .background(c.surface2, in: RoundedRectangle(cornerRadius: LumenDimens.radiusMd, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: LumenDimens.radiusMd, style: .continuous)
                .strokeBorder(fieldFocused ? c.accent : c.border, lineWidth: fieldFocused ? 1.5 : 1))

            Text("The part after the colon in your Matrix ID, or your organisation's address.")
                .font(.footnote)
                .foregroundStyle(c.textMuted)
                .fixedSize(horizontal: false, vertical: true)

            Button(action: lookUp) {
                if discovering {
                    HStack(spacing: LumenDimens.space2) {
                        ProgressView().tint(c.accentContrast)
                        Text("Looking up the server…")
                    }
                } else {
                    Text("Continue")
                }
            }
            .buttonStyle(PrimaryButtonStyle())
            .disabled(auth.serverInput.trimmingCharacters(in: .whitespaces).isEmpty)
            .accessibilityIdentifier("continueButton")
        }
    }

    private func lookUp() {
        guard !discovering else { return }
        fieldFocused = false
        error = nil
        Task { await auth.discover() }
    }

    @ViewBuilder
    private func signInSection(_ d: ServerDiscovery) -> some View {
        let signingIn: Bool = { if case .signingIn = auth.phase { return true } else { return false } }()
        VStack(alignment: .leading, spacing: LumenDimens.space3) {
            HStack(spacing: LumenDimens.space2) {
                Image(systemName: "lock.shield.fill")
                    .foregroundStyle(c.success)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 1) {
                    Text(d.homeserverURL.host ?? d.serverName)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(c.text)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Text("Secure connection")
                        .font(.caption)
                        .foregroundStyle(c.textMuted)
                }
                Spacer(minLength: LumenDimens.space2)
                Button("Change") {
                    auth.reset()
                    error = nil
                    fieldFocused = true
                }
                .buttonStyle(ChipButtonStyle())
                .disabled(signingIn)
                .accessibilityLabel("Use a different server")
            }
            .accessibilityElement(children: .contain)

            if d.loginFlows.sso.isEmpty {
                BannerView(style: .warning, systemImage: "exclamationmark.triangle",
                           text: "This server only offers password sign-in. Lumen signs in through your server's own sign-in page, so it never handles your password. Use the web app for this server.")
            } else {
                ForEach(providers(d), id: \.name) { provider in
                    Button {
                        Task { await signIn(provider) }
                    } label: {
                        if signingIn {
                            HStack(spacing: LumenDimens.space2) {
                                ProgressView().tint(c.accentContrast)
                                Text("Waiting for your sign-in page…")
                            }
                        } else {
                            Label(provider.id == d.lumen?.ssoIdpId ? "Continue with your \(d.lumen?.displayShortName ?? "Lumen") account" : "Continue with \(provider.name)",
                                  systemImage: "person.badge.key")
                        }
                    }
                    .buttonStyle(PrimaryButtonStyle())
                    .allowsHitTesting(!signingIn)
                    .accessibilityIdentifier("ssoButton")
                }
                Text(signingIn
                     ? "Finish signing in on your server's page. You can close it to come back here."
                     : "You'll sign in on your server's page in a secure browser sheet. Lumen never sees your password or two-factor codes.")
                    .font(.footnote)
                    .foregroundStyle(c.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if let signup = d.lumen?.signupURL {
                Button {
                    safariURL = IdentifiedURL(url: signup)
                } label: {
                    Text("New here? Create your \(d.lumen?.displayShortName ?? "Lumen") account")
                }
                .buttonStyle(SecondaryButtonStyle())
                .disabled(signingIn)
                .accessibilityHint("Opens the account sign-up page")
            }

            if d.lumen?.privacyURL != nil || d.lumen?.helpURL != nil {
                HStack(spacing: LumenDimens.space4) {
                    if let privacy = d.lumen?.privacyURL {
                        Button("Privacy policy") { safariURL = IdentifiedURL(url: privacy) }
                    }
                    if let help = d.lumen?.helpURL {
                        Button("Help") { safariURL = IdentifiedURL(url: help) }
                    }
                }
                .font(.footnote.weight(.medium))
                .frame(maxWidth: .infinity)
                .frame(minHeight: 44)
            }
        }
    }

    private func providers(_ d: ServerDiscovery) -> [LoginFlows.IdentityProvider] {
        guard let preferred = d.preferredProvider else { return d.loginFlows.sso }
        return [preferred] + d.loginFlows.sso.filter { $0.id != preferred.id && $0.id != nil }
    }

    private func signIn(_ provider: LoginFlows.IdentityProvider) async {
        error = nil
        do {
            let (account, client) = try await auth.signInWithSSO(provider: provider, web: webAuth, deviceModel: DeviceInfoProvider.model)
            await model.completeSignIn(account: account, client: client)
        } catch WebAuthenticationError.cancelled {
            // The user closed the sheet.
        } catch let e as WebAuthenticationError {
            if case .failed(let m) = e { error = m }
        } catch {
            self.error = "Sign-in didn't finish. Please try again."
            Diagnostics.log("Sign-in failed: \(error.localizedDescription)")
        }
    }
}
