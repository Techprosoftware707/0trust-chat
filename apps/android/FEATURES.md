# Android feature status

Legend:

- **Tested** — implemented, and its logic is covered by JVM unit tests that ran and passed
  (`./gradlew :app:testDebugUnitTest`, which includes `:core:test` and the shared vectors in
  `apps/shared/test-vectors`).
- **Tested on emulator** — covered by an instrumented test that passed in CI on an Android 15
  (API 35, google_apis x86_64) emulator: GitHub Actions runs 38704288600 and 38707281536 (commit
  26d856c), job "Instrumented tests (emulator)", 9 tests each: 8 passed, 1 skipped (needs
  `LUMEN_TEST_SERVER`), 0 failed.
- **Builds, unverified** — implemented against the real Matrix Rust SDK API (type-checked by
  the compiler against `sdk-android 26.09.28`), but not exercised: this build host has no
  emulator (no KVM) and no device, and the CI emulator tests do not sign in to a server.
- **Not implemented** — said plainly.

Nothing below has been exercised against a live Lumen server from this app. The call path
(widget driver + the native MSC4533/MSC4515 answers) was proven separately by the Rust widget
harness in `tests/apps/widget-harness`, not by this app.

| Area | Feature | Status | Notes / where |
|---|---|---|---|
| Config | `BuildConfig.DEFAULT_SERVER` from `lumen.defaultServer` (validated as a server name at build time) | Tested (build-time check) | `app/build.gradle.kts` |
| Config | URL policy: https only, no user-info, loopback http only in debug | Tested | `core/config/UrlPolicy.kt`, `url-validation.json` (21 cases), `UrlPolicyTest` |
| Config | `/.well-known/matrix/client` + `io.lumen.app` (version 1 only; bad links dropped; idp id pattern) | Tested | `WellKnownParser`, `wellknown.json` (7 cases) |
| Config | Discovery: well-known → `/versions` → `/login` flows; server name, Matrix ID or URL input | Tested (fake HTTP) / Builds, unverified (real network) | `ServerDiscovery`, `DiscoveryTest` |
| Auth | SSO via Custom Tabs, `startSsoLogin(redirectUrl, idpId)` → `SsoHandler.finish` | Builds, unverified | `SessionManager.startSso/finishSso`, `SsoCallbackActivity` |
| Auth | Per-attempt nonce in the redirect (`io.lumen.secure:/sso-callback?n=<nonce>`), stray/replayed callbacks ignored, single use, 15 min expiry, survives process death | Tested (routing, nonce, expiry) / Builds, unverified (end-to-end) | `DeepLinkRouter`, `SsoRedirect`, `deeplinks.json` (19 cases) |
| Auth | Password login only when the server offers it and no SSO | Builds, unverified | `AuthScreens.PasswordForm` |
| Auth | Sign-up button → `signup_url`; "Manage account" → `account_url`; "Delete account…" → `account_delete_url` (browser, shown only when the server advertises it) | Tested (parsing/validation, incl. shared vectors) / Builds, unverified (UI) | `SettingsScreen` |
| Auth | Device display name "Lumen on <model>" (PUT /devices after SSO; `SsoHandler.finish` takes no name) | Builds, unverified | `SessionManager.nameThisDevice` |
| Storage | Session JSON + 32-byte SQLite store key sealed with AES-256-GCM in Android Keystore (StrongBox when present, no user-auth binding) | Tested (vault logic with a software AES-GCM stand-in) / Tested on emulator (`KeystoreTest`: real AndroidKeyStore seal/open/wipe, ciphertext on disk) | `KeystoreKeyWrapper`, `SecretVault`, `SessionStore` |
| Storage | Rust SDK stores in `noBackupFilesDir/sessions/<random>`; `allowBackup=false`; data-extraction rules exclude everything | Tested on emulator (`backupIsDisabled`) | manifest, `xml/data_extraction_rules.xml` |
| Storage | Sign-out: server logout, then delete stores, cache, sealed session, Keystore key, prefs, WebView storage | Tested (wipe logic) / Builds, unverified (on device) | `SessionManager.signOut`, `AppGraph.onSignedOut` |
| Sessions | Device list (`GET /devices`), removal with UIA via the SSO fallback page in Custom Tabs | Builds, unverified | `DevicesApi`, `DevicesScreen`. Password-only UIA is **not implemented** (the app says to use the web app). |
| Sessions | Verification state per device | **Partly**: this device only | The SDK FFI exposes no per-device trust for other devices; the list says so. |
| Messaging | Room list from RoomListService (diffs), DMs/groups, unread/mentions, invites, filters (all/people/groups/unread/invites), name search | Builds, unverified | `RoomListController`, `RoomListScreen`; name filter logic Tested (`LocalSearch.filterRooms`) |
| Messaging | Timeline diffs; text, notices, emotes, replies, reactions (toggle), edits, redactions, images, files/video/audio (open/save) via SDK-decrypted media | Builds, unverified | `RoomController`, `TimelineMapper`, `RoomScreen` |
| Messaging | Formatted (HTML) bodies | **Not implemented** — shown as plain text body | deliberate: no HTML renderer |
| Messaging | Polls, live location, galleries, threads | **Not implemented** (shown as "not supported in this app yet" / body text) | |
| Messaging | Delivery state only from the SDK send state; local echo = Sending; Read only from someone else's receipt; Failed with retry/cancel | Tested (mapping) / Builds, unverified (UI) | `DeliveryStates`, `TimelineMapper.sendState`, `DeliveryMappingTest` |
| Messaging | Read receipts per setting: public (`m.read`), private (`m.read.private`), off (fully-read marker only) | Builds, unverified | `RoomController.markRead` |
| Messaging | Typing notices (throttled; setting) and typing indicator | Builds, unverified | |
| Messaging | Composer with Photo Picker / SAF attachments (encrypted upload by the SDK) | Builds, unverified | EXIF/location metadata in photos is **not** stripped. |
| Messaging | New DM (existing DM reused) / new encrypted group; invites accept/decline/decline-and-block; ignore/unignore users | Builds, unverified | `DirectChats`, `RoomInfoScreen`, `BlockedUsersScreen` |
| Messaging | Offline / reconnecting banner from SyncService state (offline mode on) | Builds, unverified | `MatrixSession` |
| Messaging | In-room search over loaded, decrypted history | Tested (search logic) / Builds, unverified (UI) | `LocalSearch`, `RoomScreen` |
| Encryption | Recovery setup (key shown once, confirm by typing its last 4 characters), recover with key, new key | Builds, unverified | `EncryptionController`, `EncryptionScreen` |
| Encryption | Own-device SAS emoji verification (outgoing and incoming) | Builds, unverified | `SessionVerificationController` |
| Encryption | Contact verification (`requestUserVerification`) | Builds, unverified | from room member menu |
| Encryption | Identity-change banner with acknowledge (pin) / withdraw verification | Builds, unverified | `subscribeToIdentityStatusChanges`, `UserIdentity.pin/withdrawVerification` |
| Encryption | Message authenticity shields (unverified device/identity) | Builds, unverified | `getShields` |
| Encryption | Security screen explaining protections and limits (no post-quantum claims) | Builds, unverified | `SecurityScreen` |
| App lock | BiometricPrompt (BIOMETRIC_STRONG \| DEVICE_CREDENTIAL; Android 8–10: WEAK \| DEVICE_CREDENTIAL, the platform's only supported combination), auto-lock timeout on a monotonic clock | Tested (timer) / Builds, unverified (prompt) | `AppLockTimer`, `AppLockManager`, `MainActivity.promptUnlock` |
| App lock | Optional FLAG_SECURE (screenshots, recents); says it does not protect against a compromised OS | Builds, unverified | |
| App lock | Call screen is not behind the app lock (answering from the lock screen) | by design | documented |
| Push | FCM optional at build time; manual Firebase init from `lumen.fcm.*`; no google-services.json | Builds, unverified | `PushManager` |
| Push | `setPusher` (http, `event_id_only`, app_id `<applicationId>.android`) only with `push_gateway_url` | Tested (policy) / Builds, unverified (registration) | `PusherPolicy`, `PushManager.register` |
| Push | FCM message → expedited WorkManager → `NotificationClient.getNotification` → notification | Builds, unverified | `LumenMessagingService`, `PushWorker` |
| Push | Preview hidden by default; sender / sender+text options; lock-screen version always hidden | Tested (policy) / Builds, unverified (posting) | `NotificationPreviewPolicy`, `Notifier` |
| Push | Channels (messages, calls, ongoing call, connection), POST_NOTIFICATIONS request on 13+ | Tested on emulator (`notificationChannelsExist`, `notificationPermissionIsRuntimeOnAndroid13`) / permission prompt UI unverified | |
| Push | Sync-delivered notifications while the app runs (`registerNotificationHandler`), de-duplicated by event ID | Builds, unverified | `AppGraph` |
| Push | Opt-in "Stay connected" foreground service (`specialUse`) | Tested on emulator (declared type) / Builds, unverified (running service) | `KeepConnectedService`; does not restart after reboot until the app is opened |
| Push | Actual delivery through Sygnal + FCM | **Unverified** (needs an FCM project, a server with `PUSH_ENABLED`, a device) | |
| Calls | Bundled widget via WebViewAssetLoader; absent widget → "Calls unavailable in this build", buttons hidden | Builds, unverified | `copyCallWidget`, `CallWidgetBundle` |
| Calls | Bridge exactly per integration.md §6.2 (addWebMessageListener, evaluateJavascript postMessage), filtering | Tested (filter, call-state parsing incl. the widget's real `{type,data}` shape, ack, JS generation) / Builds, unverified (WebView) | `WidgetBridge`, `CallWidgetHost` |
| Calls | `generateWebviewUrl` + `makeWidgetDriver`; capabilities exactly `getElementCallRequiredPermissions` | Builds, unverified | placeholders verified present in the native library |
| Calls | MSC4533 SFU token (`rtc_livekit_get_token`) and MSC4515 transports answered natively next to the driver (the pinned SDK can't serve them against Lumen): version/capability amendment, own room + own member ID only, access token never widget-bound, raw transports pass-through | Tested (routing, capability gating, room/member restriction, error envelope, token never in widget messages: `NativeRtcTest`) / Builds, unverified (in the WebView) | `NativeRtc`, `SessionHomeserverApi`; ported from the widget harness that proved a real E2EE call with the same driver revision |
| Calls | Call buttons only when the server advertises an RTC transport (raw `/rtc/transports`, not the SDK parser) | Tested (parser) / Builds, unverified | `CallSupport` |
| Calls | WebView camera/mic granted only for the widget origin, only while the call screen is visible, only with the runtime permission | Builds, unverified | `onPermissionRequest` |
| Calls | Jetpack Core-Telecom (`CallsManager`): system call, audio routing (earpiece/speaker/Bluetooth/wired via call endpoints), system mute → widget | Builds, unverified | `CallManager` |
| Calls | Ongoing-call notification (CallStyle), FGS `phoneCall\|microphone\|camera` | Tested on emulator (declared FGS types `phoneCall\|microphone\|camera`, not exported) / Builds, unverified (running service) | `CallService` |
| Calls | Incoming ring → full-screen CallStyle notification (USE_FULL_SCREEN_INTENT; Settings link on 14+ when not granted), answer, decline via `declineCall`, stop on decline elsewhere / answered elsewhere / call ended / timeout, missed-call notification | Builds, unverified | `CallManager.onIncomingRing` |
| Calls | `io.lumen.call_action` (hangup, mute/unmute from system); `io.lumen.call_state` drives Telecom + notification; E2EE label only from the widget's `e2ee` | Tested (messages, label mapping) / Builds, unverified | |
| Calls | Picture-in-picture for video calls (auto-enter on 12+) | Builds, unverified | |
| Calls | In-app controls for mute/camera/switch camera | Provided by the widget's own UI; native sends actions only for system events | |
| Calls | Network path | depends on the server: ICE/UDP, ICE/TCP 7881, TURN/UDP 3478. **TURN/TLS is not available** on Lumen servers (LiveKit 1.13 only advertises it on Caddy's :443), so networks that allow nothing but TCP 443 cannot carry calls. The app does not configure ICE itself. | |
| Deep links | `io.lumen.secure:` scheme only for SSO; `matrix.to` and `matrix:` (confirm before joining/starting a chat); App Links from `lumen.appLinkHosts` with `autoVerify` | Tested (routing) / Builds, unverified (intent delivery) | |
| UI | Material 3 with generated tokens (light/dark, dynamic colour off), Inter, adaptive + monochrome icon, SplashScreen, edge-to-edge, predictive back (`enableOnBackInvokedCallback`), two-pane ≥ 720 dp | Builds, unverified | |
| UI | TalkBack: content descriptions on icon buttons, badges, reactions, delivery state; headings | Builds, unverified (no TalkBack pass done) | |
| UI | Avatars | initials only (no remote avatar images fetched) | |
| Logging | Redacting logger; release builds: no debug logs, Rust SDK logs off; no crash/analytics SDKs | Tested (redactor) | `Redactor`, `LumenLog`, `RustPlatform` |
| Release | Env-var signing, R8 code shrinking + keep rules for JNA/uniffi (resource shrinking off, see README), AAB + per-ABI APKs + universal | Built locally and in CI (unsigned); signed build **unverified** here (no keystore); the R8-processed release build has not been run on a device | |
| Policy | `disableSslVerification` never referenced (Gradle check + unit test) | Tested | `checkNoTlsBypass`, `TlsPolicyTest` |
| Tests | Instrumented: launch → server picker, invalid input rejected without network, Keystore round trip, backup off, FGS types, channels, runtime permissions; server discovery test only with `LUMEN_TEST_SERVER` | Tested on emulator in CI (API 35): 8 passed, 1 skipped; not runnable on this build host (no KVM) | `app/src/androidTest` |
| UI | Launch on a fresh install → splash → server picker; invalid server input refused locally | Tested on emulator (`LaunchTest`) | |
