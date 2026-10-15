import Foundation
import LumenCore
import UIKit
import WebKit

/// Serves the bundled call widget (`CallWidget/` in the app bundle) at
/// `lumen-widget://call/…`. Paths that could leave the folder are refused.
final class WidgetSchemeHandler: NSObject, WKURLSchemeHandler {
    static var bundledRoot: URL? {
        Bundle.main.url(forResource: "CallWidget", withExtension: nil)
    }

    static var hasBundledWidget: Bool {
        guard let root = bundledRoot else { return false }
        return FileManager.default.fileExists(atPath: root.appendingPathComponent("index.html").path)
    }

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url,
              let rel = WidgetAssetResolver.relativePath(for: url),
              let root = WidgetSchemeHandler.bundledRoot
        else {
            fail(urlSchemeTask, status: 404)
            return
        }
        let file = root.appendingPathComponent(rel)
        // Resolve symlinks and check the result is still inside the folder.
        let resolved = file.resolvingSymlinksInPath().path
        guard resolved.hasPrefix(root.resolvingSymlinksInPath().path + "/"),
              let data = try? Data(contentsOf: file)
        else {
            fail(urlSchemeTask, status: 404)
            return
        }
        let headers = [
            "Content-Type": WidgetAssetResolver.mimeType(for: rel),
            "Content-Length": String(data.count),
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
        ]
        let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers)!
        urlSchemeTask.didReceive(response)
        urlSchemeTask.didReceive(data)
        urlSchemeTask.didFinish()
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {}

    private func fail(_ task: WKURLSchemeTask, status: Int) {
        if let url = task.request.url, let r = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "text/plain"]) {
            task.didReceive(r)
            task.didReceive(Data("Not found".utf8))
            task.didFinish()
        } else {
            task.didFailWithError(URLError(.fileDoesNotExist))
        }
    }
}

/// Owns the WKWebView that runs the call widget and bridges it to a
/// `CallWidgetSession` (integration.md §6.2).
@MainActor
final class CallWidgetHost: NSObject {
    let webView: WKWebView
    private let source: WidgetSource
    private weak var session: CallWidgetSession?
    private var reportedOrigin: String?
    /// Media permission is granted only while the call screen is visible.
    var isCallScreenVisible = true
    /// The bundled page reported `window.isSecureContext == false`.
    var onInsecureContext: (() -> Void)?
    var onLoadFailed: ((String) -> Void)?

    init(source: WidgetSource, session: CallWidgetSession) {
        self.source = source
        self.session = session
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.allowsPictureInPictureMediaPlayback = true
        if case .bundled = source {
            config.setURLSchemeHandler(WidgetSchemeHandler(), forURLScheme: WidgetSource.bundledScheme)
        }
        let controller = WKUserContentController()
        let bootstrap = """
        (function () {
          try {
            window.webkit.messageHandlers.lumenBootstrap.postMessage(JSON.stringify({
              isSecureContext: window.isSecureContext === true,
              origin: String(window.location.origin),
              hasGetUserMedia: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)
            }));
          } catch (e) {}
        })();
        """
        controller.addUserScript(WKUserScript(source: bootstrap, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        config.userContentController = controller
        webView = WKWebView(frame: .zero, configuration: config)
        super.init()
        // WKWebView copies its configuration: register on the web view's own controller.
        let proxy = WeakScriptHandler(self)
        webView.configuration.userContentController.add(proxy, name: "lumenNative")
        webView.configuration.userContentController.add(proxy, name: "lumenBootstrap")
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.isOpaque = false
        webView.backgroundColor = .black
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        #if DEBUG
        if #available(iOS 16.4, *) { webView.isInspectable = true }
        #endif
        session.deliverToWidget = { [weak self] json in self?.post(json) }
    }

    func load(_ url: URL) {
        webView.load(URLRequest(url: url))
    }

    func tearDown() {
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "lumenNative")
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "lumenBootstrap")
        webView.stopLoading()
        webView.loadHTMLString("", baseURL: nil)
    }

    /// Delivers a driver message (or a Lumen call action) to the page.
    private func post(_ json: String) {
        guard isOnWidgetPage(webView.url) else { return }
        let target = JavaScriptBridge.targetOrigin(expected: source.origin, reported: reportedOrigin)
        guard let script = JavaScriptBridge.postMessageScript(json: json, targetOrigin: target) else { return }
        webView.evaluateJavaScript(script, completionHandler: nil)
    }

    private func isOnWidgetPage(_ url: URL?) -> Bool {
        guard let url else { return false }
        let expected = source.pageURL
        return url.scheme?.lowercased() == expected.scheme?.lowercased()
            && url.host?.lowercased() == expected.host?.lowercased()
            && url.port == expected.port
    }

    private func isWidgetOrigin(_ origin: WKSecurityOrigin) -> Bool {
        let expected = source.pageURL
        let expectedPort = expected.port ?? 0
        return origin.protocol.lowercased() == expected.scheme?.lowercased()
            && origin.host.lowercased() == expected.host?.lowercased()
            && origin.port == expectedPort
    }

    fileprivate func handle(_ message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, isWidgetOrigin(message.frameInfo.securityOrigin) else { return }
        let raw: String
        if let s = message.body as? String {
            raw = s
        } else if JSONSerialization.isValidJSONObject(message.body),
                  let d = try? JSONSerialization.data(withJSONObject: message.body),
                  let s = String(data: d, encoding: .utf8) {
            raw = s
        } else {
            return
        }
        switch message.name {
        case "lumenBootstrap":
            guard let obj = (try? JSONSerialization.jsonObject(with: Data(raw.utf8))) as? [String: Any] else { return }
            reportedOrigin = obj["origin"] as? String
            let secure = obj["isSecureContext"] as? Bool ?? false
            if !secure, case .bundled = source {
                Diagnostics.log("Call widget: the bundled copy is not a secure context in WebKit (origin \(reportedOrigin ?? "?")); using the server's copy.")
                onInsecureContext?()
            }
        case "lumenNative":
            session?.receiveFromWidget(raw)
        default:
            break
        }
    }
}

extension CallWidgetHost: WKNavigationDelegate {
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy {
        // The widget page may only navigate within its own origin.
        if let url = navigationAction.request.url, isOnWidgetPage(url) || url.absoluteString == "about:blank" {
            return .allow
        }
        return .cancel
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        onLoadFailed?(error.localizedDescription)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        Diagnostics.log("Call widget: web content process terminated")
        onLoadFailed?("The call view stopped unexpectedly.")
    }
}

extension CallWidgetHost: WKUIDelegate {
    /// Camera and microphone: only for the widget origin, only in the main
    /// frame, only while the call screen is shown. The OS permission prompt
    /// (Info.plist usage descriptions) still applies.
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        let allowed = frame.isMainFrame && isWidgetOrigin(origin) && isCallScreenVisible
        decisionHandler(allowed ? .grant : .deny)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        nil // no pop-ups
    }
}

/// Breaks the retain cycle WKUserContentController creates with its handlers.
private final class WeakScriptHandler: NSObject, WKScriptMessageHandler {
    weak var host: CallWidgetHost?
    init(_ host: CallWidgetHost) { self.host = host }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        MainActor.assumeIsolated {
            host?.handle(message)
        }
    }
}
