import XCTest

/// Launch → server picker. With `LUMEN_UITEST_SERVER` set (a reachable
/// Matrix server offering SSO), the sign-in button must appear after
/// discovery. No account is used and nothing is signed in.
final class LumenUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    func testLaunchShowsServerPicker() {
        let app = XCUIApplication()
        app.launchArguments += ["-AppleLanguages", "(en)"]
        app.launch()
        XCTAssertTrue(app.textFields["serverField"].waitForExistence(timeout: 30), "server picker not shown")
    }

    func testDiscoveryShowsSSOButton() throws {
        guard let server = ProcessInfo.processInfo.environment["LUMEN_UITEST_SERVER"], !server.isEmpty else {
            throw XCTSkip("Set LUMEN_UITEST_SERVER to a server name to run the discovery test.")
        }
        let app = XCUIApplication()
        app.launch()
        let field = app.textFields["serverField"]
        XCTAssertTrue(field.waitForExistence(timeout: 30))
        field.tap()
        if let current = field.value as? String, !current.isEmpty, current != "example.com" {
            field.press(forDuration: 1.0)
            if app.menuItems["Select All"].waitForExistence(timeout: 2) { app.menuItems["Select All"].tap() }
            field.typeText(XCUIKeyboardKey.delete.rawValue)
        }
        field.typeText(server)
        let cont = app.buttons["continueButton"]
        if cont.exists { cont.tap() } else { field.typeText("\n") }
        XCTAssertTrue(app.buttons["ssoButton"].firstMatch.waitForExistence(timeout: 45), "SSO button not shown for \(server)")
    }
}
