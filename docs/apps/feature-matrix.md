# Feature matrix: web, Windows, macOS, Android, iOS/iPadOS

Status of every feature on every platform, with the evidence behind it. Updated 2026-10-15.
Each app keeps a finer-grained list: [desktop](../../apps/desktop/FEATURES.md),
[Android](../../apps/android/FEATURES.md), [iOS](../../apps/ios/FEATURES.md). Raw test output is
in [docs/test-results/](../test-results/), summarised in [test-report.md](../test-report.md).

All five clients use one Matrix account on the same Lumen server, the same end-to-end encryption
(Olm/Megolm through vodozemac: matrix-sdk-crypto-wasm on web and desktop, the Matrix Rust SDK on
Android and iOS), and the same call stack (MatrixRTC + LiveKit with per-participant media keys).
None of them has its own user database or message protocol.

## How to read the status

| Label | Meaning |
|---|---|
| **E2E** | Passed end to end against a running Lumen server (the dev stack), with real accounts. |
| **E2E (Linux build)** | Desktop only. Passed end to end on the Linux build of the desktop app, which runs the same main-process, preload and web-client code as Windows and macOS. The Windows- or macOS-specific layer was not exercised. |
| **Same as web** | Desktop only. The feature is the bundled web client's own code, unchanged; the web evidence applies. It wasn't re-run inside the desktop app. |
| **E2E (harness)** | Mobile calls only. The call path both mobile apps use passed a real end-to-end encrypted call against the dev stack in `tests/apps/widget-harness`: the Matrix Rust SDK's widget driver at the SDK revision the apps pin, the Lumen call widget, and a port of the apps' native MSC4533/MSC4515 handling. The app's own WebView and OS call integration were not run. |
| **CI** | Automated tests passed on that platform without a server: the packaged-app smoke test on Windows/macOS runners, iOS simulator tests (iPhone and iPad), Android emulator (API 35) tests, or unit tests of the feature's logic (JVM / Swift / Node). The note says which. |
| **Built** | Implemented and compiles for that platform, but never run there. Needs a device, credentials or a test that doesn't exist yet. |
| **No** | Not implemented. |
| **N/A** | Doesn't apply to that platform. |

Nothing has run on a physical phone, tablet, Windows PC or Mac. No build is signed for
distribution, and nothing has been published to a store.

## Account and sign-in

| Feature | Web | Windows | macOS | Android | iOS/iPadOS |
|---|---|---|---|---|---|
| Server discovery (`/.well-known/matrix/client` with `io.lumen.app`, `/versions`, `/login`) | N/A (served by the server, configured by `config.json`) | E2E (Linux build); CI: picker renders | E2E (Linux build); CI: picker renders | CI (unit, shared vectors, fake HTTP); Built (real network) | CI (simulator unit, shared vectors; launch UI test); Built (real network) |
| SSO through the Lumen portal | E2E | E2E (Linux build): system browser, `io.lumen.secure` return with nonce, stray/replayed callbacks ignored; Built: Windows scheme registration | Built: `open-url` return | Built: Custom Tabs. Server side of the app-scheme return: E2E (`apps-sso.txt`, 10/10) | Built: `ASWebAuthenticationSession`. Server side: E2E (same test) |
| Sign out: token revoked on the server, local data and keys wiped | E2E | E2E (Linux build) | E2E (Linux build) | CI (wipe logic); Built | Built |
| Sessions list, rename, sign out other devices | E2E | Same as web | Same as web | Built (removal via the SSO fallback page) | Built (removal via the SSO fallback page) |
| Verified state of your other devices | E2E | Same as web | Same as web | Partial: this device only (the SDK FFI has no per-device trust API) | Partial: this device only |
| Account deletion | Portal (linked from Settings → About) | Same as web | Same as web | Built: "Delete account…" opens `account_delete_url` | Built: same |
| Deep links (`matrix.to`, `matrix:`), confirmation before joining | E2E | CI (unit, shared vectors); the SSO return link is E2E (Linux build) | CI (unit, shared vectors) | CI (unit, shared vectors); Built (intent delivery, App Links) | CI (simulator unit, shared vectors); Built (universal links) |

## Encryption and verification

| Feature | Web | Windows | macOS | Android | iOS/iPadOS |
|---|---|---|---|---|---|
| Encrypted 1:1 messages; the server holds only ciphertext | E2E (incl. a database check) | E2E (Linux build): DM both ways with a web user, server sees only `m.room.encrypted` | E2E (Linux build) | Built | Built |
| Verify a new device with emoji (SAS) | E2E | Same as web | Same as web | Built | Built |
| Verify a contact | E2E | Same as web | Same as web | Built | Built |
| Warning when a contact's identity changes | E2E (verified and unverified contacts) | Same as web | Same as web | Built | CI (warning logic); Built |
| Recovery key: set up, restore history on a new device | E2E | Same as web | Same as web | Built | CI (confirmation rule); Built |
| No automatic key export or unencrypted backup | E2E (backup is encrypted with the recovery key) | Same as web | Same as web | Built (`allowBackup=false`, no extraction) | Built (no iCloud backup of the stores) |

## Messaging

| Feature | Web | Windows | macOS | Android | iOS/iPadOS |
|---|---|---|---|---|---|
| Encrypted groups | E2E | Same as web | Same as web | Built | Built |
| History (back-pagination) | E2E | Same as web | Same as web | Built | Built |
| Replies, reactions, edits, deletion | E2E | Same as web | Same as web | Built | Built |
| Encrypted files and images | E2E | Same as web | Same as web | Built | Built |
| Formatted text (Markdown/HTML) | E2E | Same as web | Same as web | No: shown as plain text | Partial: inline Markdown |
| Search in decrypted history (on the device) | E2E | Same as web | Same as web | CI (unit); Built: loaded history only | No |
| Typing notices and read receipts (both can be turned off) | E2E | Same as web | Same as web | Built | Built |
| Delivery state from real server events (local echo shown as "Sending", never as delivered) | E2E | Same as web | Same as web | CI (mapping); Built | CI (mapping); Built |
| Block and unblock people | E2E (`ui.test.mjs` "blocking") | Same as web | Same as web | Built (incl. "decline and block") | Built |
| Offline banner, failed send with retry | E2E | Same as web | Same as web | Built | CI (banner logic); Built |
| Threads, polls, location | No | No | No | No | No |

## Local data protection

| Feature | Web | Windows | macOS | Android | iOS/iPadOS |
|---|---|---|---|---|---|
| Session and store key protected by the OS | N/A: browser storage, session sealed with a non-extractable WebCrypto key | CI: DPAPI `safeStorage` available on the packaged app; Built: store-key round trip with a session | Built: Keychain | CI: Keystore AES-GCM seal/open/wipe on the API 35 emulator (`KeystoreTest`) | Built: Keychain, data protection |
| No plaintext token, key or passphrase on disk | N/A | E2E (Linux build): scan of the profile incl. decompressed LevelDB. Linux without a keyring is obfuscation only, and the app warns about it | Same check, Linux build | Built | Built |
| App lock | No | E2E (Linux build): PIN (PBKDF2 600k), lock on OS lock | Built: Touch ID; PIN as on Windows | CI (timer); Built: BiometricPrompt | CI (timer); Built: Face ID / Touch ID |
| Hide content in the app switcher / screenshots | N/A | E2E (Linux build): content hidden while locked | Same | Built (`FLAG_SECURE`, optional) | Built (privacy cover) |

The apps say plainly that app lock and biometrics don't protect against a compromised operating
system.

## Calls

| Feature | Web | Windows | macOS | Android | iOS/iPadOS |
|---|---|---|---|---|---|
| 1:1 voice and video, end-to-end encrypted media | E2E (`calls-core.txt`, `calls-core-after-widget.txt`) | E2E (Linux build): desktop ↔ web call, "End-to-end encrypted" on both sides, media both ways | E2E (Linux build) | E2E (harness); Built (WebView host) | E2E (harness); Built (WKWebView host) |
| Encryption label taken only from the call's real state | E2E | E2E (Linux build) | E2E (Linux build) | CI (label mapping) | CI (label rule) |
| HD Voice (Opus 48 kHz, FEC, DTX) | E2E | Same as web | Same as web | Same widget code; not run in the app | Same widget code; not run in the app |
| Group calls | E2E (3 clients) | Same as web | Same as web | Built | Built |
| Screen sharing | E2E | E2E (Linux build, own source picker) | Built (needs the Screen Recording permission) | No | No |
| Camera switching | E2E | Same as web | Same as web | Built (widget control) | Built (CallKit/widget action) |
| Microphone/speaker selection; Bluetooth and wired headsets | E2E (device selection) | Same as web | Same as web | Built: Core-Telecom audio endpoints | Built: AVAudioSession route picker |
| Bad networks: bandwidth limit, packet loss, reconnect after an outage | E2E (`calls-network*.txt`) | Same as web | Same as web | Same widget code; not run in the app | Same widget code; not run in the app |
| OS call integration | N/A | N/A | N/A | Built: Core-Telecom, CallStyle notifications, phone-call foreground service (FGS types checked on the emulator) | Built: CallKit |
| Incoming call while the app is closed | No: only while a tab is open | Only while the app runs (it keeps running in the tray) | Same | Built: needs FCM credentials and the server's push gateway; not verified | Built: needs APNs/PushKit credentials and the push gateway; not verified |
| Outsiders can't join; a rogue SFU subscriber can't decode media | E2E (`calls-security.txt`) | Same as web | Same as web | Server-side guarantee, same SFU | Server-side guarantee, same SFU |

Calls connect over ICE/UDP, ICE/TCP 7881 or TURN/UDP 3478. TURN over TLS is not offered (see
[known-limitations.md](../known-limitations.md)), so a network that allows only TCP 443 can't
carry calls on any platform.

## Notifications

| Feature | Web | Windows | macOS | Android | iOS/iPadOS |
|---|---|---|---|---|---|
| Notifications while the app runs, previews hidden by default | E2E | E2E (Linux build, D-Bus) | Built (Notification Center) | CI (preview policy); Built | CI (preview policy); Built |
| Click opens the conversation | E2E | E2E (Linux build) | Built | Built | Built |
| Push when the app is closed (Sygnal → FCM/APNs, `event_id_only`, no message content) | N/A | N/A | N/A | Built: needs a Firebase project, `PUSH_ENABLED` on the server, a device; not verified | Built: needs an APNs key, `PUSH_ENABLED`, a device; not verified |
| Server never sends message content to push providers | Server config (`push.include_content: false`, `event_id_only`): unit-tested in `tests/deploy/test_render_apps.py` | ← | ← | ← | ← |
| Do not disturb | N/A | E2E (Linux build) | Built | System | System |

## Platform integration and distribution

| Feature | Web | Windows | macOS | Android | iOS/iPadOS |
|---|---|---|---|---|---|
| Light and dark themes from the shared tokens | E2E | Same as web | Same as web | Built (generated tokens) | Built (generated tokens) |
| Tray / menu-bar icon, close keeps running | N/A | Built (Linux: close → hidden is E2E) | Built | N/A | N/A |
| Unread badge | Tab title | Built (taskbar overlay) | Built (Dock) | System (notification dots) | Built (app badge) |
| Open at login (off by default) | N/A | Built | Built | N/A | N/A |
| Hardened app (fuses, sandbox, CSP, navigation lock, debug switches refused) | N/A | CI (43 checks on the packaged app) | CI (42 checks, arm64 app) | N/A | N/A |
| Installable package | N/A | CI: NSIS `.exe`, unsigned | CI: `.dmg` + `.zip`, arm64 and x64, ad-hoc signed only | CI: debug APK; unsigned release APKs + AAB | CI: unsigned `.xcarchive` (an `.ipa` needs signing) |
| Signed for distribution | N/A | No (needs an Authenticode certificate) | No (needs a Developer ID certificate and notarization) | No (needs the release keystore) | No (needs an Apple Developer account) |
| Auto-update | N/A | Built: signed builds only; unsigned builds say updates are disabled | Built: signed builds only | Store | Store |
| Published to a store | N/A | No | No | No | No |
