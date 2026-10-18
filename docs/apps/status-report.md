# Client apps: status report

State of the four apps on 2026-10-18, with the evidence behind each line. Feature-level detail
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
  its tests in CI (Android emulator, iPhone and iPad simulators). The first tests that reached a
  real server (2026-10-17) found that **neither app could have signed in**: on Android every HTTPS
  request of the SDK failed (its certificate verifier was never initialised), and on iOS the SDK
  refused to build the sign-in client (no session delegate with the multi-process lock). Both are
  fixed. **Android now passes end to end on the emulator against a real Lumen server**: SSO sign-in,
  an encrypted chat with a web user in both directions, sign-out (CI run 39005995744). iOS builds
  its sign-in client against a real server in CI, but has not signed in to a Lumen server from the
  app (macOS runners can't host one). Their call path was proven in a real encrypted call outside
  the apps.
- **Android against servers with a public certificate (2026-10-18):** a tester's Android 9 phone
  discovered a Let's Encrypt server and then could not start sign-in. The cause was in the SDK's
  certificate check, on every Android version: certificates that name a CRL and no OCSP responder
  (Let's Encrypt's since 2025, Google Trust Services', e.g. matrix.org) were refused as "revoked".
  CI had not seen it because its test server uses a private CA, for which that check is skipped.
  Fixed, and the SDK's own TLS is now tested against public servers on Android 8.0, 9 and 15; the
  sign-in, chat and sign-out test passes on Android 9 and 15 in the final run (39081831503) and on
  8.0 in the run before (39080198652). Details: `test-results/android-sso-tls/`.
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
| Build | Green on GitHub Actions `ubuntu-24.04`: latest run 39081831503 (2026-10-18; build, unit, lint, screenshots, instrumented, SDK TLS on API 26/28, e2e on API 28/35 green; the API 26 e2e hit the sync stall noted below); earlier run 38707281536. JDK 21, AGP 8.13.2, Gradle 8.14.3, compile/target SDK 36, min SDK 26. |
| Package | Release: per-ABI APKs (`arm64-v8a` 69 MB, `armeabi-v7a`, `x86_64`, `x86`), universal APK and `app-release.aab` (106 MB), all **unsigned**; debug universal APK (debug key, for testing). SHA-256 in `docs/test-results/android-ci.txt`. The size is mostly the Rust SDK (`libmatrix_sdk_ffi.so`, 61 MiB on arm64; 16 KB page-aligned as Play requires). |
| Functional tests | Unit tests: `:core` 62 and `:app` 13 (shared vectors: URL policy, well-known, deep links incl. room-version-12 IDs; native SFU-token/transport handling; delivery mapping; preview policy; app-lock timer; certificate revocation info; the revocation check against a local CA and CRL…). Lint: 0 errors, 2 warnings (InlinedApi, guarded at runtime). On an API 35 emulator: 19 passed, 4 skipped (they need a test server): launch and server picker, offline input validation, real Keystore seal/open/wipe, backup disabled, foreground-service types, notification channels, permissions, and the SDK TLS tests below. Run 39081831503. |
| TLS (the SDK's own connections) | The Rust SDK checks certificates through Android (chain, expiry, server use, host name) and checks revocation for public CAs. `SdkTlsTest` against public servers, on API 26, 28 and 35 emulators (run 39081831503, 12/12 with the verifier and Keystore tests on 26 and 28): Let's Encrypt and matrix.org (Google Trust Services) accepted and single sign-on started; Let's Encrypt's revoked test certificate refused as revoked (its CRL lists it); a self-signed certificate refused. Before the fix the first two were refused as "revoked" on all three versions (run 39078879876): certificates without an OCSP responder failed the platform's OCSP-first check, and the CRL could not be fetched. Now such certificates are checked against their CRL only (unobtainable CRL = soft failure, like an unreachable OCSP responder), and plain http is allowed to the CAs' CRL hosts only (`app/crl-hosts.txt`). A sign-in error shows "Details" in debug builds (error class, TLS refusal, Android version). |
| Messaging / encryption | **End to end on emulators against a real Lumen server** (CI job "App against a real Lumen server": API 35 runs 39005995744 and 39081831503, 42/42; Android 9 (API 28) run 39081831503, 42/42; Android 8.0 (API 26) run 39080198652, 42/42): SSO through the portal (foreign-nonce link ignored with a message), first sync, device keys published, session restored after process restarts, an encrypted DM with a web user (decrypted on the phone, reply decrypted in the browser, database holds only ciphertext), sign-out (token refused, local data and Keystore key gone). The test found that the SDK could make no HTTPS request at all; fixed (verifier initialised; trust anchors follow the app's network security config: release = system CAs only). Verification, recovery and groups are implemented but not in this test (`final-sweep/android-e2e-green.txt`). The test server uses a private CA; public certificates are covered by the TLS tests above. Open: in 3 of 9 runs of this job (2026-10-18, API 26, 28 and 35) the SDK stopped syncing for a minute or more after a session restore or a join (`android-sso-tls/run3-final.txt`), not yet explained. |
| Calling | The bundled call widget, the native SFU-token and transport handling, Core-Telecom and the call notification are implemented. The same call path (Rust SDK widget driver + Lumen widget + native handling) passed a real encrypted call in the Linux harness (`apps-widget-call.txt`, 12/12). The app's WebView call is **not run**. |
| Notifications | FCM push via Sygnal (`event_id_only`) is implemented and optional at build time. Delivery is **not verified**: it needs a Firebase project, `PUSH_ENABLED` on the server and a device. |
| Signing | Release APKs and the AAB are **unsigned** without the `ANDROID_KEYSTORE_*` secrets. Debug (test) APKs are signed with the fixed test key when the `ANDROID_TEST_KEYSTORE_*` secrets are set (they are), so a new test build installs over the previous one; for testing only. |
| Store | Not published. Play needs a developer account, Play App Signing, a Data safety form and review. |
| Remaining | A physical phone: the tester's Android 9 phone discovered its Let's Encrypt server but could not start sign-in (fixed above, the fixed build is not yet confirmed on that phone); verification and a call against a server from the app; the intermittent sync stall in the e2e job; FCM delivery; a TalkBack pass; release signing. |

## iOS and iPadOS

| | Status |
|---|---|
| Source | `apps/ios/`: SwiftUI app, notification service extension, and `LumenCore` Swift package, on the Matrix Rust SDK (`matrix-rust-components-swift` 26.10.02). XcodeGen project. |
| Build | Green on GitHub Actions `macos-15`, Xcode 26.3: run 38993174644 (2026-10-17). App and extension build for the simulator; the call widget is bundled. |
| Package | Unsigned Release `.xcarchive` (`Lumen-unsigned.xcarchive.zip`, SHA-256 `31541430…ae26`). An installable `.ipa` needs signing. |
| Functional tests | 80/80 on an iPhone 17 Pro and on an iPad Pro 13-inch (M5) simulator: 71 LumenCore tests, 7 app-level tests against the SDK, and 2 that build the sign-in client exactly as the app does against real public servers (trusted certificate works, self-signed refused). Their first run found that sign-in could never have worked (no session delegate); fixed. Launch UI test passed; the discovery UI test was skipped (no test server in CI) (`final-sweep/ios-ci.txt`). |
| Messaging / encryption | Implemented against the Rust SDK. Only the sign-in client has met a real server (matrix.org, no account); **no sign-in to a Lumen server from the app yet**: macOS CI runners can't host one. |
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
