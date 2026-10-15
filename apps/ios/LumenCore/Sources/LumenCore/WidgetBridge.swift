import Foundation

// The native side of the call-widget bridge (integration.md §6.2).
//
// Widget -> native: the widget posts widget-API JSON to
// `window.webkit.messageHandlers.lumenNative`. `WidgetMessageFilter` decides
// what is forwarded to the Rust SDK's WidgetDriverHandle, what is a Lumen
// call-state event for CallKit, and what is dropped.
//
// Native -> widget: strings from WidgetDriverHandle.recv() and Lumen call
// actions are delivered with `window.postMessage(<json>, <origin>)`.

public enum CallConnectionState: String, Equatable, Sendable {
    case connecting, connected, reconnecting, ended
}

/// The widget's media-encryption state. The app never derives this itself.
public enum CallEncryptionState: Equatable, Sendable {
    case encrypted
    case waitingForKey
    case notEncrypted
    case other(String)
    case unknown

    init(raw: String?) {
        switch raw {
        case "encrypted": self = .encrypted
        case "waiting-for-key": self = .waitingForKey
        case "not-encrypted": self = .notEncrypted
        case nil: self = .unknown
        case let s?: self = .other(String(s.prefix(40)))
        }
    }

    /// Only the widget's own "encrypted" state is shown as end-to-end encrypted.
    public var label: String {
        switch self {
        case .encrypted: return "End-to-end encrypted"
        case .waitingForKey: return "Waiting for encryption keys"
        case .notEncrypted: return "Not end-to-end encrypted"
        case .other(let s): return "Encryption: \(s)"
        case .unknown: return "Encryption status unknown"
        }
    }

    public var isEncrypted: Bool { self == .encrypted }
}

/// An `io.lumen.call_state` event. It never contains keys.
public struct CallStateUpdate: Equatable, Sendable {
    public var state: CallConnectionState
    public var video: Bool?
    public var muted: Bool?
    public var e2ee: CallEncryptionState

    public init(state: CallConnectionState, video: Bool? = nil, muted: Bool? = nil, e2ee: CallEncryptionState = .unknown) {
        self.state = state
        self.video = video
        self.muted = muted
        self.e2ee = e2ee
    }
}

public enum CallAction: String, CaseIterable, Sendable {
    case hangup, mute, unmute, videoOn = "video_on", videoOff = "video_off", switchCamera = "switch_camera"
}

public enum WidgetInbound: Equatable, Sendable {
    /// Forward this string unchanged to `WidgetDriverHandle.send(msg:)`.
    case forwardToDriver(String)
    /// A Lumen call-state event; `reply` (if any) acknowledges the widget-API request.
    case callState(CallStateUpdate, reply: String?)
    case drop(reason: String)
}

public struct WidgetMessageFilter: Sendable {
    public static let callStateAction = "io.lumen.call_state"
    public static let callActionAction = "io.lumen.call_action"
    public static let maxMessageBytes = 1 << 20

    public let widgetId: String

    public init(widgetId: String) {
        self.widgetId = widgetId
    }

    /// Classifies one message from the widget page.
    ///
    /// Forwarded to the driver: `fromWidget` requests (no `response` yet) and
    /// `toWidget` responses (answers to the driver's requests), both for this
    /// widget ID. Everything else is dropped: echoes of the driver's own
    /// `toWidget` requests, other widget IDs, malformed or oversized JSON.
    public func classify(_ raw: String) -> WidgetInbound {
        guard raw.utf8.count <= WidgetMessageFilter.maxMessageBytes else { return .drop(reason: "too large") }
        guard let data = raw.data(using: .utf8),
              let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        else { return .drop(reason: "not a JSON object") }

        let action = obj["action"] as? String
        if action == WidgetMessageFilter.callStateAction || obj["type"] as? String == WidgetMessageFilter.callStateAction {
            if let w = obj["widgetId"] as? String, w != widgetId { return .drop(reason: "other widget") }
            guard let update = WidgetMessageFilter.parseCallState(obj["data"] ?? obj["content"]) else {
                return .drop(reason: "invalid call state")
            }
            var reply: String?
            if obj["api"] as? String == "fromWidget", obj["requestId"] is String, obj["response"] == nil {
                var r = obj
                r["response"] = [String: Any]()
                reply = WidgetMessageFilter.jsonString(r)
            }
            return .callState(update, reply: reply)
        }

        guard let api = obj["api"] as? String else { return .drop(reason: "no api") }
        guard obj["widgetId"] as? String == widgetId else { return .drop(reason: "other widget") }
        guard obj["requestId"] is String, let a = action, !a.isEmpty else { return .drop(reason: "not a widget-API message") }
        let isResponse = obj["response"] != nil
        switch (api, isResponse) {
        case ("fromWidget", false), ("toWidget", true):
            return .forwardToDriver(raw)
        default:
            return .drop(reason: "echo")
        }
    }

    static func parseCallState(_ raw: Any?) -> CallStateUpdate? {
        guard let d = raw as? [String: Any], let s = d["state"] as? String, let state = CallConnectionState(rawValue: s) else { return nil }
        return CallStateUpdate(
            state: state,
            video: d["video"] as? Bool,
            muted: d["muted"] as? Bool,
            e2ee: CallEncryptionState(raw: d["e2ee"] as? String)
        )
    }

    /// A `toWidget` request carrying an `io.lumen.call_action`.
    public func actionMessage(_ action: CallAction, requestId: String = UUID().uuidString) -> String {
        WidgetMessageFilter.jsonString([
            "api": "toWidget",
            "widgetId": widgetId,
            "requestId": requestId,
            "action": WidgetMessageFilter.callActionAction,
            "data": ["action": action.rawValue],
        ]) ?? "{}"
    }

    static func jsonString(_ obj: [String: Any]) -> String? {
        guard let d = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]) else { return nil }
        return String(data: d, encoding: .utf8)
    }
}

public enum JavaScriptBridge {
    /// `window.postMessage(JSON.parse("<json>"), "<origin>")` with both values
    /// embedded as JSON string literals, so nothing in the message can break
    /// out of the script. Returns nil if `json` is not a JSON object.
    public static func postMessageScript(json: String, targetOrigin: String) -> String? {
        guard let data = json.data(using: .utf8),
              (try? JSONSerialization.jsonObject(with: data)) is [String: Any],
              let messageLiteral = stringLiteral(json),
              let originLiteral = stringLiteral(targetOrigin)
        else { return nil }
        return "window.postMessage(JSON.parse(\(messageLiteral)), \(originLiteral));"
    }

    /// A JSON (and therefore JavaScript) string literal; also escapes U+2028/2029 and "</".
    public static func stringLiteral(_ s: String) -> String? {
        guard let d = try? JSONSerialization.data(withJSONObject: [s], options: [.withoutEscapingSlashes]),
              var arr = String(data: d, encoding: .utf8)
        else { return nil }
        // "[\"…\"]" -> "\"…\""
        arr.removeFirst()
        arr.removeLast()
        return arr
            .replacingOccurrences(of: "\u{2028}", with: "\\u2028")
            .replacingOccurrences(of: "\u{2029}", with: "\\u2029")
            .replacingOccurrences(of: "</", with: "<\\/")
    }

    /// The `targetOrigin` for `window.postMessage`:
    /// - the expected widget origin when the page reports exactly that origin;
    /// - "*" when the page has an opaque origin ("null"), which WebKit may give
    ///   pages served by a custom URL scheme handler. The script is evaluated
    ///   by the native side in its own top-level page after checking the page
    ///   URL, so no other window can receive it;
    /// - otherwise the expected origin, so a navigated-away page gets nothing.
    public static func targetOrigin(expected: String, reported: String?) -> String {
        guard let r = reported else { return expected }
        if r == "null" { return "*" }
        return r.lowercased() == expected.lowercased() ? r : expected
    }
}

/// Where the call widget is loaded from (integration.md §6.2).
public enum WidgetSource: Equatable, Sendable {
    /// Bundled in the app, served by the WKURLSchemeHandler.
    case bundled
    /// The operator's copy (`call_widget_url`), because the bundled copy is missing or not a secure context.
    case server(URL)

    public static let bundledScheme = "lumen-widget"
    public static let bundledBase = URL(string: "lumen-widget://call/index.html")!

    public var pageURL: URL {
        switch self {
        case .bundled: return WidgetSource.bundledBase
        case .server(let base):
            return base.path.hasSuffix(".html") ? base : base.appendingPathComponent("index.html")
        }
    }

    /// scheme://host[:port]
    public var origin: String {
        let u = pageURL
        var s = "\(u.scheme ?? "https")://\(u.host ?? "")"
        if let p = u.port { s += ":\(p)" }
        return s
    }

    public var label: String {
        switch self {
        case .bundled: return "Bundled with the app"
        case .server(let u): return "Loaded from the server (\(u.host ?? u.absoluteString))"
        }
    }
}

public enum CallIntent: String, Sendable {
    case startCall = "start_call"
    case joinExisting = "join_existing"
}

public enum CallNotify: String, Sendable {
    case ring, notification, none
}

/// The widget URL template. Placeholders are the ones the Rust SDK's
/// `generateWebviewUrl` replaces (matrix-sdk `widget/settings/url_params.rs`
/// at the pinned release): `$matrix_widget_id`, `$matrix_room_id`,
/// `$matrix_user_id`, `$org.matrix.msc2873.matrix_device_id`,
/// `$org.matrix.msc4039.matrix_base_url`, `$org.matrix.msc2873.client_language`,
/// `$org.matrix.msc2873.client_theme`.
public enum WidgetURLTemplate {
    public static func rawURL(source: WidgetSource, intent: CallIntent, video: Bool, notify: CallNotify) -> String {
        let page = source.pageURL.absoluteString
        let parent = source.origin.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? ""
        let params = [
            "widgetId=$matrix_widget_id",
            "parentUrl=\(parent)",
            "roomId=$matrix_room_id",
            "userId=$matrix_user_id",
            "deviceId=$org.matrix.msc2873.matrix_device_id",
            "baseUrl=$org.matrix.msc4039.matrix_base_url",
            "lang=$org.matrix.msc2873.client_language",
            "theme=$org.matrix.msc2873.client_theme",
            "intent=\(intent.rawValue)",
            "video=\(video ? "true" : "false")",
            "notify=\(notify.rawValue)",
        ]
        return page + "?" + params.joined(separator: "&")
    }
}

/// Maps a `lumen-widget://call/<path>` request onto a file in the bundled
/// `CallWidget/` folder, refusing anything that could leave it.
public enum WidgetAssetResolver {
    public static func relativePath(for url: URL) -> String? {
        guard url.scheme?.lowercased() == WidgetSource.bundledScheme, url.host?.lowercased() == "call" else { return nil }
        var path = url.path // already percent-decoded
        if path.isEmpty || path == "/" { path = "/index.html" }
        guard path.hasPrefix("/") else { return nil }
        let parts = path.dropFirst().split(separator: "/", omittingEmptySubsequences: false)
        guard !parts.isEmpty else { return nil }
        for p in parts {
            if p.isEmpty || p == "." || p == ".." || p.hasPrefix(".") || p.contains("\\") || p.contains("\0") { return nil }
        }
        return parts.joined(separator: "/")
    }

    public static func mimeType(for path: String) -> String {
        switch (path as NSString).pathExtension.lowercased() {
        case "html", "htm": return "text/html"
        case "js", "mjs": return "text/javascript"
        case "css": return "text/css"
        case "json", "map": return "application/json"
        case "wasm": return "application/wasm"
        case "svg": return "image/svg+xml"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "webp": return "image/webp"
        case "woff2": return "font/woff2"
        case "woff": return "font/woff"
        case "ogg": return "audio/ogg"
        case "mp3": return "audio/mpeg"
        case "wav": return "audio/wav"
        default: return "application/octet-stream"
        }
    }
}
