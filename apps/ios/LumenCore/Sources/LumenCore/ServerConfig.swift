import Foundation

/// The optional `io.lumen.app` block of `/.well-known/matrix/client`
/// (integration.md §2, `apps/shared/test-vectors/wellknown.json`). Only
/// version 1 is understood; every URL is validated and a malformed one is
/// dropped (nil), never followed. Unknown keys are ignored.
public struct LumenAppInfo: Equatable, Sendable {
    public static let defaultBrandName = "Lumen Secure"

    /// As sent by the server; nil when absent.
    public var brandName: String?
    public var brandShortName: String?
    public var portalURL: URL?
    public var signupURL: URL?
    public var accountURL: URL?
    /// The portal's account-deletion flow (App Store 5.1.1(v)); optional.
    public var accountDeleteURL: URL?
    public var privacyURL: URL?
    public var helpURL: URL?
    public var ssoIdpId: String?
    public var webAppURL: URL?
    public var callWidgetURL: URL?
    /// Present only when the operator enabled the Sygnal push gateway.
    public var pushGatewayURL: URL?

    /// Display name with the documented fallback ("Lumen Secure").
    public var displayName: String { brandName ?? LumenAppInfo.defaultBrandName }
    public var displayShortName: String { brandShortName ?? brandName ?? "Lumen" }

    public init(
        brandName: String? = nil, brandShortName: String? = nil,
        portalURL: URL? = nil, signupURL: URL? = nil, accountURL: URL? = nil,
        accountDeleteURL: URL? = nil,
        privacyURL: URL? = nil, helpURL: URL? = nil, ssoIdpId: String? = nil,
        webAppURL: URL? = nil, callWidgetURL: URL? = nil, pushGatewayURL: URL? = nil
    ) {
        self.brandName = brandName
        self.brandShortName = brandShortName
        self.portalURL = portalURL
        self.signupURL = signupURL
        self.accountURL = accountURL
        self.accountDeleteURL = accountDeleteURL
        self.privacyURL = privacyURL
        self.helpURL = helpURL
        self.ssoIdpId = ssoIdpId
        self.webAppURL = webAppURL
        self.callWidgetURL = callWidgetURL
        self.pushGatewayURL = pushGatewayURL
    }

    /// Parses the block. Returns nil when it is absent, not an object, or not version 1.
    /// The URLs inside always use release rules (https only), also in debug builds.
    public static func parse(_ raw: Any?) -> LumenAppInfo? {
        guard let obj = raw as? [String: Any] else { return nil }
        guard let version = obj["version"] as? NSNumber, !isBool(version), version.doubleValue == 1 else { return nil }
        let policy = URLPolicy.release
        var info = LumenAppInfo()
        if let brand = obj["brand"] as? [String: Any] {
            info.brandName = cleanName(brand["name"])
            info.brandShortName = cleanName(brand["short_name"])
        }
        info.portalURL = policy.optional(obj["portal_url"], field: "portal_url")
        info.signupURL = policy.optional(obj["signup_url"], field: "signup_url")
        info.accountURL = policy.optional(obj["account_url"], field: "account_url")
        info.accountDeleteURL = policy.optional(obj["account_delete_url"], field: "account_delete_url")
        info.privacyURL = policy.optional(obj["privacy_url"], field: "privacy_url")
        info.helpURL = policy.optional(obj["help_url"], field: "help_url")
        info.webAppURL = policy.optional(obj["web_app_url"], field: "web_app_url")
        info.callWidgetURL = policy.optional(obj["call_widget_url"], field: "call_widget_url")
        if let gw = policy.optional(obj["push_gateway_url"], field: "push_gateway_url"),
           gw.path == "/_matrix/push/v1/notify" {
            // Synapse only accepts HTTP pushers whose URL has exactly this path.
            info.pushGatewayURL = gw
        }
        if let idp = obj["sso_idp_id"] as? String, LumenAppInfo.isValidIdpId(idp) {
            info.ssoIdpId = idp
        }
        return info
    }

    /// `^[A-Za-z0-9._~-]{1,255}$`, the same rule as the web client's config validator.
    public static func isValidIdpId(_ s: String) -> Bool {
        guard (1...255).contains(s.count) else { return false }
        let allowed = Set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._~-")
        return s.allSatisfy { allowed.contains($0) }
    }

    private static func cleanName(_ raw: Any?) -> String? {
        guard let s = raw as? String else { return nil }
        let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return nil }
        // Brand names are display text: no control characters, bounded length.
        let filtered = String(String.UnicodeScalarView(t.unicodeScalars.filter { !CharacterSet.controlCharacters.contains($0) }))
        return String(filtered.prefix(64))
    }

    /// JSON `true` decodes to an NSNumber on Apple platforms; it is not a version number.
    private static func isBool(_ n: NSNumber) -> Bool {
        #if canImport(Darwin)
        return CFGetTypeID(n) == CFBooleanGetTypeID()
        #else
        return false
        #endif
    }
}

/// `/.well-known/matrix/client`, as far as the app uses it.
public struct WellKnownClient: Equatable, Sendable {
    public enum ParseError: Error, Equatable, Sendable {
        case invalidDocument
        case missingHomeserver
        case invalidHomeserver(String)

        /// The error codes used by the shared test vectors.
        public var code: String {
            switch self {
            case .invalidDocument: return "invalid_document"
            case .missingHomeserver: return "missing_homeserver"
            case .invalidHomeserver: return "invalid_homeserver"
            }
        }

        public var message: String {
            switch self {
            case .invalidDocument: return "The server's discovery file is not a JSON object."
            case .missingHomeserver: return "The server's discovery file has no homeserver address."
            case .invalidHomeserver(let m): return "The server's homeserver address is not acceptable (\(m))."
            }
        }
    }

    public var homeserverURL: URL
    public var lumen: LumenAppInfo?

    public init(homeserverURL: URL, lumen: LumenAppInfo?) {
        self.homeserverURL = homeserverURL
        self.lumen = lumen
    }

    public static func parse(_ data: Data, policy: URLPolicy) throws -> WellKnownClient {
        guard let json = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]) else {
            throw ParseError.invalidDocument
        }
        return try parse(json: json, policy: policy)
    }

    public static func parse(json: Any, policy: URLPolicy) throws -> WellKnownClient {
        guard let obj = json as? [String: Any] else { throw ParseError.invalidDocument }
        guard let hs = obj["m.homeserver"] as? [String: Any], let raw = hs["base_url"] as? String else {
            throw ParseError.missingHomeserver
        }
        let url: URL
        do {
            url = try policy.validateEndpoint(raw, field: "m.homeserver.base_url")
        } catch let e as ConfigError {
            throw ParseError.invalidHomeserver(e.message)
        }
        return WellKnownClient(homeserverURL: url, lumen: LumenAppInfo.parse(obj["io.lumen.app"]))
    }
}

/// `GET /_matrix/client/v3/login` (integration.md §2 step 3).
public struct LoginFlows: Equatable, Sendable {
    public struct IdentityProvider: Equatable, Sendable {
        public var id: String?
        public var name: String
        public init(id: String?, name: String) { self.id = id; self.name = name }
    }

    public var password: Bool
    public var token: Bool
    /// SSO providers. One entry with `id == nil` means generic SSO without a provider list.
    public var sso: [IdentityProvider]

    public init(password: Bool, token: Bool, sso: [IdentityProvider]) {
        self.password = password
        self.token = token
        self.sso = sso
    }

    public static func parse(_ data: Data) throws -> LoginFlows {
        guard let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let flows = obj["flows"] as? [[String: Any]]
        else { throw ConfigError("The server's sign-in options could not be read.") }
        var result = LoginFlows(password: false, token: false, sso: [])
        for flow in flows {
            switch flow["type"] as? String {
            case "m.login.password": result.password = true
            case "m.login.token": result.token = true
            case "m.login.sso", "m.login.cas":
                let idps = (flow["identity_providers"] as? [[String: Any]]) ?? []
                var added = false
                for p in idps {
                    guard let id = p["id"] as? String, LumenAppInfo.isValidIdpId(id) else { continue }
                    let name = (p["name"] as? String).flatMap { $0.isEmpty ? nil : String($0.prefix(64)) } ?? id
                    result.sso.append(IdentityProvider(id: id, name: name))
                    added = true
                }
                if !added && !result.sso.contains(where: { $0.id == nil }) {
                    result.sso.append(IdentityProvider(id: nil, name: "Single sign-on"))
                }
            default: continue
            }
        }
        return result
    }

    /// The provider to offer first: the operator's `sso_idp_id` if the server
    /// offers it (or offers SSO without a provider list), otherwise the first one.
    public func preferredProvider(lumenIdpId: String?) -> IdentityProvider? {
        if let want = lumenIdpId {
            if let p = sso.first(where: { $0.id == want }) { return p }
            if sso.contains(where: { $0.id == nil }) { return IdentityProvider(id: want, name: "Single sign-on") }
        }
        return sso.first
    }
}

/// Build-time configuration from Info.plist (fed by build settings).
public struct BuildConfiguration: Equatable, Sendable {
    /// `LUMEN_DEFAULT_SERVER`: a server name, not a URL. Nil means the user is asked.
    public var defaultServer: String?
    public var bundleIdentifier: String
    public var appGroup: String?
    public var keychainAccessGroup: String?
    public var pushAppId: String
    public var isDebug: Bool

    public var urlPolicy: URLPolicy { isDebug ? .debug : .release }
    /// The URL scheme used for the SSO callback and deep links (= bundle ID, RFC 8252 §7.1).
    public var urlScheme: String { bundleIdentifier }
    public var ssoRedirectBase: String { "\(urlScheme):/sso-callback" }

    public init(defaultServer: String?, bundleIdentifier: String, appGroup: String?, keychainAccessGroup: String?, pushAppId: String, isDebug: Bool) {
        self.defaultServer = defaultServer
        self.bundleIdentifier = bundleIdentifier
        self.appGroup = appGroup
        self.keychainAccessGroup = keychainAccessGroup
        self.pushAppId = pushAppId
        self.isDebug = isDebug
    }

    public init(infoDictionary info: [String: Any], isDebug: Bool) {
        func str(_ key: String) -> String? {
            guard let s = info[key] as? String else { return nil }
            let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
            // An unexpanded build setting ("$(LUMEN_DEFAULT_SERVER)") counts as empty.
            if t.isEmpty || t.hasPrefix("$(") { return nil }
            return t
        }
        var server = str("LumenDefaultServer")
        if let s = server, !ServerInput.isValidServerName(s) { server = nil }
        self.init(
            defaultServer: server?.lowercased(),
            bundleIdentifier: str("CFBundleIdentifier") ?? "io.lumen.secure",
            appGroup: str("LumenAppGroup"),
            keychainAccessGroup: str("LumenKeychainAccessGroup"),
            pushAppId: str("LumenPushAppId") ?? "io.lumen.secure.ios",
            isDebug: isDebug
        )
    }
}
