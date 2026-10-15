import Foundation
import LumenCore
import MatrixRustSDK
import Observation

/// Opens the sign-in page in the system browser (ASWebAuthenticationSession
/// on iOS) and returns the callback URL.
@MainActor
protocol WebAuthenticating {
    func authenticate(url: URL, callbackScheme: String) async throws -> URL
}

enum WebAuthenticationError: Error, Equatable {
    case cancelled
    case failed(String)
}

/// Server picker and SSO sign-in (integration.md §2–3).
@Observable @MainActor
final class AuthModel {
    enum Phase: Equatable {
        case idle
        case discovering
        case ready(ServerDiscovery)
        case signingIn(ServerDiscovery)
        case failed(String)
    }

    var serverInput: String
    private(set) var phase: Phase = .idle
    /// The nonce of the SSO attempt in progress; deep links are checked against it.
    private(set) var pendingSsoNonce: String?

    @ObservationIgnored private let build: BuildConfiguration
    @ObservationIgnored private let discoveryService: DiscoveryService
    @ObservationIgnored private let factory: ClientFactory
    @ObservationIgnored private let accountStore: AccountStoring
    @ObservationIgnored private let http: HTTPClient

    init(build: BuildConfiguration, http: HTTPClient, factory: ClientFactory, accountStore: AccountStoring) {
        self.build = build
        self.http = http
        self.discoveryService = DiscoveryService(http: http, policy: build.urlPolicy)
        self.factory = factory
        self.accountStore = accountStore
        self.serverInput = build.defaultServer ?? ""
    }

    var discovery: ServerDiscovery? {
        switch phase {
        case .ready(let d), .signingIn(let d): return d
        default: return nil
        }
    }

    func discover() async {
        phase = .discovering
        do {
            phase = .ready(try await discoveryService.discover(serverInput))
        } catch let e as DiscoveryError {
            phase = .failed(e.userMessage)
        } catch {
            phase = .failed("Couldn't reach that server.")
        }
    }

    func reset() {
        phase = .idle
    }

    /// SSO: `startSsoLogin` → system browser → callback (nonce checked) →
    /// `SsoHandler.finish`. Returns the stored account and the logged-in client.
    func signInWithSSO(provider: LoginFlows.IdentityProvider?, web: WebAuthenticating, deviceModel: String) async throws -> (StoredAccount, Client) {
        guard let d = discovery else { throw WebAuthenticationError.failed("No server selected.") }
        phase = .signingIn(d)
        let storeID = StoredAccount.makeStoreID()
        let passphrase = StoredAccount.makeStorePassphrase()
        do {
            let client = try await factory.newClient(homeserverURL: d.homeserverURL, storeID: storeID, passphrase: passphrase)
            let attempt = SSOAttempt(redirectBase: build.ssoRedirectBase)
            pendingSsoNonce = attempt.nonce
            defer { pendingSsoNonce = nil }
            let handler = try await client.startSsoLogin(redirectUrl: attempt.redirectURL, idpId: provider?.id)
            guard let url = URL(string: handler.url()), (try? build.urlPolicy.validate(url.absoluteString, field: "sso")) != nil else {
                throw WebAuthenticationError.failed("The server returned an invalid sign-in address.")
            }
            let callback = try await web.authenticate(url: url, callbackScheme: build.urlScheme)
            let router = DeepLinkRouter(appScheme: build.urlScheme)
            guard case .ssoCallback(_, let callbackURL) = router.route(callback.absoluteString, pendingSsoNonce: attempt.nonce) else {
                throw WebAuthenticationError.failed("The sign-in response wasn't valid. Please try again.")
            }
            try await handler.finish(callbackUrl: callbackURL.absoluteString)
            let session = try client.session()
            let account = StoredAccount.from(session: session, storeID: storeID, passphrase: passphrase, serverName: d.serverName, lumen: d.lumen)
            try accountStore.save(account)
            await nameDevice(account: account, brand: d.lumen?.displayShortName ?? "Lumen", deviceModel: deviceModel)
            phase = .ready(d)
            return (account, client)
        } catch {
            factory.paths.wipe(storeID: storeID)
            phase = .ready(d)
            throw error
        }
    }

    /// The SSO login API has no device-name parameter; name the device
    /// "Lumen on iPhone" afterwards (best effort).
    private func nameDevice(account: StoredAccount, brand: String, deviceModel: String) async {
        guard let base = URL(string: account.homeserverURL) else { return }
        let api = DevicesAPI(http: http, homeserverURL: base, accessToken: { account.accessToken })
        try? await api.rename(deviceId: account.deviceId, displayName: DeviceDisplayName.make(brandShortName: brand, deviceModel: deviceModel))
    }

    /// Restores the stored session, if any.
    static func restore(store: AccountStoring, factory: ClientFactory) async throws -> (StoredAccount, Client)? {
        guard let account = store.load() else { return nil }
        let client = try await factory.restoredClient(account: account, store: store, role: .app)
        return (account, client)
    }
}
