#!/usr/bin/env bash
# What can be verified for the iOS app without macOS (a Linux Swift toolchain
# 6.x on PATH, e.g. the swift.org Ubuntu 24.04 release):
#
#  1. LumenCore: build in Swift 6 mode and run its XCTest suite (incl. the
#     shared test vectors in apps/shared/test-vectors).
#  2. Type-check the SDK-facing app code (Lumen/Matrix, Lumen/Shared minus the
#     Keychain file) and LumenTests' app-level tests against the real Matrix
#     Rust SDK Swift bindings of the pinned release and the C headers from its
#     xcframework. Nothing is linked: the Rust library is Apple-only.
#
# SwiftUI/UIKit/CallKit/PushKit/WebKit code and the NSE need Xcode (CI).
#
#   bash apps/ios/scripts/linux-check.sh
#   LUMEN_SDK_XCFRAMEWORK_ZIP=/path/MatrixSDKFFI.xcframework.zip bash apps/ios/scripts/linux-check.sh   # reuse a download
set -euo pipefail

IOS="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SDK_VERSION="26.10.02"
# Must equal the checksum in matrix-rust-components-swift's Package.swift at $SDK_VERSION.
SDK_SHA256="954420a70dee62f3c73a772d530b9668da17393da3bc71a219f0105006f93573"
WORK="${LUMEN_CHECK_DIR:-${TMPDIR:-/tmp}/lumen-ios-linux-check}"
mkdir -p "$WORK"

command -v swift >/dev/null || { echo "swift not on PATH" >&2; exit 1; }
swift --version | head -1

echo "== 1. LumenCore swift test"
(cd "$IOS/LumenCore" && nice -n 15 swift test --scratch-path "$WORK/core-build")

echo "== 2. SDK bindings type-check ($SDK_VERSION)"
if [[ ! -d "$WORK/sdk/.git" ]]; then
  git clone --depth 1 --branch "$SDK_VERSION" https://github.com/matrix-org/matrix-rust-components-swift "$WORK/sdk"
fi
grep -q "$SDK_SHA256" "$WORK/sdk/Package.swift" || { echo "Package.swift checksum differs from the pinned one" >&2; exit 1; }
ZIP="${LUMEN_SDK_XCFRAMEWORK_ZIP:-$WORK/MatrixSDKFFI.xcframework.zip}"
if [[ ! -f "$ZIP" ]]; then
  curl -fsSL -o "$ZIP" "https://github.com/matrix-org/matrix-rust-components-swift/releases/download/$SDK_VERSION/MatrixSDKFFI.xcframework.zip"
fi
echo "$SDK_SHA256  $ZIP" | sha256sum -c -

H="$WORK/harness"
rm -rf "$H/Sources"
mkdir -p "$H/Sources/MatrixSDKFFI/include" "$H/Sources/MatrixRustSDK" "$H/Sources/LumenCore" "$H/Sources/LumenAppCheck" "$H/Sources/LumenTestsCheck"
unzip -q -o -j "$ZIP" 'MatrixSDKFFI.xcframework/ios-arm64/Headers/MatrixSDKFFI/*.h' -d "$H/Sources/MatrixSDKFFI/include"
# The shipped module map `use`s Darwin; on Linux list the headers only.
{
  echo "module MatrixSDKFFI {"
  for h in "$H"/Sources/MatrixSDKFFI/include/*.h; do echo "header \"$(basename "$h")\""; done
  echo "export *"
  echo "}"
} > "$H/Sources/MatrixSDKFFI/include/module.modulemap"
echo "/* headers only, never linked */" > "$H/Sources/MatrixSDKFFI/shim.c"
ln -sf "$WORK"/sdk/Sources/MatrixRustSDK/*.swift "$H/Sources/MatrixRustSDK/"
ln -sf "$IOS"/LumenCore/Sources/LumenCore/*.swift "$H/Sources/LumenCore/"
ln -sf "$IOS"/Lumen/Matrix/*.swift "$H/Sources/LumenAppCheck/"
for f in AppEnvironment ClientFactory NotificationMapping; do
  ln -sf "$IOS/Lumen/Shared/$f.swift" "$H/Sources/LumenAppCheck/"
  ln -sf "$IOS/Lumen/Shared/$f.swift" "$H/Sources/LumenTestsCheck/"
done
# LumenTests' app-level tests, compiled like the Xcode logic-test bundle (no linking).
ln -sf "$IOS"/LumenTests/*.swift "$H/Sources/LumenTestsCheck/"
cat > "$H/Package.swift" <<'EOF'
// swift-tools-version:5.9
import PackageDescription
let package = Package(
    name: "LumenLinuxCheck",
    targets: [
        .target(name: "MatrixSDKFFI", path: "Sources/MatrixSDKFFI"),
        .target(name: "MatrixRustSDK", dependencies: ["MatrixSDKFFI"], path: "Sources/MatrixRustSDK"),
        .target(name: "LumenCore", path: "Sources/LumenCore", swiftSettings: [.unsafeFlags(["-swift-version", "6"])]),
        .target(name: "LumenAppCheck", dependencies: ["MatrixRustSDK", "LumenCore"], path: "Sources/LumenAppCheck",
                swiftSettings: [.unsafeFlags(["-swift-version", "5", "-strict-concurrency=complete", "-warnings-as-errors"])]),
        .target(name: "LumenTestsCheck", dependencies: ["MatrixRustSDK", "LumenCore"], path: "Sources/LumenTestsCheck",
                swiftSettings: [.unsafeFlags(["-swift-version", "5"])]),
    ]
)
EOF
(cd "$H" && nice -n 15 swift build -j 2 --target LumenAppCheck && nice -n 15 swift build -j 2 --target LumenTestsCheck)
echo "OK: LumenCore tests passed; SDK-facing code type-checks against matrix-rust-components-swift $SDK_VERSION"
