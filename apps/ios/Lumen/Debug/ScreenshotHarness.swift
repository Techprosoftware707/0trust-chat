#if DEBUG
import LumenCore
import SwiftUI
import UIKit

// Screenshot mode (DEBUG builds only; this file isn't compiled into Release).
//
// LumenUITests/ScreenshotTests launches the app with `-LumenScreenshots`.
// The app then shows no real screen and signs nothing in: it renders every
// scene of ScreenshotCatalog with made-up data (PreviewFixtures) into PNG
// files, at several device sizes, in light and dark and at large Dynamic
// Type sizes, and reports progress in the "screenshotStatus" label.
//
// Environment (set by the UI test):
//   LUMEN_SCREENSHOT_DIR  output folder (default: Documents/LumenScreenshots)
//   LUMEN_SCREENSHOT_SET  iphone-se | iphone-16-pro | iphone-pro-max | ipad-portrait | ipad-landscape

enum ScreenshotMode {
    static let argument = "-LumenScreenshots"
    static var isRequested: Bool { ProcessInfo.processInfo.arguments.contains(argument) }
}

struct ScreenshotRunnerView: View {
    @State private var status = "starting"

    var body: some View {
        VStack(spacing: 12) {
            BrandMark(size: 56)
            Text("Screenshot mode").font(.headline)
            Text(status)
                .font(.footnote.monospaced())
                .multilineTextAlignment(.center)
                .accessibilityIdentifier("screenshotStatus")
        }
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .task {
            let runner = ScreenshotRunner()
            status = await runner.run { status = $0 }
        }
    }
}

/// A device the screens are rendered for: its size in points and the safe
/// area its status bar and home indicator leave.
struct ScreenshotDevice {
    enum Kind { case phone, pad }
    let id: String
    let kind: Kind
    let size: CGSize
    let safeArea: UIEdgeInsets
    let scale: CGFloat
    /// Appearances rendered at the default text size.
    var appearances: [UIUserInterfaceStyle] = [.light, .dark]
    /// Also render the large Dynamic Type sizes here (scenes that ask for them).
    var dynamicType = false
    /// Only scenes marked `multitasking` (split-screen widths).
    var multitaskingOnly = false

    var compactWidth: Bool { kind == .phone || size.width < 600 }
}

enum ScreenshotDevices {
    private static let phoneNotch = UIEdgeInsets(top: 62, left: 0, bottom: 34, right: 0)
    private static let padBars = UIEdgeInsets(top: 24, left: 0, bottom: 20, right: 0)

    static let iphone: [ScreenshotDevice] = [
        ScreenshotDevice(id: "iphone-se", kind: .phone, size: CGSize(width: 375, height: 667),
                         safeArea: UIEdgeInsets(top: 20, left: 0, bottom: 0, right: 0), scale: 2, dynamicType: true),
        ScreenshotDevice(id: "iphone-16-pro", kind: .phone, size: CGSize(width: 402, height: 874), safeArea: phoneNotch, scale: 2, dynamicType: true),
        ScreenshotDevice(id: "iphone-pro-max", kind: .phone, size: CGSize(width: 440, height: 956), safeArea: phoneNotch, scale: 2, appearances: [.light]),
    ]

    static let ipadPortrait: [ScreenshotDevice] = [
        ScreenshotDevice(id: "ipad-11-portrait", kind: .pad, size: CGSize(width: 834, height: 1210), safeArea: padBars, scale: 1),
    ]

    static let ipadLandscape: [ScreenshotDevice] = [
        ScreenshotDevice(id: "ipad-11-landscape", kind: .pad, size: CGSize(width: 1210, height: 834), safeArea: padBars, scale: 1, appearances: [.light]),
        ScreenshotDevice(id: "ipad-13-landscape", kind: .pad, size: CGSize(width: 1376, height: 1032), safeArea: padBars, scale: 1),
        ScreenshotDevice(id: "ipad-13-split-half", kind: .pad, size: CGSize(width: 683, height: 1032), safeArea: padBars, scale: 1,
                         appearances: [.light], multitaskingOnly: true),
        ScreenshotDevice(id: "ipad-13-split-third", kind: .pad, size: CGSize(width: 375, height: 1032), safeArea: padBars, scale: 2,
                         appearances: [.light], multitaskingOnly: true),
    ]

    /// A set is one device of `iphone` (by its id), or `ipad-portrait` /
    /// `ipad-landscape`; one app launch renders one set.
    static func set(_ name: String) -> [ScreenshotDevice] {
        switch name {
        case "ipad-portrait": return ipadPortrait
        case "ipad-landscape": return ipadLandscape
        default: return iphone.filter { $0.id == name }
        }
    }
}

/// What a scene builds its screen from: a fresh app model per render and the
/// preview media.
@MainActor
struct ScreenshotContext {
    let app: AppModel
    let media: MediaLoading
    let device: ScreenshotDevice

    var isPad: Bool { device.kind == .pad }
}

@MainActor
struct ScreenshotScene {
    enum Devices { case all, phone, pad }
    let name: String
    let devices: Devices
    let dynamicType: Bool
    let multitasking: Bool
    /// Extra captures scrolled down by about a screen each.
    let pages: Int
    let settle: Double
    let make: @MainActor (ScreenshotContext) -> AnyView

    init(_ name: String, _ devices: Devices = .all, dynamicType: Bool = false, multitasking: Bool = false, pages: Int = 1,
         settle: Double = 0.45, make: @escaping @MainActor (ScreenshotContext) -> AnyView) {
        self.name = name
        self.devices = devices
        self.dynamicType = dynamicType
        self.multitasking = multitasking
        self.pages = pages
        self.settle = settle
        self.make = make
    }

    func applies(to device: ScreenshotDevice) -> Bool {
        if device.multitaskingOnly && !multitasking { return false }
        switch devices {
        case .all: return true
        case .phone: return device.kind == .phone
        case .pad: return device.kind == .pad
        }
    }
}

@MainActor
final class ScreenshotRunner {
    private var written: [String] = []
    private var failures: [String] = []

    func run(progress: @escaping @MainActor (String) -> Void) async -> String {
        let env = ProcessInfo.processInfo.environment
        let isPad = UIDevice.current.userInterfaceIdiom == .pad
        let setName = env["LUMEN_SCREENSHOT_SET"].flatMap { $0.isEmpty ? nil : $0 } ?? (isPad ? "ipad-portrait" : "iphone-16-pro")
        guard let output = outputDirectory(env["LUMEN_SCREENSHOT_DIR"]) else { return "failed: no writable output directory" }
        guard let windowScene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first else {
            return "failed: no window scene"
        }
        // Wait for the launch transition, then render without animations.
        try? await Task.sleep(nanoseconds: 800_000_000)
        UIView.setAnimationsEnabled(false)
        defer { UIView.setAnimationsEnabled(true) }
        SharedPreferences.current().reset()

        let devices = ScreenshotDevices.set(setName)
        guard !devices.isEmpty else { return "failed: unknown screenshot set \(setName)" }
        let scenes = ScreenshotCatalog.scenes
        let media = PreviewMediaLoader()
        var jobs: [(ScreenshotScene, ScreenshotDevice, UIUserInterfaceStyle, UIContentSizeCategory, String)] = []
        for device in devices {
            for scene in scenes where scene.applies(to: device) {
                for style in device.appearances {
                    jobs.append((scene, device, style, .large, style == .dark ? "dark" : "light"))
                }
                if scene.dynamicType && device.dynamicType {
                    jobs.append((scene, device, .light, .extraExtraExtraLarge, "light--xxxl"))
                    jobs.append((scene, device, .light, .accessibilityLarge, "light--ax2"))
                }
            }
        }

        let screen = windowScene.coordinateSpace.bounds.size
        for (index, job) in jobs.enumerated() {
            let (scene, device, style, category, suffix) = job
            progress("\(setName) \(index + 1)/\(jobs.count) \(device.id) \(scene.name)")
            let folder = output.appendingPathComponent(device.id, isDirectory: true)
            try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let context = ScreenshotContext(app: AppModel(), media: media, device: device)
            let view = scene.make(context)
                .environment(context.app)
                .lumenTheme()
            await render(AnyView(view), scene: scene, device: device, style: style, category: category, in: windowScene, screen: screen) { page, image, method in
                let name = "\(scene.name)--\(suffix)\(page > 1 ? "--p\(page)" : "").png"
                guard let data = image.pngData() else {
                    self.failures.append("\(device.id)/\(name): PNG encoding failed")
                    return
                }
                do {
                    try data.write(to: folder.appendingPathComponent(name), options: .atomic)
                    self.written.append("\(device.id)/\(name) \(Int(device.size.width))x\(Int(device.size.height))pt \(method)")
                } catch {
                    self.failures.append("\(device.id)/\(name): \(error.localizedDescription)")
                }
            }
            SharedPreferences.current().reset()
        }

        let manifest = (["# \(setName): \(written.count) screenshots, \(failures.count) failures"] + written + failures.map { "FAILED \($0)" })
            .joined(separator: "\n") + "\n"
        try? manifest.write(to: output.appendingPathComponent("manifest-\(setName).txt"), atomically: true, encoding: .utf8)
        if !failures.isEmpty { return "failed: \(failures.count) of \(jobs.count): \(failures[0])" }
        return "done \(setName): \(written.count) screenshots in \(output.path)"
    }

    private func outputDirectory(_ requested: String?) -> URL? {
        var candidates: [URL] = []
        if let requested, !requested.isEmpty { candidates.append(URL(fileURLWithPath: requested, isDirectory: true)) }
        if let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first {
            candidates.append(docs.appendingPathComponent("LumenScreenshots", isDirectory: true))
        }
        for dir in candidates {
            do {
                try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
                let probe = dir.appendingPathComponent(".probe")
                try Data().write(to: probe)
                try? FileManager.default.removeItem(at: probe)
                return dir
            } catch {
                continue
            }
        }
        return nil
    }

    /// Hosts the view in its own window at the device's size and safe area,
    /// waits for it to settle and draws it (`drawHierarchy` when the window
    /// fits on this simulator's screen, which also captures materials;
    /// otherwise `layer.render`).
    private func render(_ view: AnyView, scene: ScreenshotScene, device: ScreenshotDevice, style: UIUserInterfaceStyle,
                        category: UIContentSizeCategory, in windowScene: UIWindowScene, screen: CGSize,
                        save: (Int, UIImage, String) -> Void) async {
        let size = device.size
        let fits = size.width <= screen.width + 0.5 && size.height <= screen.height + 0.5
        let origin = CGPoint(x: fits ? floor((screen.width - size.width) / 2) : 0, y: fits ? floor((screen.height - size.height) / 2) : 0)
        let window = UIWindow(windowScene: windowScene)
        window.frame = CGRect(origin: origin, size: size)
        window.windowLevel = UIWindow.Level(rawValue: UIWindow.Level.normal.rawValue + 1)
        window.overrideUserInterfaceStyle = style
        window.traitOverrides.preferredContentSizeCategory = category
        window.traitOverrides.horizontalSizeClass = device.compactWidth ? .compact : .regular
        window.traitOverrides.verticalSizeClass = .regular

        let host = UIHostingController(rootView: view)
        window.rootViewController = host
        window.makeKeyAndVisible()
        window.layoutIfNeeded()
        let current = window.safeAreaInsets
        host.additionalSafeAreaInsets = UIEdgeInsets(
            top: max(0, device.safeArea.top - current.top), left: max(0, device.safeArea.left - current.left),
            bottom: max(0, device.safeArea.bottom - current.bottom), right: max(0, device.safeArea.right - current.right))

        try? await Task.sleep(nanoseconds: UInt64(scene.settle * 1_000_000_000))
        window.layoutIfNeeded()

        for page in 1...max(1, scene.pages) {
            if page > 1 {
                guard let scroll = mainScrollView(in: window), scrollDown(scroll) else { break }
                try? await Task.sleep(nanoseconds: 350_000_000)
                window.layoutIfNeeded()
            }
            let (image, method) = draw(window, size: size, scale: device.scale, fits: fits)
            save(page, image, method)
        }

        host.dismiss(animated: false)
        window.isHidden = true
        window.rootViewController = nil
        try? await Task.sleep(nanoseconds: 50_000_000)
    }

    private func draw(_ window: UIWindow, size: CGSize, scale: CGFloat, fits: Bool) -> (UIImage, String) {
        let format = UIGraphicsImageRendererFormat()
        format.scale = scale
        format.opaque = true
        let bounds = CGRect(origin: .zero, size: size)
        var method = "drawHierarchy"
        let image = UIGraphicsImageRenderer(bounds: bounds, format: format).image { ctx in
            UIColor.black.setFill()
            ctx.fill(bounds)
            if !(fits && window.drawHierarchy(in: bounds, afterScreenUpdates: true)) {
                method = "layer"
                window.layer.render(in: ctx.cgContext)
            }
        }
        return (image, method)
    }

    /// The largest scrollable view of the frontmost screen (a presented sheet
    /// if there is one).
    private func mainScrollView(in window: UIWindow) -> UIScrollView? {
        var top = window.rootViewController
        while let presented = top?.presentedViewController { top = presented }
        guard let root = top?.view else { return nil }
        var best: UIScrollView?
        var stack: [UIView] = [root]
        while let v = stack.popLast() {
            if let s = v as? UIScrollView, s.contentSize.height > s.bounds.height + 1, !s.isHidden {
                if best == nil || s.bounds.width * s.bounds.height > best!.bounds.width * best!.bounds.height { best = s }
            }
            stack.append(contentsOf: v.subviews)
        }
        return best
    }

    /// Scrolls about one screen down; false when already at the end.
    private func scrollDown(_ scroll: UIScrollView) -> Bool {
        let inset = scroll.adjustedContentInset
        let maxY = scroll.contentSize.height + inset.bottom - scroll.bounds.height
        let current = scroll.contentOffset.y
        guard current < maxY - 1 else { return false }
        let step = (scroll.bounds.height - inset.top - inset.bottom) * 0.85
        scroll.setContentOffset(CGPoint(x: scroll.contentOffset.x, y: min(maxY, current + step)), animated: false)
        return true
    }
}

/// Presents `sheet` over `base` as soon as it appears, as the app does.
struct SheetOver<Base: View, Sheet: View>: View {
    let base: Base
    let sheet: Sheet
    @State private var shown = false

    var body: some View {
        base
            .sheet(isPresented: $shown) { sheet }
            .onAppear { shown = true }
    }
}

/// A screen pushed onto a navigation stack (shows the back button).
struct PushedScreen<Content: View>: View {
    let backTitle: String
    @ViewBuilder let content: () -> Content

    var body: some View {
        NavigationStack(path: .constant(["screen"])) {
            Color.clear
                .navigationTitle(backTitle)
                .navigationDestination(for: String.self) { _ in content() }
        }
    }
}
#endif
