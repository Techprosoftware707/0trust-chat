import Foundation

/// The two MatrixRTC widget-API actions the native layer answers itself,
/// because the Rust SDK's widget driver (matrix-rust-components-swift
/// 26.10.02 = matrix-rust-sdk 4f7f4d49) can't serve them against a Lumen
/// server. Ported from `tests/apps/widget-harness/src/native_rtc.rs`, which
/// proved a real end-to-end encrypted call with the same driver behaviour.
///
/// 1. `org.matrix.msc4533.rtc_livekit_get_token` (MSC4533). The Lumen call
///    widget (matrix-js-sdk 44 `RoomWidgetClient`) asks its host for the
///    LiveKit SFU token. The driver has no such action and doesn't list
///    `org.matrix.msc4533` in `supported_api_versions`. The OpenID route is
///    not a substitute: lk-jwt-service derives a different LiveKit identity
///    there than on the homeserver-proxied MSC4195 endpoint that web clients
///    use.
/// 2. `org.matrix.msc4515.get_rtc_transports` (MSC4515). The driver
///    implements it, but the ruma it uses (rev f5e5e1c8) parses only
///    `{type: "livekit", livekit_service_url}` and rejects Lumen's MSC4195
///    `{type: "livekit", url}`, failing the whole response.
///
/// So, next to `WidgetDriverHandle`, this type:
/// - adds `org.matrix.msc4533` to the driver's `supported_api_versions` answer;
/// - grants `org.matrix.msc4533.rtc_livekit_get_token` only if the widget
///   asked for it in capability negotiation (added to the driver's
///   `notify_capabilities`);
/// - answers `rtc_livekit_get_token` with
///   `POST /_matrix/client/unstable/io.element.msc4195/rtc/livekit/get_token`
///   (the request data as the body, verbatim) using the session's access
///   token, only for the driver's own room and this device's member ID
///   (`<user>:<device>`). The widget receives the homeserver's response (a
///   room-scoped SFU JWT), never the access token;
/// - answers `get_rtc_transports`, if the driver approved
///   `org.matrix.msc4515.rtc_transports`, from
///   `GET /_matrix/client/unstable/org.matrix.msc4143/rtc/transports`
///   (verbatim; entries without a string `type` are dropped).
public final class NativeRtcInterceptor: @unchecked Sendable {
    public static let msc4533ApiVersion = "org.matrix.msc4533"
    public static let getTokenAction = "org.matrix.msc4533.rtc_livekit_get_token"
    public static let getTransportsAction = "org.matrix.msc4515.get_rtc_transports"
    public static let transportsCapability = "org.matrix.msc4515.rtc_transports"
    static let getTokenPath = "_matrix/client/unstable/io.element.msc4195/rtc/livekit/get_token"
    static let transportsPath = "_matrix/client/unstable/org.matrix.msc4143/rtc/transports"

    public enum FromWidgetDecision: Equatable, Sendable {
        /// Pass the message to the SDK's widget driver unchanged.
        case forward
        /// A request this type answers itself (see `answer(_:)`).
        case intercepted(String)
    }

    public let widgetId: String
    public let roomId: String
    public let memberId: String
    private let homeserverURL: URL
    private let http: HTTPClient
    private let accessToken: @Sendable () async throws -> String
    private let lock = NSLock()
    private var tokenCapabilityRequested = false
    private var transportsCapabilityApproved = false

    public init(widgetId: String, roomId: String, userId: String, deviceId: String, homeserverURL: URL, http: HTTPClient, accessToken: @escaping @Sendable () async throws -> String) {
        self.widgetId = widgetId
        self.roomId = roomId
        self.memberId = "\(userId):\(deviceId)"
        self.homeserverURL = homeserverURL
        self.http = http
        self.accessToken = accessToken
    }

    public var tokenGranted: Bool { lock.withLock { tokenCapabilityRequested } }
    public var transportsApproved: Bool { lock.withLock { transportsCapabilityApproved } }

    // MARK: - Widget -> driver

    public func onFromWidget(_ raw: String) -> FromWidgetDecision {
        guard let v = Self.object(raw), v["widgetId"] as? String == widgetId else { return .forward }
        let api = v["api"] as? String
        let action = v["action"] as? String
        let isResponse = v["response"] != nil

        // The widget's answer to the driver's `capabilities` request.
        if api == "toWidget", action == "capabilities", isResponse {
            let caps = ((v["response"] as? [String: Any])?["capabilities"] as? [Any]) ?? []
            let asked = caps.contains { $0 as? String == Self.getTokenAction }
            lock.withLock { tokenCapabilityRequested = asked }
        }

        if api == "fromWidget", !isResponse, action == Self.getTokenAction || action == Self.getTransportsAction {
            return .intercepted(raw)
        }
        return .forward
    }

    // MARK: - Driver -> widget

    /// Returns the (possibly amended) driver message. Messages that need no
    /// change are returned byte for byte.
    public func onToWidget(_ raw: String) -> String {
        guard var v = Self.object(raw) else { return raw }
        let api = v["api"] as? String
        let action = v["action"] as? String
        var changed = false

        // The driver's answer to the widget's `supported_api_versions` request.
        if api == "fromWidget", action == "supported_api_versions",
           var response = v["response"] as? [String: Any],
           var versions = response["supported_versions"] as? [Any] {
            if !versions.contains(where: { $0 as? String == Self.msc4533ApiVersion }) {
                versions.append(Self.msc4533ApiVersion)
                response["supported_versions"] = versions
                v["response"] = response
                changed = true
            }
        }

        // The driver tells the widget which capabilities were approved.
        if api == "toWidget", action == "notify_capabilities",
           var data = v["data"] as? [String: Any],
           var approved = data["approved"] as? [Any] {
            let has: ([Any], String) -> Bool = { list, c in list.contains { $0 as? String == c } }
            let requested = lock.withLock { () -> Bool in
                transportsCapabilityApproved = has(approved, Self.transportsCapability)
                return tokenCapabilityRequested
            }
            if requested, !has(approved, Self.getTokenAction) {
                approved.append(Self.getTokenAction)
                data["approved"] = approved
                v["data"] = data
                changed = true
            }
        }

        guard changed, let out = Self.string(v) else { return raw }
        return out
    }

    // MARK: - Answers

    /// Answers an intercepted request; returns the widget-API response message.
    public func answer(_ raw: String) async -> String {
        guard var request = Self.object(raw) else { return raw }
        let action = request["action"] as? String ?? ""
        let data = request["data"]
        let result: Outcome
        switch action {
        case Self.getTokenAction: result = await getToken(data)
        case Self.getTransportsAction: result = await getTransports()
        default: result = .refused(Outcome.refusal("Unknown action"))
        }
        switch result {
        case .answered(let body): request["response"] = body
        case .refused(let error): request["response"] = ["error": error]
        }
        return Self.string(request) ?? raw
    }

    /// The widget-API response body, or the `error` object of a refusal.
    enum Outcome {
        case answered([String: Any])
        case refused([String: Any])

        static func refusal(_ message: String) -> [String: Any] { ["message": message] }
    }

    private func getTransports() async -> Outcome {
        guard transportsApproved else { return .refused(Outcome.refusal("Missing capability")) }
        switch await homeserverRequest("GET", Self.transportsPath, body: nil) {
        case .refused(let e): return .refused(e)
        case .answered(let body):
            let transports = ((body["rtc_transports"] as? [Any]) ?? []).filter { (($0 as? [String: Any])?["type"] as? String) != nil }
            guard !transports.isEmpty else { return .refused(Outcome.refusal("The homeserver does not advertise any RTC transport")) }
            return .answered(["rtc_transports": transports])
        }
    }

    private func getToken(_ data: Any?) async -> Outcome {
        guard tokenGranted else { return .refused(Outcome.refusal("Missing capability")) }
        guard let body = data as? [String: Any] else { return .refused(Outcome.refusal("Invalid request body")) }
        guard body["room_id"] as? String == roomId else { return .refused(Outcome.refusal("Tokens are only issued for the widget's own room")) }
        guard body["member_id"] as? String == memberId else { return .refused(Outcome.refusal("Tokens are only issued for this device's call membership")) }
        switch await homeserverRequest("POST", Self.getTokenPath, body: body) {
        case .refused(let e): return .refused(e)
        case .answered(let res):
            guard res["jwt"] is String else { return .refused(Outcome.refusal("The homeserver returned no token")) }
            return .answered(res)
        }
    }

    /// An authenticated client-server API call. The access token goes only
    /// into the Authorization header, never into anything the widget sees.
    private func homeserverRequest(_ method: String, _ path: String, body: [String: Any]?) async -> Outcome {
        let token: String
        do { token = try await accessToken() } catch { return .refused(Outcome.refusal("Not logged in")) }
        let url = homeserverURL.appendingPathComponent(path)
        var headers = ["Authorization": "Bearer \(token)", "Accept": "application/json"]
        var data: Data?
        if let body {
            data = try? JSONSerialization.data(withJSONObject: body)
            headers["Content-Type"] = "application/json"
        }
        let response: HTTPResponse
        do {
            response = try await http.send(HTTPRequest(method: method, url: url, headers: headers, body: data))
        } catch {
            return .refused(Outcome.refusal("Couldn't reach the homeserver"))
        }
        let parsed = (try? JSONSerialization.jsonObject(with: response.body)) as? [String: Any]
        if response.status == 200, let parsed { return .answered(parsed) }
        // The shape a matrix-widget-api host uses for a failed homeserver call,
        // so matrix-js-sdk turns it into a MatrixError with the real status.
        return .refused([
            "message": "The homeserver refused the request (HTTP \(response.status))",
            "matrix_api_error": [
                "http_status": response.status,
                "http_headers": [String: Any](),
                "url": url.absoluteString,
                "response": parsed ?? [String: Any](),
            ] as [String: Any],
        ])
    }

    // MARK: - JSON

    static func object(_ raw: String) -> [String: Any]? {
        guard let d = raw.data(using: .utf8) else { return nil }
        return (try? JSONSerialization.jsonObject(with: d)) as? [String: Any]
    }

    static func string(_ obj: [String: Any]) -> String? {
        guard let d = try? JSONSerialization.data(withJSONObject: obj, options: [.withoutEscapingSlashes]) else { return nil }
        return String(data: d, encoding: .utf8)
    }

    /// "livekit: wss://rtc.example.com" lines for the About screen, from the
    /// raw `/rtc/transports` answer (either URL field spelling).
    public static func describeTransports(_ data: Data) -> [String] {
        guard let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let list = obj["rtc_transports"] as? [[String: Any]] else { return [] }
        return list.compactMap { t in
            guard let type = t["type"] as? String else { return nil }
            let url = (t["url"] as? String) ?? (t["livekit_service_url"] as? String)
            return url.map { "\(type): \($0)" } ?? type
        }
    }

    /// `GET /rtc/transports` for display (not used to gate calls).
    public static func fetchTransports(http: HTTPClient, homeserverURL: URL, accessToken: String) async -> [String] {
        let url = homeserverURL.appendingPathComponent(transportsPath)
        guard let r = try? await http.send(HTTPRequest(url: url, headers: ["Authorization": "Bearer \(accessToken)", "Accept": "application/json"])),
              r.status == 200 else { return [] }
        return describeTransports(r.body)
    }
}
