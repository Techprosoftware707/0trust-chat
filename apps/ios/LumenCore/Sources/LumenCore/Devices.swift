import Foundation

/// One entry of `GET /_matrix/client/v3/devices`.
public struct DeviceInfo: Equatable, Sendable, Identifiable {
    public var deviceId: String
    public var displayName: String?
    public var lastSeenIP: String?
    public var lastSeen: Date?
    public var id: String { deviceId }

    public init(deviceId: String, displayName: String?, lastSeenIP: String?, lastSeen: Date?) {
        self.deviceId = deviceId
        self.displayName = displayName
        self.lastSeenIP = lastSeenIP
        self.lastSeen = lastSeen
    }
}

public enum DevicesError: Error, Equatable, Sendable {
    case http(Int, String?)
    case invalidResponse
    /// User-interactive auth is required; open `fallbackURL` and retry with `session`.
    case authRequired(session: String, fallbackURL: URL)
    case unsupportedAuth([String])

    public var userMessage: String {
        switch self {
        case .http(let code, let err): return err.map { "The server refused (\($0))." } ?? "The server answered with HTTP \(code)."
        case .invalidResponse: return "The server's answer could not be read."
        case .authRequired: return "Confirm your identity to remove this device."
        case .unsupportedAuth: return "This server asks for a confirmation method this app doesn't support. Remove the device from another app or the account portal."
        }
    }
}

/// `/devices` (integration.md §3). Removal uses user-interactive auth with
/// the `m.login.sso` fallback page, opened in the system browser.
public struct DevicesAPI: Sendable {
    public let http: HTTPClient
    public let homeserverURL: URL
    public let accessToken: @Sendable () async throws -> String

    public init(http: HTTPClient, homeserverURL: URL, accessToken: @escaping @Sendable () async throws -> String) {
        self.http = http
        self.homeserverURL = homeserverURL
        self.accessToken = accessToken
    }

    public func list() async throws -> [DeviceInfo] {
        let url = homeserverURL.appendingPathComponent("_matrix/client/v3/devices")
        let r = try await http.send(HTTPRequest(url: url, headers: try await headers()))
        guard r.status == 200 else { throw DevicesError.http(r.status, DevicesAPI.errcode(r.body)) }
        return try DevicesAPI.parseList(r.body)
    }

    /// Deletes a device. Without `uiaSession` the server normally answers 401
    /// with a UIA session, surfaced as `.authRequired`.
    public func delete(deviceId: String, uiaSession: String?) async throws {
        let url = try deviceURL(deviceId)
        var body: [String: Any] = [:]
        if let s = uiaSession { body["auth"] = ["session": s] }
        let data = try JSONSerialization.data(withJSONObject: body)
        var h = try await headers()
        h["Content-Type"] = "application/json"
        let r = try await http.send(HTTPRequest(method: "DELETE", url: url, headers: h, body: data))
        switch r.status {
        case 200: return
        case 401: throw DevicesAPI.authError(fromBody: r.body, homeserverURL: homeserverURL)
        default: throw DevicesError.http(r.status, DevicesAPI.errcode(r.body))
        }
    }

    /// `PUT /devices/{id}` with a new display name.
    public func rename(deviceId: String, displayName: String) async throws {
        let url = try deviceURL(deviceId)
        let data = try JSONSerialization.data(withJSONObject: ["display_name": displayName])
        var h = try await headers()
        h["Content-Type"] = "application/json"
        let r = try await http.send(HTTPRequest(method: "PUT", url: url, headers: h, body: data))
        guard r.status == 200 else { throw DevicesError.http(r.status, DevicesAPI.errcode(r.body)) }
    }

    private func deviceURL(_ deviceId: String) throws -> URL {
        let encoded = deviceId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/?#"))) ?? deviceId
        guard let url = URL(string: homeserverURL.absoluteString + "/_matrix/client/v3/devices/" + encoded) else { throw DevicesError.invalidResponse }
        return url
    }

    private func headers() async throws -> [String: String] {
        ["Authorization": "Bearer \(try await accessToken())", "Accept": "application/json"]
    }

    static func parseList(_ data: Data) throws -> [DeviceInfo] {
        guard let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let devices = obj["devices"] as? [[String: Any]]
        else { throw DevicesError.invalidResponse }
        return devices.compactMap { d in
            guard let id = d["device_id"] as? String, !id.isEmpty else { return nil }
            var seen: Date?
            if let ts = d["last_seen_ts"] as? NSNumber { seen = Date(timeIntervalSince1970: ts.doubleValue / 1000) }
            return DeviceInfo(deviceId: id, displayName: d["display_name"] as? String, lastSeenIP: d["last_seen_ip"] as? String, lastSeen: seen)
        }.sorted { ($0.lastSeen ?? .distantPast) > ($1.lastSeen ?? .distantPast) }
    }

    /// Interprets a 401 answer: an SSO-only UIA flow becomes `.authRequired` with the fallback page.
    public static func authError(fromBody data: Data, homeserverURL: URL) -> DevicesError {
        guard let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let session = obj["session"] as? String, !session.isEmpty
        else { return .http(401, DevicesAPI.errcode(data)) }
        let flows = (obj["flows"] as? [[String: Any]]) ?? []
        let stages = flows.compactMap { $0["stages"] as? [String] }
        let ssoOnly = stages.contains { $0 == ["m.login.sso"] || $0 == ["m.login.cas"] }
        guard ssoOnly else { return .unsupportedAuth(stages.flatMap { $0 }) }
        let stage = stages.first { $0 == ["m.login.sso"] } != nil ? "m.login.sso" : "m.login.cas"
        return .authRequired(session: session, fallbackURL: fallbackURL(homeserverURL: homeserverURL, stage: stage, session: session))
    }

    public static func fallbackURL(homeserverURL: URL, stage: String, session: String) -> URL {
        var c = URLComponents(url: homeserverURL.appendingPathComponent("_matrix/client/v3/auth/\(stage)/fallback/web"), resolvingAgainstBaseURL: false)!
        c.queryItems = [URLQueryItem(name: "session", value: session)]
        return c.url!
    }

    static func errcode(_ data: Data) -> String? {
        ((try? JSONSerialization.jsonObject(with: data)) as? [String: Any])?["errcode"] as? String
    }
}

/// "Lumen on iPhone" (integration.md §3).
public enum DeviceDisplayName {
    public static func make(brandShortName: String, deviceModel: String) -> String {
        let brand = brandShortName.trimmingCharacters(in: .whitespacesAndNewlines)
        let model = deviceModel.trimmingCharacters(in: .whitespacesAndNewlines)
        return "\(brand.isEmpty ? "Lumen" : brand) on \(model.isEmpty ? "iOS" : model)"
    }
}

/// Redacts secrets and identifiers from diagnostic text (integration.md §9:
/// no tokens, keys, message bodies or room names in logs).
public enum LogRedactor {
    public static func redact(_ s: String) -> String {
        var out = s
        let patterns: [(String, String)] = [
            (#"(?i)(bearer\s+)[A-Za-z0-9._~+/=-]+"#, "$1<redacted>"),
            (#"(?i)(access_token|refresh_token|loginToken|login_token|token)=([^&\s"]+)"#, "$1=<redacted>"),
            (#"(?i)"(access_token|refresh_token|password|recovery_key|passphrase)"\s*:\s*"[^"]*""#, "\"$1\":\"<redacted>\""),
            (#"\bsy[tr]_[A-Za-z0-9_]+"#, "<redacted-token>"),
            (#"@[A-Za-z0-9._=/+-]+:[A-Za-z0-9.-]+(:\d+)?"#, "<user>"),
            (#"![A-Za-z0-9._~-]+(:[A-Za-z0-9.-]+)?"#, "<room>"),
            (#"\$[A-Za-z0-9._~+/-]{8,}"#, "<event>"),
            (#"\bE[sS][A-Za-z0-9]{2}( ?[A-Za-z0-9]{4}){11}\b"#, "<recovery-key>"),
        ]
        for (p, r) in patterns {
            guard let re = try? NSRegularExpression(pattern: p) else { continue }
            out = re.stringByReplacingMatches(in: out, range: NSRange(out.startIndex..., in: out), withTemplate: r)
        }
        return out
    }
}
