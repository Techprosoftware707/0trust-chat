import LumenCore
import SwiftUI

/// Server picker and sign-in (integration.md §2–3). The server field is
/// pre-filled with the build's `LUMEN_DEFAULT_SERVER`.
struct ServerPickerView: View {
    @Bindable var auth: AuthModel
    @Environment(AppModel.self) private var model
    @Environment(\.lumen) private var c
    @State private var error: String?
    @State private var safariURL: IdentifiedURL?
    @State private var webAuth = WebAuthenticator()
    @FocusState private var fieldFocused: Bool

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: LumenDimens.space5) {
                HStack(spacing: LumenDimens.space3) {
                    BrandMark(size: 48)
                    Text(auth.discovery?.brandName ?? LumenAppInfo.defaultBrandName)
                        .font(.title2.weight(.bold))
                        .foregroundStyle(c.text)
                }
                .accessibilityElement(children: .combine)
                .accessibilityAddTraits(.isHeader)

                Text("Private conversations, end-to-end encrypted on every device.")
                    .foregroundStyle(c.textMuted)

                serverSection

                switch auth.phase {
                case .ready(let d), .signingIn(let d):
                    signInSection(d)
                case .failed(let message):
                    BannerView(style: .danger, systemImage: "exclamationmark.triangle", text: message)
                        .clipShape(RoundedRectangle(cornerRadius: LumenDimens.radiusMd))
                default:
                    EmptyView()
                }

                if let error {
                    BannerView(style: .danger, systemImage: "exclamationmark.triangle", text: error)
                        .clipShape(RoundedRectangle(cornerRadius: LumenDimens.radiusMd))
                }
            }
            .padding(LumenDimens.space5)
            .frame(maxWidth: 520)
            .frame(maxWidth: .infinity)
        }
        .background(c.bg.ignoresSafeArea())
        .sheet(item: $safariURL) { SafariView(url: $0.url).ignoresSafeArea() }
        .task {
            // A pre-configured server is looked up straight away.
            if case .idle = auth.phase, !auth.serverInput.isEmpty { await auth.discover() }
        }
    }

    private var serverSection: some View {
        VStack(alignment: .leading, spacing: LumenDimens.space2) {
            Text("Server")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(c.textMuted)
            HStack {
                TextField("example.com", text: $auth.serverInput)
                    .textContentType(.URL)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.go)
                    .focused($fieldFocused)
                    .onSubmit { Task { await auth.discover() } }
                    .onChange(of: auth.serverInput) { _, _ in
                        if case .ready = auth.phase { auth.reset() }
                        if case .failed = auth.phase { auth.reset() }
                    }
                    .accessibilityLabel("Server name or address")
                    .accessibilityIdentifier("serverField")
            }
            .padding(LumenDimens.space3)
            .background(c.surface, in: RoundedRectangle(cornerRadius: LumenDimens.radiusMd))
            .overlay(RoundedRectangle(cornerRadius: LumenDimens.radiusMd).strokeBorder(c.border))

            Text("The server name from your Matrix ID (the part after the colon), or your organisation's address.")
                .font(.footnote)
                .foregroundStyle(c.textSubtle)

            if !isReady {
                AsyncButton {
                    fieldFocused = false
                    await auth.discover()
                } label: {
                    Text("Continue")
                }
                .buttonStyle(PrimaryButtonStyle())
                .disabled(auth.serverInput.trimmingCharacters(in: .whitespaces).isEmpty || auth.phase == .discovering)
                .accessibilityIdentifier("continueButton")
                if auth.phase == .discovering {
                    ProgressView("Looking up the server…")
                        .frame(maxWidth: .infinity)
                }
            }
        }
    }

    private var isReady: Bool {
        switch auth.phase {
        case .ready, .signingIn: return true
        default: return false
        }
    }

    @ViewBuilder
    private func signInSection(_ d: ServerDiscovery) -> some View {
        VStack(alignment: .leading, spacing: LumenDimens.space3) {
            Label(d.homeserverURL.host ?? d.serverName, systemImage: "lock.shield")
                .font(.footnote)
                .foregroundStyle(c.textMuted)
                .accessibilityLabel("Server: \(d.homeserverURL.host ?? d.serverName), connection verified with TLS")

            let signingIn: Bool = { if case .signingIn = auth.phase { return true } else { return false } }()
            if d.loginFlows.sso.isEmpty {
                BannerView(style: .warning, systemImage: "exclamationmark.triangle",
                           text: "This server only offers password sign-in. This app signs in through your server's sign-in page (single sign-on) so that it never handles your password; use the web app for this server.")
                    .clipShape(RoundedRectangle(cornerRadius: LumenDimens.radiusMd))
            } else {
                ForEach(providers(d), id: \.name) { provider in
                    Button {
                        Task { await signIn(provider) }
                    } label: {
                        if signingIn {
                            ProgressView()
                        } else {
                            Label(provider.id == d.lumen?.ssoIdpId ? "Continue with your \(d.lumen?.displayShortName ?? "Lumen") account" : "Continue with \(provider.name)", systemImage: "person.badge.key")
                        }
                    }
                    .buttonStyle(PrimaryButtonStyle())
                    .disabled(signingIn)
                    .accessibilityIdentifier("ssoButton")
                }
                Text("You'll sign in on your server's page in a secure browser sheet. This app never sees your password or two-factor codes.")
                    .font(.footnote)
                    .foregroundStyle(c.textSubtle)
            }

            if let signup = d.lumen?.signupURL {
                Button {
                    safariURL = IdentifiedURL(url: signup)
                } label: {
                    Text("New here? Create your \(d.lumen?.displayShortName ?? "Lumen") account")
                }
                .buttonStyle(SecondaryButtonStyle())
                .accessibilityHint("Opens the account sign-up page")
            }

            HStack {
                if let privacy = d.lumen?.privacyURL {
                    Button("Privacy policy") { safariURL = IdentifiedURL(url: privacy) }
                }
                Spacer()
                if let help = d.lumen?.helpURL {
                    Button("Help") { safariURL = IdentifiedURL(url: help) }
                }
            }
            .font(.footnote)

            Button("Use a different server") {
                auth.reset()
                fieldFocused = true
            }
            .font(.footnote)
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
            self.error = "Sign-in didn't complete. Please try again."
            Diagnostics.log("Sign-in failed: \(error.localizedDescription)")
        }
    }
}
