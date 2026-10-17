import UIKit
import XCTest

/// Renders every screen with made-up data into PNG files (the app's DEBUG
/// screenshot mode, Lumen/Debug/ScreenshotHarness.swift). Runs only when
/// `LUMEN_SCREENSHOT_DIR` is set (ci-build.sh passes it to the runner as
/// `TEST_RUNNER_LUMEN_SCREENSHOT_DIR`); nothing is signed in and no server is
/// contacted.
final class ScreenshotTests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    override func tearDown() {
        XCUIDevice.shared.orientation = .portrait
    }

    private var outputDirectory: String? {
        let dir = ProcessInfo.processInfo.environment["LUMEN_SCREENSHOT_DIR"] ?? ""
        return dir.isEmpty ? nil : dir
    }

    private var isPad: Bool {
        // The simulator's model ("iPad17,1", "iPhone18,2", …).
        if let model = ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"], !model.isEmpty { return model.hasPrefix("iPad") }
        return UIDevice.current.userInterfaceIdiom == .pad
    }

    func testScreenshotsIPhoneSE() throws { try phone("iphone-se") }
    func testScreenshotsIPhone16Pro() throws { try phone("iphone-16-pro") }
    func testScreenshotsIPhoneProMax() throws { try phone("iphone-pro-max") }

    func testScreenshotsIPadPortrait() throws { try pad("ipad-portrait", .portrait) }
    func testScreenshotsIPadLandscape11() throws { try pad("ipad-11-landscape", .landscapeLeft) }
    func testScreenshotsIPadLandscape13() throws { try pad("ipad-13-landscape", .landscapeLeft) }
    func testScreenshotsIPadSplitScreen() throws { try pad("ipad-split", .landscapeLeft) }

    /// One iPhone size per app launch, so each stays well inside the test time limit.
    private func phone(_ set: String) throws {
        guard let dir = outputDirectory else { throw XCTSkip("Set LUMEN_SCREENSHOT_DIR to capture screenshots.") }
        guard !isPad else { throw XCTSkip("iPhone screenshots are captured on the iPhone simulator.") }
        capture(set: set, orientation: .portrait, into: dir)
    }

    private func pad(_ set: String, _ orientation: UIDeviceOrientation) throws {
        guard let dir = outputDirectory else { throw XCTSkip("Set LUMEN_SCREENSHOT_DIR to capture screenshots.") }
        guard isPad else { throw XCTSkip("iPad screenshots are captured on the iPad simulator.") }
        capture(set: set, orientation: orientation, into: dir)
    }

    private func capture(set: String, orientation: UIDeviceOrientation, into dir: String) {
        XCUIDevice.shared.orientation = orientation
        let manifest = URL(fileURLWithPath: dir).appendingPathComponent("manifest-\(set).txt")
        try? FileManager.default.removeItem(at: manifest)
        let app = XCUIApplication()
        app.launchArguments += ["-LumenScreenshots", "-AppleLanguages", "(en)", "-AppleLocale", "en_GB"]
        app.launchEnvironment["LUMEN_SCREENSHOT_DIR"] = dir
        app.launchEnvironment["LUMEN_SCREENSHOT_SET"] = set
        app.launch()

        // The app is busy rendering: accessibility queries would time out, so
        // wait for the manifest file it writes last, without touching the UI.
        let deadline = Date().addingTimeInterval(560)
        while Date() < deadline, !FileManager.default.fileExists(atPath: manifest.path) {
            Thread.sleep(forTimeInterval: 2)
        }
        Thread.sleep(forTimeInterval: 1)
        let text = (try? String(contentsOf: manifest, encoding: .utf8)) ?? ""
        let summary = text.components(separatedBy: "\n").first ?? ""
        let status = app.staticTexts["screenshotStatus"]
        let label = status.waitForExistence(timeout: 20) ? status.label : "(no status)"
        print("Screenshots \(set): \(label) | \(summary)")
        XCTAssertFalse(text.isEmpty, "no manifest after 560 s; status: \(label)")
        XCTAssertTrue(summary.hasSuffix(", 0 failures"), "\(summary) | \(label)")
        XCTAssertTrue(label.hasPrefix("done"), label)
        app.terminate()
    }
}
