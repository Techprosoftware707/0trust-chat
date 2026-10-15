// swift-tools-version:6.0
// LumenCore: the app's platform-independent logic (configuration, discovery,
// deep links, delivery state, notification policy, widget bridge filtering,
// app lock). Foundation only: no UIKit, no Matrix SDK. It builds and its tests
// run on macOS, iOS simulators and Linux (`swift test`).
import PackageDescription

let package = Package(
    name: "LumenCore",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "LumenCore", targets: ["LumenCore"]),
    ],
    targets: [
        .target(name: "LumenCore", path: "Sources/LumenCore"),
        .testTarget(name: "LumenCoreTests", dependencies: ["LumenCore"], path: "Tests/LumenCoreTests"),
    ]
)
