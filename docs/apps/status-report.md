# Client apps: status report

State of the four apps on 2026-10-15, with the evidence behind each line. Feature-level detail
is in [feature-matrix.md](feature-matrix.md); raw outputs are in
[docs/test-results/](../test-results/).

The short version:

- All four apps are real, buildable apps on the shared Lumen backend: one account system (the
  portal, through SSO), one homeserver, the same end-to-end encryption, the same call stack.
- **Desktop (Windows, macOS)** is the most proven. It ships the web client inside a hardened
  Electron shell. The whole app ran end to end against a Lumen server on its Linux build, and the
  packaged Windows and macOS builds passed their hardening checks on real Windows and macOS
  runners.
- **Android and iOS** are native apps on the Matrix Rust SDK. They build, and their logic passes
  its tests in CI (Android emulator, iPhone and iPad simulators). They have **not yet signed in to a
  server from the app**. Their call path was proven in a real encrypted call outside the apps.
- **Nothing is signed for distribution, nothing has run on a physical device, and nothing has been
  published to a store.** All of that needs the operator's own certificates and accounts.

## Windows

| | Status |
|---|---|
| Source | `apps/desktop/` (Electron 44.7.2, electron-builder 26.17.0, electron-updater 6.8.10). It bundles the web client from `services/chat/` and serves it from `app://lumen`, never from a server. |
| Build | Green on GitHub Actions `windows-2025`: runs 38706283887 and 38707540511 (the latter includes blocking). |
| Package | NSIS per-user installer `Lumen-Secure-1.0.0-win-x64.exe`, **unsigned**; SHA-256 in `docs/test-results/desktop-ci.txt` and the run's `SHA256SUMS`. Installing and uninstalling it on a real Windows PC has **not** been tried. |
| Functional tests | Unit 34/34 (shared vectors included). Packaged-app smoke test 43/43 on Windows: fuses, bundle contents, debug switches refused, CSP, OS renderer sandbox, permission denials, navigation lock, DPAPI available. |
| Messaging / encryption | End to end on the Linux build of the same code (`desktop-e2e.txt`, 11/11): encrypted DM both ways with a web user, and the server holds only ciphertext. Not run on Windows itself. |
| Calling | End to end on the Linux build: a desktop ↔ web call connected, labelled "End-to-end encrypted" on both sides, with media both ways and a screen share. Not run on Windows (camera, microphone and Windows audio routing untested). |
| Notifications | End to end on Linux (D-Bus): preview hidden, click opens the room, do not disturb. Windows Action Center: **not run**. |
| Signing | Not signed. Needs an Authenticode certificate (or Azure Trusted Signing) in the `WINDOWS_CSC_*` secrets. Until then SmartScreen warns and auto-update stays off. |
| Store | Not published. MSIX is configured but not built (it needs the Windows SDK). |
| Remaining | Install, uninstall and notifications on a real PC; a signed build and a signed update feed; MSIX. |

## macOS

| | Status |
|---|---|
| Source | `apps/desktop/`, the same code as Windows. |
| Build | Green on GitHub Actions `macos-15` (arm64): the same runs. |
| Package | DMG and ZIP for arm64 and x64, **ad-hoc signature only** (no Developer ID), **not notarized**. Gatekeeper blocks them unless the user overrides. |
| Functional tests | Unit 34/34. Packaged-app smoke test 42/42 on the arm64 app (the x64 app was built but not smoke-tested). Keychain access was deliberately not exercised in CI, because it can block on a prompt. |
| Messaging / encryption | As for Windows: end to end on the Linux build only. |
| Calling | As for Windows. The camera, microphone and screen-recording permission prompts are **not run**. |
| Notifications | Notification Center: **not run**. |
| Signing | Needs a Developer ID Application certificate plus an App Store Connect API key for notarization (`MACOS_CSC_*`, `APPLE_API_*`). |
| Store | Not published. Direct download only; there is no Mac App Store build. |
| Remaining | A real Mac: Touch ID unlock, Keychain round trip with a session, notifications, permission prompts, the sign-in return through a real browser; signing, notarization, update feed. |

## Android

| | Status |
|---|---|
| Source | `apps/android/`: Kotlin and Jetpack Compose, on the Matrix Rust SDK (`org.matrix.rustcomponents:sdk-android:26.09.28`). Module `:core` holds pure logic, `:app` the UI and Android integration. |
| Build | Green on GitHub Actions `ubuntu-24.04`: run 38707281536 (round 3; round 2, 38704288600, also green). JDK 21, AGP 8.13.2, Gradle 8.14.3, compile/target SDK 36, min SDK 26. |
| Package | Release: per-ABI APKs (`arm64-v8a` 69 MB, `armeabi-v7a`, `x86_64`, `x86`), universal APK and `app-release.aab` (106 MB), all **unsigned**; debug universal APK (debug key, for testing). SHA-256 in `docs/test-results/android-ci.txt`. The size is mostly the Rust SDK (`libmatrix_sdk_ffi.so`, 61 MiB on arm64; 16 KB page-aligned as Play requires). |
| Functional tests | Unit 64/64 (shared vectors: URL policy, well-known, deep links incl. room-version-12 IDs; native SFU-token/transport handling; delivery mapping; preview policy; app-lock timer…). Lint: 0 errors, 0 warnings. On an API 35 emulator: 8 passed, 1 skipped (it needs a test server): launch and server picker, offline input validation, real Keystore seal/open/wipe, backup disabled, foreground-service types, notification channels, permissions. |
| Messaging / encryption | Implemented against the Rust SDK (the timeline, encrypted send/receive, verification, recovery). **Not yet run against a server from the app.** |
| Calling | The bundled call widget, the native SFU-token and transport handling, Core-Telecom and the call notification are implemented. The same call path (Rust SDK widget driver + Lumen widget + native handling) passed a real encrypted call in the Linux harness (`apps-widget-call.txt`, 12/12). The app's WebView call is **not run**. |
| Notifications | FCM push via Sygnal (`event_id_only`) is implemented and optional at build time. Delivery is **not verified**: it needs a Firebase project, `PUSH_ENABLED` on the server and a device. |
| Signing | Release APKs and the AAB are **unsigned** without the `ANDROID_KEYSTORE_*` secrets. The debug APK is signed with a debug key and is for testing only. |
| Store | Not published. Play needs a developer account, Play App Signing, a Data safety form and review. |
| Remaining | Sign-in, sync, messaging, verification and a call on a device or emulator against a server; FCM delivery; a TalkBack pass; release signing. |

## iOS and iPadOS

| | Status |
|---|---|
| Source | `apps/ios/`: SwiftUI app, notification service extension, and `LumenCore` Swift package, on the Matrix Rust SDK (`matrix-rust-components-swift` 26.10.02). XcodeGen project. |
| Build | Green on GitHub Actions `macos-15`, Xcode 26.3: run 38706433166. App and extension build for the simulator with no compiler warnings; the call widget is bundled. |
| Package | Unsigned Release `.xcarchive` (`Lumen-unsigned.xcarchive.zip`, SHA-256 `31541430…ae26`). An installable `.ipa` needs signing. |
| Functional tests | 78/78 on an iPhone 17 Pro and on an iPad Pro 13-inch (M5) simulator (iOS 26.2): 71 LumenCore tests (shared vectors, native SFU-token/transport handling and more) plus 7 app-level tests against the SDK. Launch UI test passed; the discovery UI test was skipped because no test server is configured in CI (`ios-ci-round5.txt`). |
| Messaging / encryption | Implemented against the Rust SDK. **Not yet run against a server from the app.** |
| Calling | Widget in WKWebView, native SFU-token/transport handling, and CallKit are implemented. The call path passed in the Linux harness, as for Android. The app's own call is **not run**. |
| Notifications | APNs via Sygnal, with the notification extension decrypting on the device and VoIP rings through PushKit/CallKit, is implemented. **Not verified**: it needs an APNs key, `PUSH_ENABLED` and a device. |
| Signing | Unsigned. Needs an Apple Developer account, certificates and provisioning profiles (the steps are in `release-ios.md`). |
| Store | Not published. App Review and the export-compliance answers (non-exempt encryption) are open. |
| Remaining | Everything on a device: push, CallKit ringing while suspended, audio routing, Face ID, universal links; the server-backed UI test; TestFlight. |

## Shared server-side pieces (all four apps)

| | Status |
|---|---|
| Discovery (`io.lumen.app` in the well-known), SSO return to `io.lumen.secure:/sso-callback`, logout | `apps-sso.txt` 10/10 against the dev stack |
| Call widget served at `https://app.<domain>/widget/call/` | Deployed and checked on the dev stack (HTTP 200, no-cache HTML, immutable assets); renderer unit test |
| Push gateway (Sygnal, `event_id_only`, Synapse `push.include_content: false`, route only from private ranges) | Renderer unit tests. Fresh install with `PUSH_ENABLED=true` and no credentials: gateway not started, apps not told, a warning (this found and fixed a crash-loop). Then with a throwaway APNs key: gateway healthy and advertised. **No real FCM/APNs delivery**, which needs real credentials and a device. |
| App links (`assetlinks.json`, `apple-app-site-association`) | Renderer unit tests; served only when configured |

## Credentials only the operator can supply

| For | What |
|---|---|
| Windows signing | Authenticode code-signing certificate (or Azure Trusted Signing account) |
| macOS signing | Apple Developer Program membership, Developer ID Application certificate, App Store Connect API key (notarization) |
| iOS | Apple Developer Program membership, distribution certificate, provisioning profiles for the app and the extension, APNs key, App Store Connect record |
| Android | Release keystore (upload key), Google Play developer account, Firebase project (for push) |
| Server push | FCM service-account JSON and APNs `.p8` key, set with `lumenctl set-secret` |
| Auto-update | An HTTPS update feed for the signed desktop builds (`LUMEN_UPDATE_URL`) |
