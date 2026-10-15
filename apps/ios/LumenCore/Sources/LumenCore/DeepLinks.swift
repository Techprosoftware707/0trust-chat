import Foundation

/// Matrix identifier checks (same rules as the web client's `lib/matrix-id.ts`).
public enum MatrixID {
    public static func isValidUserId(_ s: String) -> Bool {
        guard s.count <= 255, s.hasPrefix("@"), let colon = s.firstIndex(of: ":") else { return false }
        let local = s[s.index(after: s.startIndex)..<colon]
        let server = s[s.index(after: colon)...]
        let localAllowed = Set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._=-/+")
        return !local.isEmpty && local.allSatisfy { localAllowed.contains($0) } && isValidServerPart(server)
    }

    /// `!opaque` (room version 12+) or `!opaque:server`.
    public static func isValidRoomId(_ s: String) -> Bool {
        guard s.count <= 255, s.hasPrefix("!"), s.count > 1 else { return false }
        guard !s.contains(where: { $0.isWhitespace }) else { return false }
        if let colon = s.firstIndex(of: ":") {
            let local = s[s.index(after: s.startIndex)..<colon]
            return !local.isEmpty && !s[s.index(after: colon)...].isEmpty
        }
        return true
    }

    public static func isValidRoomAlias(_ s: String) -> Bool {
        guard s.count <= 255, s.hasPrefix("#"), let colon = s.firstIndex(of: ":") else { return false }
        let local = s[s.index(after: s.startIndex)..<colon]
        guard !local.isEmpty, !s.contains(where: { $0.isWhitespace }) else { return false }
        return isValidServerPart(s[s.index(after: colon)...])
    }

    public static func isValidEventId(_ s: String) -> Bool {
        s.count <= 255 && s.hasPrefix("$") && s.count > 1 && !s.contains(where: { $0.isWhitespace })
    }

    private static func isValidServerPart(_ s: Substring) -> Bool {
        let allowed = Set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.-:[]")
        return !s.isEmpty && s.allSatisfy { allowed.contains($0) }
    }

    /// "alice" or "@alice" -> "@alice:<defaultServer>"; nil if it can't be a valid user ID.
    public static func normaliseUserIdInput(_ input: String, defaultServer: String) -> String? {
        var s = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !s.isEmpty else { return nil }
        if !s.hasPrefix("@") { s = "@" + s }
        if !s.contains(":") { s += ":\(defaultServer)" }
        return isValidUserId(s) ? s : nil
    }

    public static func serverName(ofUserId userId: String) -> String? {
        guard let i = userId.firstIndex(of: ":") else { return nil }
        return String(userId[userId.index(after: i)...])
    }
}

/// Where an incoming URL leads. Opening a room or user always asks the user
/// first; this type only parses.
public enum DeepLinkRoute: Equatable, Sendable {
    case ssoCallback(loginToken: String, callbackURL: URL)
    /// A room ID (`!…`) or alias (`#…`), with optional event and via servers.
    case room(id: String, eventId: String?, via: [String])
    case user(id: String)
    /// `https://<portal>/invite/<token>/`: a portal workspace invitation, opened in the browser.
    case portalInvite(URL)
    case reject
}

/// Parses deep links (integration.md §8, `apps/shared/test-vectors/deeplinks.json`).
public struct DeepLinkRouter: Sendable {
    /// The app's URL scheme (= bundle ID).
    public var appScheme: String
    /// Host of the server's `web_app_url` (`https://<host>/#/room/<id>` links), if known.
    public var webAppHost: String?
    /// Host of the server's `portal_url` (invitation links), if known.
    public var portalHost: String?

    public init(appScheme: String, webAppHost: String? = nil, portalHost: String? = nil) {
        self.appScheme = appScheme.lowercased()
        self.webAppHost = webAppHost?.lowercased()
        self.portalHost = portalHost?.lowercased()
    }

    /// The query parameter carrying the per-attempt SSO nonce.
    public static let nonceParameter = "n"

    public func route(_ raw: String, pendingSsoNonce: String?) -> DeepLinkRoute {
        let s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let colon = s.firstIndex(of: ":") else { return .reject }
        let scheme = s[..<colon].lowercased()
        let rest = String(s[s.index(after: colon)...])
        switch scheme {
        case appScheme:
            return routeAppScheme(s, rest: rest, pendingSsoNonce: pendingSsoNonce)
        case "matrix":
            return routeMatrixURI(rest)
        case "https":
            return routeHTTPS(s)
        default:
            return .reject
        }
    }

    // MARK: - io.lumen.secure:/sso-callback?n=…&loginToken=…

    private func routeAppScheme(_ full: String, rest: String, pendingSsoNonce: String?) -> DeepLinkRoute {
        // Accept "scheme:/sso-callback" and the authority form "scheme://sso-callback".
        var path = rest
        var query = ""
        if let q = path.firstIndex(of: "?") {
            query = String(path[path.index(after: q)...])
            path = String(path[..<q])
        }
        if let h = query.firstIndex(of: "#") { query = String(query[..<h]) }
        guard path == "/sso-callback" || path == "//sso-callback" || path == "//sso-callback/" else { return .reject }
        guard let pending = pendingSsoNonce, !pending.isEmpty else { return .reject }
        let params = DeepLinkRouter.queryItems(query)
        guard let nonce = params.first(where: { $0.name == DeepLinkRouter.nonceParameter })?.value,
              DeepLinkRouter.constantTimeEquals(nonce, pending)
        else { return .reject }
        guard let token = params.first(where: { $0.name == "loginToken" })?.value, !token.isEmpty,
              let url = URL(string: full)
        else { return .reject }
        return .ssoCallback(loginToken: token, callbackURL: url)
    }

    // MARK: - matrix: URIs (MSC2312)

    private func routeMatrixURI(_ rest: String) -> DeepLinkRoute {
        var body = rest
        var query = ""
        if let q = body.firstIndex(of: "?") {
            query = String(body[body.index(after: q)...])
            body = String(body[..<q])
        }
        if body.hasPrefix("//") { return .reject } // authority form is not used by matrix: URIs
        let segments = body.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        guard segments.count >= 2, let ident = segments[1].removingPercentEncoding else { return .reject }
        let via = DeepLinkRouter.queryItems(query).filter { $0.name == "via" }.compactMap(\.value)
        var eventId: String?
        if segments.count >= 4, segments[2] == "e", let e = segments[3].removingPercentEncoding {
            eventId = MatrixID.isValidEventId("$" + e) ? "$" + e : nil
        }
        switch segments[0] {
        case "u":
            let id = "@" + ident
            return segments.count == 2 && MatrixID.isValidUserId(id) ? .user(id: id) : .reject
        case "r":
            let id = "#" + ident
            return MatrixID.isValidRoomAlias(id) ? .room(id: id, eventId: eventId, via: via) : .reject
        case "roomid":
            let id = "!" + ident
            return MatrixID.isValidRoomId(id) ? .room(id: id, eventId: eventId, via: via) : .reject
        default:
            return .reject
        }
    }

    // MARK: - https: matrix.to, web app room links, portal invites

    private func routeHTTPS(_ s: String) -> DeepLinkRoute {
        // Split off the fragment by hand: matrix.to fragments contain a second '#'
        // (aliases), which strict URL parsers reject.
        let beforeFragment: String
        let fragment: String?
        if let hash = s.firstIndex(of: "#") {
            beforeFragment = String(s[..<hash])
            fragment = String(s[s.index(after: hash)...])
        } else {
            beforeFragment = s
            fragment = nil
        }
        guard let comps = URLComponents(string: beforeFragment), comps.scheme?.lowercased() == "https",
              comps.user == nil, comps.password == nil, comps.port == nil,
              let host = comps.host?.lowercased()
        else { return .reject }

        if host == "matrix.to" {
            guard comps.path.isEmpty || comps.path == "/", let frag = fragment else { return .reject }
            return routeMatrixTo(fragment: frag)
        }
        if let webHost = webAppHost, host == webHost, let frag = fragment {
            // "#/room/<id>" as produced by the web client's roomHash().
            guard frag.hasPrefix("/room/") else { return .reject }
            let raw = String(frag.dropFirst("/room/".count))
            guard let id = raw.removingPercentEncoding, MatrixID.isValidRoomId(id) || MatrixID.isValidRoomAlias(id) else { return .reject }
            return .room(id: id, eventId: nil, via: [])
        }
        if let portal = portalHost, host == portal, fragment == nil {
            let parts = comps.path.split(separator: "/")
            if parts.count == 2, parts[0] == "invite",
               parts[1].allSatisfy({ $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" }),
               let url = comps.url {
                return .portalInvite(url)
            }
        }
        return .reject
    }

    private func routeMatrixTo(fragment: String) -> DeepLinkRoute {
        guard fragment.hasPrefix("/") else { return .reject }
        var body = String(fragment.dropFirst())
        var query = ""
        if let q = body.firstIndex(of: "?") {
            query = String(body[body.index(after: q)...])
            body = String(body[..<q])
        }
        let parts = body.split(separator: "/", maxSplits: 1, omittingEmptySubsequences: false).map(String.init)
        guard let first = parts.first, let ident = first.removingPercentEncoding else { return .reject }
        let via = DeepLinkRouter.queryItems(query).filter { $0.name == "via" }.compactMap(\.value)
        var eventId: String?
        if parts.count == 2, let e = parts[1].removingPercentEncoding, MatrixID.isValidEventId(e) { eventId = e }
        if ident.hasPrefix("@") {
            return parts.count == 1 && MatrixID.isValidUserId(ident) ? .user(id: ident) : .reject
        }
        if MatrixID.isValidRoomAlias(ident) || (MatrixID.isValidRoomId(ident) && ident.hasPrefix("!")) {
            return .room(id: ident, eventId: eventId, via: via)
        }
        return .reject
    }

    // MARK: - helpers

    static func queryItems(_ query: String) -> [URLQueryItem] {
        guard !query.isEmpty else { return [] }
        return query.split(separator: "&").map { pair in
            let kv = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
            let name = String(kv[0]).removingPercentEncoding ?? String(kv[0])
            let value = kv.count > 1 ? (String(kv[1]).replacingOccurrences(of: "+", with: " ").removingPercentEncoding ?? String(kv[1])) : nil
            return URLQueryItem(name: name, value: value)
        }
    }

    static func constantTimeEquals(_ a: String, _ b: String) -> Bool {
        let x = Array(a.utf8), y = Array(b.utf8)
        guard x.count == y.count else { return false }
        var diff: UInt8 = 0
        for i in 0..<x.count { diff |= x[i] ^ y[i] }
        return diff == 0
    }
}

/// One SSO attempt: a random nonce stored before the browser opens. A
/// callback is accepted once, only while the attempt is pending, and only
/// with the matching nonce (integration.md §8).
public struct SSOAttempt: Equatable, Sendable {
    public let nonce: String
    public let redirectURL: String

    /// - Parameter redirectBase: `io.lumen.secure:/sso-callback`
    public init(redirectBase: String, nonce: String = SSOAttempt.makeNonce()) {
        self.nonce = nonce
        // Synapse's sso.client_whitelist matches by prefix, so the extra
        // parameter keeps the whitelisted redirect URI.
        self.redirectURL = "\(redirectBase)?\(DeepLinkRouter.nonceParameter)=\(nonce)"
    }

    /// 128 bits from the system CSPRNG, hex.
    public static func makeNonce() -> String {
        var g = SystemRandomNumberGenerator()
        return (0..<16).map { _ in String(format: "%02x", UInt8.random(in: 0...255, using: &g)) }.joined()
    }
}
