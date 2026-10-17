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

    func testScreenshotsIPadPortrait() throws {
        guard let dir = outputDirectory else { throw XCTSkip("Set LUMEN_SCREENSHOT_DIR to capture screenshots.") }
        guard isPad else { throw XCTSkip("iPad screenshots are captured on the iPad simulator.") }
        capture(set: "ipad-portrait", orientation: .portrait, into: dir)
    }

    func testScreenshotsIPadLandscape() throws {
        guard let dir = outputDirectory else { throw XCTSkip("Set LUMEN_SCREENSHOT_DIR to capture screenshots.") }
        guard isPad else { throw XCTSkip("iPad screenshots are captured on the iPad simulator.") }
        capture(set: "ipad-landscape", orientation: .landscapeLeft, into: dir)
    }

    /// One iPhone size per app launch, so each stays well inside the test time limit.
    private func phone(_ set: String) throws {
        guard let dir = outputDirectory else { throw XCTSkip("Set LUMEN_SCREENSHOT_DIR to capture screenshots.") }
        guard !isPad else { throw XCTSkip("iPhone screenshots are captured on the iPhone simulator.") }
        capture(set: set, orientation: .portrait, into: dir)
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
        let status = app.staticTexts["screenshotStatus"]
        XCTAssertTrue(status.waitForExistence(timeout: 60), "screenshot mode didn't start")

        // The app writes the manifest last. Polling the file keeps accessibility
        // queries (which wait for the busy app) to a minimum.
        let deadline = Date().addingTimeInterval(540)
        var label = status.label
        var polls = 0
        while Date() < deadline, !FileManager.default.fileExists(atPath: manifest.path) {
            Thread.sleep(forTimeInterval: 3)
            polls += 1
            if polls % 10 == 0 {
                label = status.label
                if label.hasPrefix("done") || label.hasPrefix("failed") { break }
            }
        }
        Thread.sleep(forTimeInterval: 1)
        label = status.label
        let summary = (try? String(contentsOf: manifest, encoding: .utf8))?.components(separatedBy: "\n").first ?? "no manifest"
        print("Screenshots \(set): \(label) | \(summary)")
        XCTAssertTrue(label.hasPrefix("done"), "screenshot run didn't finish cleanly: \(label) | \(summary)")
        app.terminate()
    }
}
