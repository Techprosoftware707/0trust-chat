import Foundation
import XCTest
import LumenCore

/// Records requests and answers from a fixed table. No network.
final class FakeHTTP: HTTPClient, @unchecked Sendable {
    private let lock = NSLock()
    private var routes: [String: HTTPResponse]
    private(set) var requests: [HTTPRequest] = []
    var failing: Set<String> = []

    init(_ routes: [String: (Int, String)]) {
        self.routes = routes.mapValues { HTTPResponse(status: $0.0, body: Data($0.1.utf8)) }
    }

    func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        let key = "\(request.method) \(request.url.absoluteString)"
        let (r, fail) = lock.withLock { () -> (HTTPResponse?, Bool) in
            requests.append(request)
            return (routes[key] ?? routes[request.url.absoluteString], failing.contains(request.url.absoluteString))
        }
        if fail { throw URLError(.cannotConnectToHost) }
        return r ?? HTTPResponse(status: 404, body: Data("{\"errcode\":\"M_NOT_FOUND\"}".utf8))
    }
}

private let versionsSSS = #"{"versions":["v1.11","v1.12"],"unstable_features":{"org.matrix.simplified_msc3575":true}}"#
private let loginLumen = #"{"flows":[{"type":"m.login.sso","identity_providers":[{"id":"oidc-lumen","name":"Lumen"}]},{"type":"m.login.token"}]}"#

final class ConfigTests: XCTestCase {
    // Ported from services/chat/test/unit/config.test.ts.

    func testRejectsPlainHTTPExceptLoopbackInDebug() {
        XCTAssertThrowsError(try URLPolicy.debug.validate("http://matrix.example.com", field: "x"))
        XCTAssertEqual(try URLPolicy.debug.validate("http://127.0.0.1:28008", field: "x").absoluteString, "http://127.0.0.1:28008")
        XCTAssertThrowsError(try URLPolicy.release.validate("http://127.0.0.1:28008", field: "x"))
        XCTAssertNoThrow(try URLPolicy.debug.validate("http://dev.localhost:8008", field: "x"))
    }

    func testRejectsNonHTTPSchemesAndCredentials() {
        XCTAssertThrowsError(try URLPolicy.release.validate("javascript:alert(1)", field: "x"))
        XCTAssertThrowsError(try URLPolicy.release.validate("https://u:p@m.example.com", field: "x")) { e in
            XCTAssertTrue((e as? ConfigError)?.message.contains("credentials") == true)
        }
        XCTAssertThrowsError(try URLPolicy.release.validate("https://u@m.example.com", field: "x"))
    }

    func testSSOProviderIdValidation() {
        XCTAssertTrue(LumenAppInfo.isValidIdpId("oidc-lumen"))
        XCTAssertFalse(LumenAppInfo.isValidIdpId("../../evil"))
        XCTAssertFalse(LumenAppInfo.isValidIdpId(""))
        XCTAssertFalse(LumenAppInfo.isValidIdpId(String(repeating: "a", count: 256)))
    }

    func testInvalidOptionalLinksAreDroppedNotFatal() throws {
        let json: [String: Any] = [
            "m.homeserver": ["base_url": "https://matrix.example.com/"],
            "io.lumen.app": ["version": 1, "privacy_url": "javascript:alert(1)", "help_url": 42, "portal_url": "https://example.com"],
        ]
        let wk = try WellKnownClient.parse(json: json, policy: .release)
        XCTAssertEqual(wk.homeserverURL.absoluteString, "https://matrix.example.com")
        XCTAssertNil(wk.lumen?.privacyURL)
        XCTAssertNil(wk.lumen?.helpURL)
        XCTAssertEqual(wk.lumen?.portalURL?.absoluteString, "https://example.com")
    }

    func testBrandFallbacks() throws {
        let wk = try WellKnownClient.parse(json: ["m.homeserver": ["base_url": "https://m.example.com"], "io.lumen.app": ["version": 1]], policy: .release)
        XCTAssertNil(wk.lumen?.brandName)
        XCTAssertEqual(wk.lumen?.displayName, "Lumen Secure")
        let named = LumenAppInfo(brandName: "Acme Chat")
        XCTAssertEqual(named.displayShortName, "Acme Chat")
    }

    func testPushGatewayMustBeTheNotifyEndpoint() throws {
        let ok = LumenAppInfo.parse(["version": 1, "push_gateway_url": "https://matrix.example.com/_matrix/push/v1/notify"])
        XCTAssertEqual(ok?.pushGatewayURL?.host, "matrix.example.com")
        let wrong = LumenAppInfo.parse(["version": 1, "push_gateway_url": "https://matrix.example.com/somewhere"])
        XCTAssertNil(wrong?.pushGatewayURL)
        let http = LumenAppInfo.parse(["version": 1, "push_gateway_url": "http://localhost/_matrix/push/v1/notify"])
        XCTAssertNil(http?.pushGatewayURL, "Lumen block URLs use release rules even in debug builds")
    }

    func testLumenInfoRoundTripsThroughStorage() throws {
        let info = LumenAppInfo(brandName: "Lumen Secure", brandShortName: "Lumen", portalURL: URL(string: "https://example.com"), ssoIdpId: "oidc-lumen", pushGatewayURL: URL(string: "https://matrix.example.com/_matrix/push/v1/notify"))
        XCTAssertEqual(LumenAppInfo.fromJSONData(info.jsonData()), info)
    }

    func testBuildConfigurationFromInfoPlist() {
        let c = BuildConfiguration(infoDictionary: [
            "CFBundleIdentifier": "com.example.chat",
            "LumenDefaultServer": " Example.COM ",
            "LumenAppGroup": "group.com.example.chat",
            "LumenPushAppId": "com.example.chat.ios",
        ], isDebug: false)
        XCTAssertEqual(c.defaultServer, "example.com")
        XCTAssertEqual(c.urlScheme, "com.example.chat")
        XCTAssertEqual(c.ssoRedirectBase, "com.example.chat:/sso-callback")
        XCTAssertEqual(c.urlPolicy, .release)

        XCTAssertNil(BuildConfiguration(infoDictionary: ["LumenDefaultServer": ""], isDebug: true).defaultServer)
        XCTAssertNil(BuildConfiguration(infoDictionary: ["LumenDefaultServer": "$(LUMEN_DEFAULT_SERVER)"], isDebug: true).defaultServer)
        XCTAssertNil(BuildConfiguration(infoDictionary: ["LumenDefaultServer": "https://evil/x"], isDebug: true).defaultServer, "a URL is not a server name")
        XCTAssertEqual(BuildConfiguration(infoDictionary: [:], isDebug: true).pushAppId, "io.lumen.secure.ios")
    }

    func testServerInputParsing() throws {
        XCTAssertEqual(try ServerInput.parse("example.org", policy: .release), .serverName("example.org"))
        XCTAssertEqual(try ServerInput.parse("@alice:Example.org", policy: .release), .serverName("example.org"))
        XCTAssertEqual(try ServerInput.parse("example.org:8448", policy: .release), .serverName("example.org:8448"))
        XCTAssertEqual(try ServerInput.parse("https://matrix.example.org/", policy: .release), .homeserverURL(URL(string: "https://matrix.example.org")!))
        XCTAssertThrowsError(try ServerInput.parse("", policy: .release))
        XCTAssertThrowsError(try ServerInput.parse("exa mple.org", policy: .release))
        XCTAssertThrowsError(try ServerInput.parse("http://matrix.example.org", policy: .release))
        XCTAssertThrowsError(try ServerInput.parse("example.org:99999", policy: .release))
    }

    func testLoginFlows() throws {
        let f = try LoginFlows.parse(Data(loginLumen.utf8))
        XCTAssertFalse(f.password)
        XCTAssertTrue(f.token)
        XCTAssertEqual(f.sso, [.init(id: "oidc-lumen", name: "Lumen")])
        XCTAssertEqual(f.preferredProvider(lumenIdpId: "oidc-lumen")?.id, "oidc-lumen")

        let generic = try LoginFlows.parse(Data(#"{"flows":[{"type":"m.login.sso"},{"type":"m.login.password"}]}"#.utf8))
        XCTAssertTrue(generic.password)
        XCTAssertEqual(generic.sso.first?.id, nil)
        XCTAssertEqual(generic.preferredProvider(lumenIdpId: "oidc-lumen")?.id, "oidc-lumen", "generic SSO + Lumen idp hint")

        let bad = try LoginFlows.parse(Data(#"{"flows":[{"type":"m.login.sso","identity_providers":[{"id":"../evil","name":"x"}]}]}"#.utf8))
        XCTAssertEqual(bad.sso.map(\.id), [nil], "invalid provider ids are not used")
        XCTAssertThrowsError(try LoginFlows.parse(Data("[]".utf8)))
    }
}

final class DiscoveryTests: XCTestCase {
    func testLumenServer() async throws {
        let http = FakeHTTP([
            "https://example.com/.well-known/matrix/client": (200, #"{"m.homeserver":{"base_url":"https://matrix.example.com/"},"io.lumen.app":{"version":1,"brand":{"name":"Lumen Secure","short_name":"Lumen"},"sso_idp_id":"oidc-lumen","signup_url":"https://example.com/accounts/signup/","push_gateway_url":"https://matrix.example.com/_matrix/push/v1/notify"}}"#),
            "https://matrix.example.com/_matrix/client/versions": (200, versionsSSS),
            "https://matrix.example.com/_matrix/client/v3/login": (200, loginLumen),
        ])
        let d = try await DiscoveryService(http: http, policy: .release).discover("@alice:example.com")
        XCTAssertEqual(d.serverName, "example.com")
        XCTAssertEqual(d.homeserverURL.absoluteString, "https://matrix.example.com")
        XCTAssertEqual(d.brandName, "Lumen Secure")
        XCTAssertEqual(d.preferredProvider?.id, "oidc-lumen")
        XCTAssertNotNil(d.lumen?.pushGatewayURL)
        XCTAssertTrue(http.requests.allSatisfy { $0.url.scheme == "https" })
    }

    func testPlainMatrixServerWithoutWellKnownFallsBackToServerName() async throws {
        let http = FakeHTTP([
            "https://plain.example/_matrix/client/versions": (200, versionsSSS),
            "https://plain.example/_matrix/client/v3/login": (200, #"{"flows":[{"type":"m.login.password"}]}"#),
        ])
        let d = try await DiscoveryService(http: http, policy: .release).discover("plain.example")
        XCTAssertNil(d.lumen)
        XCTAssertEqual(d.homeserverURL.absoluteString, "https://plain.example")
        XCTAssertTrue(d.loginFlows.password)
        XCTAssertEqual(d.brandName, "Lumen Secure")
    }

    func testInvalidWellKnownIsAnError() async {
        let http = FakeHTTP(["https://bad.example/.well-known/matrix/client": (200, #"{"m.homeserver":{"base_url":"http://matrix.bad.example"}}"#)])
        do {
            _ = try await DiscoveryService(http: http, policy: .release).discover("bad.example")
            XCTFail("expected an error")
        } catch let e as DiscoveryError {
            guard case .invalidConfiguration = e else { return XCTFail("got \(e)") }
        } catch { XCTFail("got \(error)") }
    }

    func testNotAMatrixServer() async {
        let http = FakeHTTP(["https://web.example/_matrix/client/versions": (200, "<html>")])
        do {
            _ = try await DiscoveryService(http: http, policy: .release).discover("web.example")
            XCTFail("expected an error")
        } catch let e as DiscoveryError {
            XCTAssertEqual(e, .notMatrixServer("web.example"))
            XCTAssertTrue(e.userMessage.contains("Matrix"))
        } catch { XCTFail("got \(error)") }
    }

    func testRequiresSlidingSync() async {
        let http = FakeHTTP([
            "https://old.example/_matrix/client/versions": (200, #"{"versions":["v1.1"]}"#),
            "https://old.example/_matrix/client/v3/login": (200, loginLumen),
        ])
        do {
            _ = try await DiscoveryService(http: http, policy: .release).discover("old.example")
            XCTFail("expected an error")
        } catch let e as DiscoveryError {
            XCTAssertEqual(e, .noSlidingSync)
        } catch { XCTFail("got \(error)") }
    }

    func testNoSupportedLogin() async {
        let http = FakeHTTP([
            "https://x.example/_matrix/client/versions": (200, versionsSSS),
            "https://x.example/_matrix/client/v3/login": (200, #"{"flows":[{"type":"m.login.application_service"}]}"#),
        ])
        do {
            _ = try await DiscoveryService(http: http, policy: .release).discover("x.example")
            XCTFail("expected an error")
        } catch let e as DiscoveryError {
            XCTAssertEqual(e, .noSupportedLogin)
        } catch { XCTFail("got \(error)") }
    }

    func testUnreachable() async {
        let http = FakeHTTP([:])
        http.failing = ["https://down.example/_matrix/client/versions"]
        do {
            _ = try await DiscoveryService(http: http, policy: .release).discover("down.example")
            XCTFail("expected an error")
        } catch let e as DiscoveryError {
            XCTAssertEqual(e, .unreachable("down.example"))
        } catch { XCTFail("got \(error)") }
    }

    func testHomeserverURLInput() async throws {
        let http = FakeHTTP([
            "https://matrix.example.net/_matrix/client/versions": (200, versionsSSS),
            "https://matrix.example.net/_matrix/client/v3/login": (200, loginLumen),
        ])
        let d = try await DiscoveryService(http: http, policy: .release).discover("https://matrix.example.net/")
        XCTAssertEqual(d.homeserverURL.absoluteString, "https://matrix.example.net")
        XCTAssertEqual(d.serverName, "matrix.example.net")
    }
}
