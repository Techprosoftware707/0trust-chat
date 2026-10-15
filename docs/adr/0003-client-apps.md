# ADR 0003 — Native and desktop client applications

- Status: accepted
- Date: 2026-10-15
- Scope: Windows, macOS, Android and iOS/iPadOS apps; shared protocol, crypto,
  calling, push, configuration, design system, build and release
- Builds on: ADR 0001 (Matrix, Synapse, SSO through the portal), ADR 0002
  (MatrixRTC + LiveKit calls with per-participant media keys)

## What already exists (inspected, 2026-10-15)

| Area | What the repository actually has |
|---|---|
| Protocol | Matrix client-server API v1.x against Synapse 1.163; federation open, allow-list or closed. |
| Web client (`services/chat`) | React 19 + `matrix-js-sdk` 44 with the **Rust crypto** (`matrix-sdk-crypto-wasm`, i.e. vodozemac): E2EE by default, cross-signing, SAS emoji verification, secret storage, key backup with a recovery key, identity-change warnings, encrypted attachments, receipts, typing, reactions, replies, edits, redactions, local search, notifications. MatrixRTC calls with `livekit-client` and frame encryption (`services/chat/src/calls`). |
| Sign-in | **SSO only.** Synapse delegates to the portal's OIDC provider (`idp_id` `oidc-lumen`); password login is disabled on Lumen servers. Registration, account recovery, MFA and sessions live in the portal (`https://<domain>/accounts/…`). Login token flow: `GET /_matrix/client/v3/login/sso/redirect/oidc-lumen?redirectUrl=…` → portal → back to `redirectUrl?loginToken=…` → `POST /login` with `m.login.token`. Synapse's `sso.client_whitelist` lists the redirect targets that need no extra confirmation page. |
| Discovery | `https://<server-name>/.well-known/matrix/client` → `m.homeserver.base_url`. The web app also reads `/config.json` (brand, portal URL, calls). |
| Calls | `GET /_matrix/client/unstable/org.matrix.msc4143/rtc/transports` advertises `wss://rtc.<domain>`. SFU tokens come from `POST /_matrix/client/unstable/io.element.msc4195/rtc/livekit/get_token` (homeserver → lk-jwt-service, members only). Media keys are sent as Olm-encrypted to-device messages and rotated on membership change. |
| Push | **None.** No push gateway, no pushers; the web client shows notifications only while it is open. |
| Design | `design/tokens.css` (midnight/charcoal/cyan/teal palette, Inter + JetBrains Mono, radii, spacing), `design/icons` (Lucide, ISC), `branding/logo.svg`. |
| CI | None (`.github/` does not exist). Tests are run by scripts on a host with a test install. |

## Decisions

### D1. One protocol, one crypto implementation, four apps

Every app is a Matrix client of the same homeserver, uses the same SSO
sign-in, and holds its keys in the same Rust crypto core. That core is the
`matrix-sdk-crypto` crate (vodozemac):

- in the web and desktop apps it runs as WebAssembly (`matrix-sdk-crypto-wasm`);
- in the Android and iOS apps it runs as native code inside
  `matrix-sdk-ffi` (`org.matrix.rustcomponents:sdk-android`,
  `matrix-rust-components-swift`, both Apache-2.0).

So there is one key format, one verification protocol and one backup format:

- a phone verifies a desktop with emoji;
- a recovery key set up on the web restores history on an iPad.

Lumen writes no cryptographic protocol code anywhere.

### D2. Desktop (Windows, macOS): Electron, shipping the existing web client

| Option | Evidence for | Evidence against | Verdict |
|---|---|---|---|
| **Electron** | Same Chromium engine on Windows and macOS. The web client's frame-encrypted calls (insertable streams), simulcast and screen share are tested on Chromium. The real app can be launched and tested end to end on this Linux build host (Playwright's Electron driver under Xvfb). `safeStorage` uses DPAPI on Windows and Keychain on macOS. Mature signed auto-update (`electron-updater`: Authenticode check on Windows, Squirrel.Mac on macOS). Element Desktop uses it for the same protocol. | Larger download; Chromium's security updates must be tracked by re-releasing. | **Selected** |
| Tauri 2 | Small binaries, Rust backend, capability-based IPC | Two different engines: WebView2 (Chromium) on Windows, WKWebView (WebKit) on macOS. Frame encryption, `getDisplayMedia` and codec support differ per engine and would need separate verification. On Linux it would be WebKitGTK, whose WebRTC support is not usable for testing here, so the call path could not be verified anywhere in this environment. | Rejected for 1.x; revisit when the WebKit E2EE call path is verified |
| Native per OS (WinUI/SwiftUI) | Best OS integration | A third and fourth UI and call stack, more security-sensitive code duplicated | Rejected |

The desktop app **bundles** the web client build. It does not load
`https://app.<domain>`. The code that handles keys is therefore the code
that was signed and released with the app. This removes the web
delivery risk in [threat-model.md](../security/threat-model.md) ("malicious
web-app delivery") for desktop users.

Hardening:

- `contextIsolation`, `sandbox`, no Node in the renderer;
- a narrow preload API;
- strict CSP;
- navigation and new-window allow-lists;
- a custom `app://` origin;
- permission handler: camera, microphone, screen and notifications only.

### D3. Android and iOS/iPadOS: native UI on the Matrix Rust SDK

| Option | Evidence for | Evidence against | Verdict |
|---|---|---|---|
| **Kotlin + Jetpack Compose / Swift + SwiftUI on `matrix-sdk-ffi`** | Real native push handling (FCM, APNs) with a notification client that decrypts in the background; Keystore/Keychain; CallKit, `ConnectionService` and foreground services; native lifecycle. The FFI (checked in `sdk-android` 26.09.28 sources) provides: `startSsoLogin` and `SsoHandler`; `restoreSession`; `syncService`; `roomListService`; `timeline` (send, reply, react, edit, redact, attachments, read receipts, typing); `encryption()` (recovery, backups, verification state); `getSessionVerificationController` and user verification; `notificationClient` and `setPusher`; `ignoreUser`; search; and `makeWidgetDriver` with to-device filters, encrypted to-device, delayed events and RTC-transport discovery (MSC4515). This is the stack Element X uses for the same protocol. | Two UI code bases | **Selected** |
| Web client in a WebView (Capacitor) | One UI | IndexedDB crypto store at the mercy of WebView storage eviction; no reliable background decryption for push; CallKit and foreground-service integration through plugins | Rejected |
| Flutter / React Native + Rust SDK | One UI | No maintained official bindings; adds a bridge layer to security-sensitive code | Rejected |

Minimum OS versions:

- **Android 8.0 (API 26).** Needed for notification channels,
  `ConnectionService` self-managed calls and the Keystore features used. The
  Rust SDK itself supports API 21+.
- **iOS/iPadOS 17.** Needed for SwiftUI `Observable`, and for
  `RTCRtpScriptTransform` and `getUserMedia` in WKWebView, which call E2EE
  requires.

### D4. Calls on mobile: Lumen's own call widget driven by the Rust SDK widget driver

The Rust SDK does **not** implement MatrixRTC media-key management natively.
Element X solves this by running Element Call in a WebView, connected to the
Rust SDK through the Matrix widget API. Element Call is AGPL-3.0-only, so
Lumen does not embed it. Instead, the existing Lumen call implementation
(`services/chat/src/calls`) is built a second time as a **call widget**:

- `matrix-js-sdk`'s `RoomWidgetClient` replaces the full client;
- `MatrixRTCSession`, `livekit-client`, the E2EE worker and the call UI are the
  same code as the web and desktop apps.

The native app runs that widget in a system WebView and connects it to
`WidgetDriver`/`WidgetDriverHandle`. The widget gets only the capabilities
MatrixRTC needs:

- call-member state;
- encrypted `io.element.call.encryption_keys` to-device messages;
- delayed events;
- RTC transports;
- ring notifications.

The native layer owns everything around the call:

- **Android:** a self-managed `ConnectionService`, the foreground service
  (`phoneCall|microphone|camera`), audio routing (`AudioManager`, Bluetooth
  SCO/LE), ongoing-call notification, permissions.
- **iOS:** CallKit (`CXProvider`), `AVAudioSession`, PushKit/VoIP via the
  notification service extension
  (`CXProvider.reportNewIncomingVoIPPushPayload`), permissions.

Result:

- **one** implementation of MatrixRTC and media E2EE across all four
  platforms;
- calls interoperate between web, desktop, Android and iOS by construction;
- the encryption label logic is shared.

The widget is **bundled in the app**, not loaded from the server:

- Android serves it through `WebViewAssetLoader` (`https://appassets.androidplatform.net`,
  a secure context).
- iOS serves it through a `WKURLSchemeHandler`. If WebKit does not treat that
  scheme as a secure context (camera and microphone need one), the app loads
  the copy the operator's server serves at `https://app.<domain>/widget/call/`
  and says so in the about screen. See the integration doc for the exact
  contract.

### D5. Push: Synapse pushers → Sygnal → FCM / APNs, metadata-only payloads

- **Gateway.** Lumen adds the Matrix push gateway **Sygnal** (AGPL-3.0-only or Element
  commercial licence; the unmodified upstream image in its own container, like
  Synapse and lk-jwt-service) as an optional component (`PUSH_ENABLED`). It runs on the
  same server behind Caddy (`https://matrix.<domain>/_matrix/push/v1/notify`).
- **Credentials.** It is active only when the operator supplies the FCM
  service account and/or the APNs key.
- **Payload.** Apps register pushers with `format: "event_id_only"`, so
  Google and Apple see only room ID, event ID, unread count and timing,
  never message content. The app wakes, fetches the event and decrypts it
  locally:
  - Android: `NotificationClient` in a short-lived worker.
  - iOS: a Notification Service Extension sharing the app group's crypto
    store.

  It then shows a notification whose preview is hidden by default.
- **Desktop:** no push service. While running (also minimised to the tray),
  the app keeps its sync connection and shows OS notifications.

### D6. Configuration

All apps take their deployment settings from:

1. a build-time **default server**: `LUMEN_DEFAULT_SERVER`, a server name,
   not a URL; an empty value means the user is asked;
2. **runtime discovery** from the server the user picks:
   - `/.well-known/matrix/client` gives the homeserver;
   - its new `io.lumen.app` block gives portal, sign-up, account, privacy,
     help and push gateway URLs;
   - `/rtc/transports` gives calls;
   - `/login` gives the SSO provider.

No app contains a secret: public endpoints are not secrets. Credentials and
private keys are created at sign-in on the device and stored in the OS's
protected storage (D7).

Custom servers are allowed. URLs must be `https` (`http` only for loopback in
debug builds). Certificate validation is never disabled: the SDK's
`disableSslVerification` is not called anywhere, and a lint check enforces
this.

### D7. Local secrets

| Platform | Access token / session | Crypto and state store | App lock |
|---|---|---|---|
| Windows | DPAPI via Electron `safeStorage` wraps a random store key. The web client's sealed session secrets are encrypted under it; nothing is in plaintext on disk. | IndexedDB (Chromium profile), passphrase-protected Rust crypto store; passphrase sealed as above | App PIN (verifier derived with PBKDF2-SHA-256, 600 000 iterations, WebCrypto) + auto-lock timer |
| macOS | Keychain via `safeStorage` (same scheme) | same | App PIN; Touch ID through `systemPreferences.promptTouchID` where available |
| Android | Session JSON encrypted with an AES-GCM key in **Android Keystore** (StrongBox when available) | Rust SDK SQLite stores encrypted with a random passphrase that is itself Keystore-encrypted | `BiometricPrompt` (class 3) or device credential; `FLAG_SECURE` option |
| iOS/iPadOS | Keychain (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, app group for the NSE) | Rust SDK SQLite stores with a Keychain-held passphrase; files with `NSFileProtectionCompleteUntilFirstUserAuthentication` (the NSE must read them while locked) | Face ID / Touch ID via `LAContext` + passcode fallback |

App lock protects against someone picking up an unlocked device. It does not
protect against a compromised operating system, and the apps say so.

### D8. Design system

`design/tokens.css` stays the single source.
`design/tools/gen_tokens.py` generates:

- `apps/android/.../LumenTokens.kt`;
- `apps/ios/.../LumenTokens.swift`.

The desktop app uses the CSS directly. CI fails if the generated files are
out of date. Icons are Lucide everywhere (ISC):

- Android: vector drawables converted from `design/icons`;
- iOS: SF Symbols where an exact native equivalent exists, otherwise the
  Lucide PDF assets.

### D9. Build and release

GitHub Actions, one workflow per platform, with pinned tool versions:

| Platform | Runner | Toolchain |
|---|---|---|
| Desktop | `windows-latest`, `macos-latest`, `ubuntu-latest` | Node 22, electron-builder |
| Android | `ubuntu-latest` | JDK 21, Android SDK 36 |
| iOS | `macos-latest` | Xcode 26, XcodeGen |

Signing material comes only from repository or environment secrets. When a
secret is absent, the job still builds an unsigned artifact and the release
notes say "unsigned". Releases publish checksums (SHA-256) and an SBOM. Store
publication is a manual, documented step that needs the operator's own
developer accounts.

## Consequences

- Four installable apps share one protocol core, one crypto core and one
  call implementation. UI code is per platform (React for web and desktop,
  Compose, SwiftUI).
- **New server component:** the optional Sygnal gateway, with new operator
  secrets (FCM service account, APNs key) and new metadata exposure to
  Google and Apple, documented in the threat model: who receives a push,
  when.
- **Licences.** The desktop app bundles Chromium (Electron, MIT, plus
  Chromium's licences). The mobile apps bundle `matrix-sdk-ffi` (Apache-2.0)
  and the call widget (Lumen code, `matrix-js-sdk` and `livekit-client`, both
  Apache-2.0). Nothing AGPL is linked into an app.
- **What this environment can verify:**
  - Linux: the desktop app runs, and its Windows and macOS packages are built
    by CI.
  - Android: it builds here. No emulator (no KVM), so UI tests run only on CI
    or real devices.
  - iOS: builds only on CI.
  - Real-device tests (push, CallKit, Bluetooth, background) need hardware
    and developer accounts. They are listed as not done until someone runs
    them.
