import Foundation

/// Errors raised while validating configuration and discovery data.
public struct ConfigError: Error, Equatable, CustomStringConvertible, Sendable {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var description: String { message }
}

/// Which URLs the app is willing to follow (integration.md §2, ADR 0003 D6).
///
/// - `https` only;
/// - no user-info (`https://user:pass@host`);
/// - plain `http` only for loopback hosts, and only when `allowLoopbackHTTP`
///   is set (debug builds).
public struct URLPolicy: Sendable, Equatable {
    public var allowLoopbackHTTP: Bool

    public init(allowLoopbackHTTP: Bool) {
        self.allowLoopbackHTTP = allowLoopbackHTTP
    }

    /// Release builds: https only.
    public static let release = URLPolicy(allowLoopbackHTTP: false)
    /// Debug builds: https, plus http to loopback for local development servers.
    public static let debug = URLPolicy(allowLoopbackHTTP: true)

    /// Validates an absolute http(s) URL and returns it, or throws.
    public func validate(_ raw: String, field: String) throws -> URL {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty,
              let components = URLComponents(string: trimmed),
              let scheme = components.scheme?.lowercased(),
              let url = components.url
        else {
            throw ConfigError("\"\(field)\" is not a valid URL")
        }
        guard scheme == "https" || scheme == "http" else {
            throw ConfigError("\"\(field)\" must be an https URL")
        }
        guard let host = components.host, !host.isEmpty else {
            throw ConfigError("\"\(field)\" has no host")
        }
        if components.user != nil || components.password != nil || components.percentEncodedUser != nil {
            throw ConfigError("\"\(field)\" must not contain credentials")
        }
        if scheme == "http" {
            guard allowLoopbackHTTP, URLPolicy.isLoopbackHost(host) else {
                throw ConfigError("\"\(field)\" must use https")
            }
        }
        return url
    }

    /// Validates a server endpoint (homeserver base URL) and normalises it:
    /// lowercase scheme and host, no query or fragment, no trailing slash.
    public func validateEndpoint(_ raw: String, field: String) throws -> URL {
        let url = try validate(raw, field: field)
        guard var c = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            throw ConfigError("\"\(field)\" is not a valid URL")
        }
        c.scheme = c.scheme?.lowercased()
        if let h = c.percentEncodedHost { c.percentEncodedHost = h.lowercased() }
        c.query = nil
        c.fragment = nil
        var path = c.percentEncodedPath
        while path.hasSuffix("/") { path.removeLast() }
        c.percentEncodedPath = path
        guard let out = c.url else { throw ConfigError("\"\(field)\" is not a valid URL") }
        return out
    }

    /// The shared-vector contract (`apps/shared/test-vectors/url-validation.json`):
    /// the normalised URL string, or nil when the URL is not acceptable.
    public static func validateEndpointURL(_ raw: String, debug: Bool) -> String? {
        let policy = URLPolicy(allowLoopbackHTTP: debug)
        return (try? policy.validateEndpoint(raw, field: "url"))?.absoluteString
    }

    /// Like `validate`, but returns nil for a missing or invalid value: a bad
    /// optional link must not break the app; it is simply not shown.
    public func optional(_ raw: Any?, field: String) -> URL? {
        guard let s = raw as? String else { return nil }
        return try? validate(s, field: field)
    }

    public static func isLoopbackHost(_ host: String) -> Bool {
        let h = host.lowercased()
        return h == "localhost" || h == "127.0.0.1" || h == "::1" || h == "[::1]" || h.hasSuffix(".localhost")
    }

    /// Normalises a homeserver base URL: no query, no fragment, no trailing slash.
    public static func normaliseBaseURL(_ url: URL) -> URL {
        guard var c = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return url }
        c.query = nil
        c.fragment = nil
        var path = c.path
        while path.hasSuffix("/") { path.removeLast() }
        c.path = path
        return c.url ?? url
    }
}

/// What the user typed into the server field.
public enum ServerInput: Equatable, Sendable {
    /// A server name (`example.com`, `example.com:8448`), possibly taken from a Matrix ID.
    case serverName(String)
    /// A full homeserver URL (`https://matrix.example.com`).
    case homeserverURL(URL)

    /// Parses user input, mirroring the web client's `discoverHomeserver`.
    public static func parse(_ input: String, policy: URLPolicy) throws -> ServerInput {
        let s = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !s.isEmpty else { throw ConfigError("Enter a server name, for example example.org") }
        let lower = s.lowercased()
        if lower.hasPrefix("https://") || lower.hasPrefix("http://") {
            do {
                return .homeserverURL(try policy.validateEndpoint(s, field: "server"))
            } catch let e as ConfigError {
                throw ConfigError(e.message.replacingOccurrences(of: "\"server\"", with: "The server address"))
            }
        }
        // "@alice:example.org" or "alice:example.org" -> "example.org"; strip any path.
        var domain = s
        if domain.hasPrefix("@"), let colon = domain.firstIndex(of: ":") {
            domain = String(domain[domain.index(after: colon)...])
        }
        if let slash = domain.firstIndex(of: "/") { domain = String(domain[..<slash]) }
        guard ServerInput.isValidServerName(domain) else {
            throw ConfigError("That doesn't look like a server name.")
        }
        return .serverName(domain.lowercased())
    }

    /// `host` or `host:port`, DNS characters only (like the web client).
    public static func isValidServerName(_ s: String) -> Bool {
        guard !s.isEmpty, s.count <= 255 else { return false }
        let parts = s.split(separator: ":", omittingEmptySubsequences: false)
        guard parts.count <= 2 else { return false }
        let host = parts[0]
        guard !host.isEmpty, !host.hasPrefix("."), !host.hasPrefix("-") else { return false }
        let allowed = Set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.-")
        guard host.allSatisfy({ allowed.contains($0) }) else { return false }
        if parts.count == 2 {
            guard let port = Int(parts[1]), (1...65535).contains(port), parts[1].count <= 5 else { return false }
        }
        return true
    }
}
