#!/usr/bin/env bash
# CI build for the Lumen iOS/iPadOS app (macOS runner with Xcode 26).
#
#   bash apps/ios/scripts/ci-build.sh          # from the repository root
#
# Steps: select Xcode -> install XcodeGen 2.46.0 (pinned, checksum-verified)
# -> checks (generated tokens, no disabled TLS verification) -> LumenCore
# `swift test` -> xcodegen generate -> simulator build -> tests on an iPhone
# and an iPad simulator (including the screenshot capture) -> unsigned
# Release archive (checked to contain no screenshot mode).
#
# Outputs in apps/ios/build/:
#   Lumen-unsigned.xcarchive.zip  LumenTests.xcresult  Lumen.xcodeproj.zip
#   SHA256SUMS-ios.txt            logs/*.log
#   screenshots/<device>/<screen>--<appearance>[--<text size>][--p<page>].png
#
# Environment:
#   LUMEN_DEFAULT_SERVER   optional server name baked into the build (empty: the user is asked)
#   LUMEN_UITEST_SERVER    optional server for the discovery UI test (skipped when unset)
#   LUMEN_XCODE            optional path to an Xcode.app (default: /Applications/Xcode_26.3.app, else newest Xcode_26*)
#   LUMEN_SKIP_TESTS=1     build and archive only
# No signing material is used: everything is built with CODE_SIGNING_ALLOWED=NO.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
IOS="$REPO/apps/ios"
OUT="$IOS/build"
LOGS="$OUT/logs"
XCODEGEN_VERSION="2.46.0"
XCODEGEN_SHA256="4d9e34b62172d645eed6457cac13fc222569974098ef4ee9c3368bedf0196806"

rm -rf "$OUT"
mkdir -p "$LOGS"
declare -a SUMMARY=()
note() { SUMMARY+=("$1"); echo "==> $1"; }
fail() {
  echo "::error::$1" >&2
  echo
  echo "================ iOS build summary (FAILED) ================"
  for s in "${SUMMARY[@]}"; do echo " - $s"; done
  echo " - FAILED: $1"
  exit 1
}

# --- Xcode -------------------------------------------------------------------
XCODE="${LUMEN_XCODE:-}"
if [[ -z "$XCODE" ]]; then
  if [[ -d /Applications/Xcode_26.3.app ]]; then
    XCODE=/Applications/Xcode_26.3.app
  else
    XCODE="$(ls -d /Applications/Xcode_26*.app 2>/dev/null | sort -V | tail -1 || true)"
  fi
fi
[[ -n "$XCODE" && -d "$XCODE" ]] || fail "no Xcode 26 found in /Applications"
if [[ "$(xcode-select -p)" != "$XCODE/Contents/Developer" ]]; then
  sudo xcode-select -s "$XCODE/Contents/Developer" || export DEVELOPER_DIR="$XCODE/Contents/Developer"
fi
note "Xcode: $(xcodebuild -version | tr '\n' ' ')"
note "Swift: $(swift --version 2>/dev/null | head -1)"

# --- XcodeGen (pinned) ------------------------------------------------------
if command -v xcodegen >/dev/null && [[ "$(xcodegen --version 2>/dev/null | awk '{print $NF}')" == "$XCODEGEN_VERSION" ]]; then
  XCODEGEN="$(command -v xcodegen)"
else
  TOOLS="$OUT/tools"
  mkdir -p "$TOOLS"
  if curl -fsSL -o "$TOOLS/xcodegen.zip" "https://github.com/yonaskolb/XcodeGen/releases/download/$XCODEGEN_VERSION/xcodegen.zip" \
     && echo "$XCODEGEN_SHA256  $TOOLS/xcodegen.zip" | shasum -a 256 -c - >/dev/null; then
    unzip -q -o "$TOOLS/xcodegen.zip" -d "$TOOLS"
    XCODEGEN="$TOOLS/xcodegen/bin/xcodegen"
  else
    echo "Pinned XcodeGen download failed or checksum mismatch; falling back to Homebrew." >&2
    brew install xcodegen >/dev/null
    XCODEGEN="$(command -v xcodegen)"
  fi
fi
note "XcodeGen: $("$XCODEGEN" --version)"

# --- Checks ------------------------------------------------------------------
python3 "$REPO/design/tools/gen_tokens.py" --check || fail "generated design tokens are out of date (run python3 design/tools/gen_tokens.py)"
note "design tokens up to date"
# The SDK builder's TLS-bypass call, assembled so this file doesn't contain it.
TLS_BYPASS="disable""SslVerification"
if grep -rniE "\.${TLS_BYPASS}[[:space:]]*\(" "$IOS" --include='*.swift' >/dev/null; then
  fail "TLS certificate validation must never be disabled (a call to the SDK's TLS-bypass builder method was found)"
fi
note "no disabled TLS verification"

# --- LumenCore package tests (host macOS toolchain) -------------------------
if [[ "${LUMEN_SKIP_TESTS:-0}" != "1" ]]; then
  (cd "$IOS/LumenCore" && swift test 2>&1) | tee "$LOGS/lumencore-swift-test.log" || fail "LumenCore swift test failed (see logs/lumencore-swift-test.log)"
  note "LumenCore swift test passed"
fi

# --- Project -----------------------------------------------------------------
(cd "$IOS" && "$XCODEGEN" generate --spec project.yml) | tee "$LOGS/xcodegen.log" || fail "xcodegen generate failed"
(cd "$IOS" && ditto -c -k --keepParent Lumen.xcodeproj "$OUT/Lumen.xcodeproj.zip")
note "generated Lumen.xcodeproj"

declare -a SETTINGS=(CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO)
# Versions (docs/apps/release.md): CFBundleShortVersionString = release tag
# vX.Y.Z (or LUMEN_VERSION), CFBundleVersion = CI run number.
VERSION="${LUMEN_VERSION:-}"
if [[ -z "$VERSION" && "${GITHUB_REF_NAME:-}" =~ ^v([0-9]+\.[0-9]+\.[0-9]+)$ ]]; then VERSION="${BASH_REMATCH[1]}"; fi
if [[ -n "$VERSION" ]]; then
  [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "LUMEN_VERSION must be MAJOR.MINOR.PATCH"
  SETTINGS+=("MARKETING_VERSION=$VERSION")
fi
if [[ -n "${GITHUB_RUN_NUMBER:-}" ]]; then SETTINGS+=("CURRENT_PROJECT_VERSION=$GITHUB_RUN_NUMBER"); fi
note "version ${VERSION:-1.0.0 (project default)} build ${GITHUB_RUN_NUMBER:-1}"
if [[ -n "${LUMEN_DEFAULT_SERVER:-}" ]]; then
  SETTINGS+=("LUMEN_DEFAULT_SERVER=$LUMEN_DEFAULT_SERVER")
  note "default server: $LUMEN_DEFAULT_SERVER"
fi
XB=(xcodebuild -project "$IOS/Lumen.xcodeproj" -scheme Lumen -derivedDataPath "$OUT/DerivedData" -clonedSourcePackagesDirPath "$OUT/SourcePackages")

"${XB[@]}" -resolvePackageDependencies 2>&1 | tee "$LOGS/resolve.log" || fail "Swift package resolution failed"
note "packages resolved (matrix-rust-components-swift 26.10.02)"

# --- Build for the simulator -------------------------------------------------
"${XB[@]}" -configuration Debug -destination 'generic/platform=iOS Simulator' build "${SETTINGS[@]}" 2>&1 | tee "$LOGS/build-simulator.log" \
  || fail "simulator build failed (see logs/build-simulator.log)"
note "simulator build succeeded"

# --- Tests on an iPhone and an iPad simulator -------------------------------
pick_sim() { # $1: device name prefix; prints a destination id or nothing
  xcrun simctl list devices available -j | python3 -c '
import json, re, sys
want = sys.argv[1]
data = json.load(sys.stdin)["devices"]
best = None
for runtime, devs in data.items():
    m = re.search(r"iOS-(\d+)-(\d+)", runtime)
    if not m:
        continue
    ver = (int(m.group(1)), int(m.group(2)))
    for d in devs:
        if d["name"].startswith(want) and (best is None or ver > best[0]):
            best = (ver, d["udid"], d["name"])
if best:
    print(best[1])
' "$1"
}
if [[ "${LUMEN_SKIP_TESTS:-0}" != "1" ]]; then
  # The largest iPhone, so every iPhone screenshot size fits on its screen.
  IPHONE="$(pick_sim 'iPhone 17 Pro Max')"; [[ -n "$IPHONE" ]] || IPHONE="$(pick_sim 'iPhone 17 Pro')"; [[ -n "$IPHONE" ]] || IPHONE="$(pick_sim 'iPhone')"
  IPAD="$(pick_sim 'iPad Pro 13-inch (M5)')"; [[ -n "$IPAD" ]] || IPAD="$(pick_sim 'iPad')"
  [[ -n "$IPHONE" ]] || fail "no iPhone simulator available"
  DESTS=(-destination "id=$IPHONE")
  [[ -n "$IPAD" ]] && DESTS+=(-destination "id=$IPAD")
  if [[ -n "${LUMEN_UITEST_SERVER:-}" ]]; then export TEST_RUNNER_LUMEN_UITEST_SERVER="$LUMEN_UITEST_SERVER"; fi
  # LumenUITests/ScreenshotTests: the app's DEBUG screenshot mode writes here.
  SHOTS="$OUT/screenshots"
  mkdir -p "$SHOTS"
  export TEST_RUNNER_LUMEN_SCREENSHOT_DIR="$SHOTS"
  "${XB[@]}" -configuration Debug "${DESTS[@]}" -resultBundlePath "$OUT/LumenTests.xcresult" \
    -test-timeouts-enabled YES -maximum-test-execution-time-allowance 600 \
    test "${SETTINGS[@]}" 2>&1 | tee "$LOGS/test.log" || fail "tests failed (see LumenTests.xcresult and logs/test.log)"
  note "tests passed on simulators $IPHONE${IPAD:+ and $IPAD}"
  if [[ -z "$(find "$SHOTS" -name '*.png' -print -quit)" ]]; then
    # The simulator didn't let the app write to the host folder: collect them
    # from the app's own Documents folder.
    for sim in "$IPHONE" ${IPAD:+"$IPAD"}; do
      data="$(xcrun simctl get_app_container "$sim" "${LUMEN_BUNDLE_ID:-io.lumen.secure}" data 2>/dev/null || true)"
      if [[ -n "$data" && -d "$data/Documents/LumenScreenshots" ]]; then cp -R "$data/Documents/LumenScreenshots/." "$SHOTS/"; fi
    done
  fi
  SHOT_COUNT="$(find "$SHOTS" -name '*.png' | wc -l | tr -d ' ')"
  [[ "$SHOT_COUNT" -gt 0 ]] || fail "the screenshot tests produced no screenshots"
  note "screenshots: $SHOT_COUNT PNG files in screenshots/ ($(cat "$SHOTS"/manifest-*.txt 2>/dev/null | grep -c FAILED || true) failed)"
fi

# --- Unsigned archive ----------------------------------------------------------
"${XB[@]}" -configuration Release -destination 'generic/platform=iOS' -archivePath "$OUT/Lumen.xcarchive" archive "${SETTINGS[@]}" 2>&1 | tee "$LOGS/archive.log" \
  || fail "archive failed (see logs/archive.log)"
# The screenshot mode (Lumen/Debug, launch argument -LumenScreenshots) is
# DEBUG-only: it must not be in the Release binary.
APP_BIN="$OUT/Lumen.xcarchive/Products/Applications/Lumen.app/Lumen"
[[ -f "$APP_BIN" ]] || fail "archive has no app binary at $APP_BIN"
if LC_ALL=C grep -a -q -E 'LumenScreenshots|LUMEN_SCREENSHOT_DIR|ScreenshotRunner|PreviewFixtures' "$APP_BIN"; then
  fail "the Release archive contains the DEBUG screenshot mode"
fi
note "Release binary contains no screenshot mode or preview data"
(cd "$OUT" && ditto -c -k --keepParent Lumen.xcarchive Lumen-unsigned.xcarchive.zip && rm -rf Lumen.xcarchive)
note "unsigned archive: Lumen-unsigned.xcarchive.zip (not installable on devices until signed)"

(cd "$OUT" && shasum -a 256 Lumen-unsigned.xcarchive.zip Lumen.xcodeproj.zip > SHA256SUMS-ios.txt)
rm -rf "$OUT/DerivedData" "$OUT/tools"

echo
echo "================ iOS build summary ================"
for s in "${SUMMARY[@]}"; do echo " - $s"; done
echo " - artifacts in apps/ios/build:"
(cd "$OUT" && ls -1d *.zip *.xcresult SHA256SUMS-ios.txt 2>/dev/null | sed 's/^/     /')
cat "$OUT/SHA256SUMS-ios.txt"
