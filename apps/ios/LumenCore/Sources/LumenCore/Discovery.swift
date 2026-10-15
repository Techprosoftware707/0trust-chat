import Foundation

/// Everything the sign-in screen needs to know about a server.
public struct ServerDiscovery: Equatable, Sendable {
    /// The server name the user entered (or the host of the URL).
    public var serverName: String
    public var homeserverURL: URL
    /// Nil on plain Matrix servers: the app then works as a generic Matrix client.
    public var lumen: LumenAppInfo?
    public var loginFlows: LoginFlows
    /// `org.matrix.simplified_msc3575` (native sliding sync), which the Rust SDK's sync needs.
    public var supportsNativeSlidingSync: Bool

    public var brandName: String { lumen?.displayName ?? LumenAppInfo.defaultBrandName }
    public var preferredProvider: LoginFlows.IdentityProvider? { loginFlows.preferredProvider(lumenIdpId: lumen?.ssoIdpId) }

    public init(serverName: String, homeserverURL: URL, lumen: LumenAppInfo?, loginFlows: LoginFlows, supportsNativeSlidingSync: Bool) {
        self.serverName = serverName
        self.homeserverURL = homeserverURL
        self.lumen = lumen
        self.loginFlows = loginFlows
        self.supportsNativeSlidingSync = supportsNativeSlidingSync
    }
}

public enum DiscoveryError: Error, Equatable, Sendable {
    case invalidInput(String)
    case invalidConfiguration(String)
    case notMatrixServer(String)
    case unreachable(String)
    case noSupportedLogin
    case noSlidingSync

    public var userMessage: String {
        switch self {
        case .invalidInput(let m): return m
        case .invalidConfiguration(let m): return "The server's configuration is invalid: \(m)"
        case .notMatrixServer(let host): return "\(host) doesn't look like a Matrix server."
        case .unreachable(let host): return "Couldn't reach \(host). Check the address and your connection."
        case .noSupportedLogin: return "This server doesn't offer a sign-in method this app supports."
        case .noSlidingSync: return "This server doesn't support the sync protocol this app needs (simplified sliding sync, Synapse 1.114 or later)."
        }
    }
}

/// Server discovery per integration.md §2.
public struct DiscoveryService: Sendable {
    public let http: HTTPClient
    public let policy: URLPolicy

    public init(http: HTTPClient, policy: URLPolicy) {
        self.http = http
        self.policy = policy
    }

    public func discover(_ input: String) async throws -> ServerDiscovery {
        let parsed: ServerInput
        do {
            parsed = try ServerInput.parse(input, policy: policy)
        } catch let e as ConfigError {
            throw DiscoveryError.invalidInput(e.message)
        }

        var serverName: String
        var baseURL: URL
        var lumen: LumenAppInfo?
        switch parsed {
        case .homeserverURL(let url):
            serverName = url.host ?? url.absoluteString
            baseURL = url
            // A homeserver URL can still serve a well-known with the Lumen block.
            if let wk = try? await fetchWellKnown(origin: url) { lumen = wk.lumen }
        case .serverName(let name):
            serverName = name
            guard let origin = URL(string: "https://\(name)") else { throw DiscoveryError.invalidInput("That doesn't look like a server name.") }
            do {
                if let wk = try await fetchWellKnown(origin: origin) {
                    baseURL = wk.homeserverURL
                    lumen = wk.lumen
                } else {
                    baseURL = origin // no well-known: try the server name itself
                }
            } catch let e as WellKnownClient.ParseError {
                throw DiscoveryError.invalidConfiguration(e.message)
            }
        }

        let versions = try await fetchVersions(baseURL: baseURL, displayHost: serverName)
        guard versions.slidingSync else { throw DiscoveryError.noSlidingSync }
        let flows = try await fetchLoginFlows(baseURL: baseURL, displayHost: serverName)
        guard !flows.sso.isEmpty || flows.password else { throw DiscoveryError.noSupportedLogin }
        return ServerDiscovery(serverName: serverName, homeserverURL: baseURL, lumen: lumen, loginFlows: flows, supportsNativeSlidingSync: versions.slidingSync)
    }

    /// Returns nil when the server has no well-known file (404 or unreachable);
    /// throws ConfigError when it has one that is invalid.
    func fetchWellKnown(origin: URL) async throws -> WellKnownClient? {
        let url = origin.appendingPathComponent(".well-known/matrix/client")
        let response: HTTPResponse
        do {
            response = try await http.send(HTTPRequest(url: url, headers: ["Accept": "application/json"]))
        } catch {
            return nil
        }
        guard response.status == 200 else { return nil }
        return try WellKnownClient.parse(response.body, policy: policy)
    }

    func fetchVersions(baseURL: URL, displayHost: String) async throws -> (versions: [String], slidingSync: Bool) {
        let url = baseURL.appendingPathComponent("_matrix/client/versions")
        let response: HTTPResponse
        do {
            response = try await http.send(HTTPRequest(url: url, headers: ["Accept": "application/json"]))
        } catch {
            throw DiscoveryError.unreachable(displayHost)
        }
        guard response.status == 200,
              let obj = (try? JSONSerialization.jsonObject(with: response.body)) as? [String: Any],
              let versions = obj["versions"] as? [String]
        else { throw DiscoveryError.notMatrixServer(displayHost) }
        let unstable = obj["unstable_features"] as? [String: Any] ?? [:]
        let sss = (unstable["org.matrix.simplified_msc3575"] as? Bool) == true
        return (versions, sss)
    }

    func fetchLoginFlows(baseURL: URL, displayHost: String) async throws -> LoginFlows {
        let url = baseURL.appendingPathComponent("_matrix/client/v3/login")
        let response: HTTPResponse
        do {
            response = try await http.send(HTTPRequest(url: url, headers: ["Accept": "application/json"]))
        } catch {
            throw DiscoveryError.unreachable(displayHost)
        }
        guard response.status == 200 else { throw DiscoveryError.notMatrixServer(displayHost) }
        do {
            return try LoginFlows.parse(response.body)
        } catch {
            throw DiscoveryError.notMatrixServer(displayHost)
        }
    }
}
