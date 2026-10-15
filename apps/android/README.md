# Lumen Secure for Android

Native Android client for Lumen (Kotlin, Jetpack Compose, Material 3) on the Matrix Rust SDK
(`org.matrix.rustcomponents:sdk-android:26.09.28`). Decisions: [ADR 0003](../../docs/adr/0003-client-apps.md).
Server contract: [docs/apps/integration.md](../../docs/apps/integration.md). Feature status, honestly
marked: [FEATURES.md](FEATURES.md). Store/release steps: [docs/apps/release-android.md](../../docs/apps/release-android.md).

## Requirements

| Tool | Version |
|---|---|
| JDK | 21 (bytecode target 17) |
| Gradle | wrapper, 8.14.3 (distribution SHA-256 pinned in `gradle/wrapper/gradle-wrapper.properties`) |
| Android Gradle Plugin | 8.13.2 (the newest that runs on Gradle 8.14) |
| Kotlin | 2.3.21, Compose compiler plugin 2.3.21 |
| Android SDK | platform `android-36`, build-tools `36.1.0` |
| minSdk / targetSdk / compileSdk | 26 / 36 / 36 |

Library versions are pinned in [`gradle/libs.versions.toml`](gradle/libs.versions.toml). Some
AndroidX releases from autumn 2026 (core 1.19, Compose 1.12 / BOM 2026.09) require compileSdk 37
and AGP 9.1; they are deliberately not used (see the comment at the top of the catalog).

Point Gradle at the SDK with `ANDROID_HOME` (or `sdk.dir` in an untracked `local.properties`).

## Build and test

```sh
cd apps/android
./gradlew :app:testDebugUnitTest          # JVM tests: :app and :core (incl. apps/shared/test-vectors)
./gradlew :app:lintDebug                  # Android lint, fails on errors (app/lint.xml)
./gradlew :app:assembleDebug              # debug APKs (per ABI + universal)
./gradlew :app:assembleRelease :app:bundleRelease   # release APKs + AAB (unsigned without the env below)
./gradlew :app:connectedDebugAndroidTest  # instrumented tests: needs a device or emulator
./gradlew --stop
```

`checkNoTlsBypass` (root project) runs before every app build and with `check`: it fails if
`disableSslVerification`, `disableBuiltInRootCertificates`, trust-all hostname verifiers or
cleartext switches appear in `app/src` or `core/src` (the only allowed cleartext switch is the
debug-only loopback rule in `app/src/debug/res/xml/network_security_config.xml`).
`core/src/test/.../TlsPolicyTest.kt` asserts the same in the unit tests.

Instrumented tests run without a server. `LaunchTest.discoversConfiguredTestServer` is skipped
unless a server is passed:
`./gradlew connectedDebugAndroidTest -Pandroid.testInstrumentationRunnerArguments.LUMEN_TEST_SERVER=example.com`.

## Configuration (Gradle properties)

Set in `~/.gradle/gradle.properties`, with `-P…`, or as `ORG_GRADLE_PROJECT_<name>` environment
variables. Empty values count as unset.

| Property | Default | Effect |
|---|---|---|
| `lumen.applicationId` | `io.lumen.secure` | Application ID **and** URL scheme (`<id>:/sso-callback`); pusher `app_id` becomes `<id>.android`. White-label builds change it. |
| `lumen.defaultServer` | empty | Pre-filled server name (`example.com`, not a URL). Empty: the user types one. |
| `lumen.appLinkHosts` | empty | Comma-separated hosts for verified App Links (usually `app.<domain>`); generates an `autoVerify` intent filter. Empty: no https intent filter except matrix.to. |
| `lumen.versionCode`, `lumen.versionName` | `1`, `1.0.0` | Version. |
| `lumen.fcm.projectId`, `lumen.fcm.appId`, `lumen.fcm.apiKey`, `lumen.fcm.senderId` | empty | Firebase identifiers (public, but not committed). All four or none. None: push is off and Settings says "Notifications only while the app runs". |

No `google-services.json` is used or needed: Firebase is initialised in code from these values,
and `FirebaseInitProvider` is removed from the manifest so nothing starts on its own.

Release signing comes only from the environment (absent → unsigned release):
`LUMEN_ANDROID_KEYSTORE_PATH`, `LUMEN_ANDROID_KEYSTORE_PASSWORD`, `LUMEN_ANDROID_KEY_ALIAS`,
`LUMEN_ANDROID_KEY_PASSWORD`.

## Call widget

`services/chat` builds the Lumen call widget (`npm run build:widget` → `services/chat/dist-widget/`).
The `copyCallWidget` task copies it into the APK's `assets/call-widget/` at build time. If the
directory does not exist the build still succeeds, the call buttons are hidden and the app says
"Calls unavailable in this build" (About screen, incoming-call notification). There is no
placeholder call UI.

Bridge (integration.md §6.2): `WebViewAssetLoader` at
`https://appassets.androidplatform.net/call-widget/index.html`; widget → native through
`WebViewCompat.addWebMessageListener(webView, "lumenNative", {asset origin})` (no
`addJavascriptInterface`); native → widget with `evaluateJavascript("window.postMessage(<json>, origin)")`.
`core/.../calls/WidgetBridge.kt` decides what is forwarded to the Rust `WidgetDriverHandle` (only
`fromWidget` requests and `toWidget` responses for this widget ID, never `io.lumen.*` actions),
what drives the native call UI (`io.lumen.call_state`, flat, nested under `data`, or as an
acknowledged `fromWidget` request) and what is dropped.

URL template placeholders are the ones compiled into this SDK build (checked in
`libmatrix_sdk_ffi.so`): `$matrix_widget_id`, `$matrix_room_id`, `$matrix_user_id`,
`$org.matrix.msc2873.matrix_device_id`, `$org.matrix.msc4039.matrix_base_url`.

## Architecture

```
apps/android
├── core/   pure Kotlin/JVM, no Android or SDK types — unit-tested on the JVM
│   ├── config/      UrlPolicy (https / loopback-http-in-debug / no user-info), WellKnownParser
│   │                (io.lumen.app block), ServerInput, ServerDiscovery (well-known → versions → login)
│   ├── auth/        SSO nonce: redirect io.lumen.secure:/sso-callback?n=<nonce>, constant-time check
│   ├── deeplink/    DeepLinkRouter (SSO callback, matrix.to, matrix:, App Link hosts)
│   ├── messaging/   DeliveryState mapping (Sending / Sent / Read / Failed; never "delivered" while queued)
│   ├── notifications/ preview policy (hidden by default / sender / sender + text)
│   ├── calls/       WidgetBridge filter, call-state parsing, widget URL template, E2EE label
│   ├── security/    SecretVault + SealedBlob (AES-GCM blobs, name bound as AAD), StoredSession,
│   │                AppLockTimer (monotonic clock)
│   ├── push/        event_id_only payload parsing, pusher policy
│   ├── search/      local search over decrypted history, room-name filter
│   └── log/         Redactor (IDs, tokens, recovery keys, URLs, e-mails, long secrets)
└── app/    Android
    ├── LumenApplication, AppGraph      manual DI; process lifecycle → sync start/stop, app lock
    ├── security/   KeystoreKeyWrapper (AES-256-GCM, StrongBox when present, no auth binding),
    │               FileBlobStorage (noBackupFilesDir/vault), SessionStore, AppLockManager
    ├── matrix/     SessionManager (ClientBuilder on SQLite stores keyed by a Keystore-sealed
    │               32-byte key, SSO/password login, restore, sign-out + wipe), MatrixSession
    │               (SyncService state → offline/reconnecting banner), RoomListController
    │               (RoomListService diffs), RoomController (Timeline diffs, send/reply/edit/
    │               react/redact/attachments, receipts, typing, identity changes),
    │               EncryptionController (recovery, backup, SAS verification), TimelineMapper
    ├── auth/       AuthController (discovery, Custom Tabs SSO), SsoCallbackActivity
    ├── push/       PushManager (manual Firebase init, setPusher), LumenMessagingService,
    │               PushWorker (expedited WorkManager → NotificationClient.getNotification), Notifier
    ├── calls/      CallManager (Jetpack Core-Telecom CallsManager), CallActivity, CallWidgetHost,
    │               CallService (FGS phoneCall|microphone|camera), CallActionReceiver
    ├── sync/       KeepConnectedService (opt-in, FGS specialUse)
    ├── net/        PlatformHttp (discovery, devices), DevicesApi (GET/PUT/DELETE /devices + UIA)
    └── ui/         Compose: theme from generated LumenTokens.kt, screens, two-pane ≥ 720 dp
```

`app/src/main/java/io/lumen/secure/ui/theme/LumenTokens.kt` is generated from
`design/tokens.css` by `python3 design/tools/gen_tokens.py` — never edit it by hand.

## Assets and licences

- Fonts: Inter and JetBrains Mono (SIL OFL 1.1) from `design/fonts`, converted from WOFF2 to TTF
  (Android font resources cannot load WOFF2) with fontTools (`TTFont(src).flavor = None`).
  Licences in `app/src/main/assets/licenses/`, shown in Settings → About → Open-source licences.
- Icons: Lucide (ISC), converted to VectorDrawables by `tools/lucide_to_vector.py` from
  `design/icons` (and, for icons that set lacks, the same Lucide release in
  `services/chat/node_modules/lucide-react`). Licence in `assets/licenses/LICENSE-lucide.txt`.
- Launcher icon: adaptive (background, foreground with the logo's gradients, monochrome for
  themed icons) hand-converted from `branding/logo.svg`.

## Known build-host notes

- Maven Central sometimes answers HTTP 429 for the 104 MB `sdk-android` AAR on busy shared hosts;
  `gradle.properties` raises Gradle's repository retry count. Re-run if it still fails.
- Release builds use R8 code shrinking but not resource shrinking: with ABI splits enabled,
  AGP 8.13 refuses to build the AAB in the same Gradle invocation as the split APKs when
  resources are shrunk (issuetracker.google.com/402800800).
- The universal APK is large (~270 MB debug) because it carries the Rust SDK for four ABIs;
  ship per-ABI APKs or the AAB (Play splits per ABI).
