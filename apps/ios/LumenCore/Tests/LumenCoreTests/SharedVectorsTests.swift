import Foundation
import XCTest
import LumenCore

/// Loads `apps/shared/test-vectors/*.json`: from the test bundle's
/// `test-vectors` folder (Xcode LumenTests), otherwise from the source tree
/// (`swift test` on macOS or Linux).
enum TestVectors {
    private final class Token {}

    static func load(_ name: String, file: StaticString = #filePath) throws -> [String: Any] {
        var candidates: [URL] = []
        for bundle in [Bundle(for: Token.self), Bundle.main] + Bundle.allBundles {
            if let u = bundle.url(forResource: name, withExtension: "json", subdirectory: "test-vectors") { candidates.append(u) }
            if let u = bundle.url(forResource: name, withExtension: "json") { candidates.append(u) }
        }
        let here = URL(fileURLWithPath: "\(file)")
        candidates.append(here.deletingLastPathComponent().appendingPathComponent("../../../../shared/test-vectors/\(name).json").standardized)
        for url in candidates where FileManager.default.fileExists(atPath: url.path) {
            let data = try Data(contentsOf: url)
            guard let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { break }
            return obj
        }
        throw NSError(domain: "TestVectors", code: 1, userInfo: [NSLocalizedDescriptionKey: "test vector \(name).json not found"])
    }

    static func cases(_ name: String) throws -> [[String: Any]] {
        let obj = try load(name)
        guard let cases = obj["cases"] as? [[String: Any]], !cases.isEmpty else {
            throw NSError(domain: "TestVectors", code: 2, userInfo: [NSLocalizedDescriptionKey: "\(name).json has no cases"])
        }
        return cases
    }

    static func string(_ v: Any?) -> String? {
        if v == nil || v is NSNull { return nil }
        return v as? String
    }
}

final class SharedVectorsTests: XCTestCase {
    func testURLValidationVectors() throws {
        for c in try TestVectors.cases("url-validation") {
            let input = try XCTUnwrap(c["input"] as? String)
            let debug = (c["debug"] as? Bool) ?? false
            let expect = TestVectors.string(c["expect"])
            let got = URLPolicy.validateEndpointURL(input, debug: debug)
            XCTAssertEqual(got, expect, "url-validation: \(input) debug=\(debug) (\(c["why"] as? String ?? ""))")
        }
    }

    func testWellKnownVectors() throws {
        for c in try TestVectors.cases("wellknown") {
            let name = c["name"] as? String ?? "?"
            let input = try XCTUnwrap(c["input"])
            let expect = try XCTUnwrap(c["expect"] as? [String: Any])
            do {
                let wk = try WellKnownClient.parse(json: input, policy: .release)
                XCTAssertNil(expect["error"], "\(name): expected error \(expect["error"] ?? "")")
                XCTAssertEqual(wk.homeserverURL.absoluteString, TestVectors.string(expect["homeserver"]), name)
                if let lumenExpect = expect["lumen"] as? [String: Any] {
                    let l = try XCTUnwrap(wk.lumen, "\(name): lumen block expected")
                    let actual: [String: String?] = [
                        "brand_name": l.brandName,
                        "brand_short_name": l.brandShortName,
                        "portal_url": l.portalURL?.absoluteString,
                        "signup_url": l.signupURL?.absoluteString,
                        "account_url": l.accountURL?.absoluteString,
                        "account_delete_url": l.accountDeleteURL?.absoluteString,
                        "privacy_url": l.privacyURL?.absoluteString,
                        "help_url": l.helpURL?.absoluteString,
                        "sso_idp_id": l.ssoIdpId,
                        "web_app_url": l.webAppURL?.absoluteString,
                        "call_widget_url": l.callWidgetURL?.absoluteString,
                        "push_gateway_url": l.pushGatewayURL?.absoluteString,
                    ]
                    for (key, value) in lumenExpect {
                        XCTAssertEqual(actual[key] ?? nil, TestVectors.string(value), "\(name): \(key)")
                    }
                } else {
                    XCTAssertNil(wk.lumen, "\(name): lumen should be null")
                }
            } catch let e as WellKnownClient.ParseError {
                XCTAssertEqual(e.code, TestVectors.string(expect["error"]), "\(name): unexpected error \(e)")
            }
        }
    }

    func testDeepLinkVectors() throws {
        let router = DeepLinkRouter(appScheme: "io.lumen.secure")
        for c in try TestVectors.cases("deeplinks") {
            let url = try XCTUnwrap(c["url"] as? String)
            let pending = TestVectors.string(c["pending"])
            let expect = try XCTUnwrap(c["expect"] as? [String: Any])
            let route = router.route(url, pendingSsoNonce: pending)
            let why = c["why"] as? String ?? ""
            switch expect["type"] as? String {
            case "sso_callback":
                guard case .ssoCallback(let token, _) = route else { XCTFail("\(url): expected sso_callback, got \(route) \(why)"); continue }
                XCTAssertEqual(token, expect["loginToken"] as? String, url)
            case "room":
                guard case .room(let id, _, _) = route else { XCTFail("\(url): expected room, got \(route) \(why)"); continue }
                XCTAssertEqual(id, expect["id"] as? String, url)
            case "user":
                guard case .user(let id) = route else { XCTFail("\(url): expected user, got \(route) \(why)"); continue }
                XCTAssertEqual(id, expect["id"] as? String, url)
            case "reject":
                XCTAssertEqual(route, .reject, "\(url): \(why)")
            default:
                XCTFail("unknown expected type in deeplinks.json for \(url)")
            }
        }
    }
}
