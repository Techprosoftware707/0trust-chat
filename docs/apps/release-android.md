# Releasing the Android app

Build instructions: [apps/android/README.md](../../apps/android/README.md). Feature status:
[apps/android/FEATURES.md](../../apps/android/FEATURES.md). Server contract:
[integration.md](integration.md). Decisions: [ADR 0003](../adr/0003-client-apps.md).

## 1. Identifiers

| Item | Value | Where it is set |
|---|---|---|
| Application ID (Play package name) | `io.lumen.secure` | Gradle property `lumen.applicationId` (white-label builds use their own) |
| URL scheme (SSO return only) | same as the application ID: `io.lumen.secure:/sso-callback` | follows `lumen.applicationId`; the server must whitelist it (`sso.client_whitelist`) |
| Pusher `app_id` | `io.lumen.secure.android` (`<applicationId>.android`) | must equal Sygnal's app key (`PUSH_ANDROID_APP_ID` in `lumen.conf`) |
| App Links package | `io.lumen.secure` | `APP_LINKS_ANDROID_PACKAGE` in `lumen.conf` |
| Version | `lumen.versionCode` / `lumen.versionName` | increase `versionCode` for every upload |

A white-label build changes `lumen.applicationId` **and** the server settings that name it
(`APP_URL_SCHEME`, `APP_LINKS_ANDROID_PACKAGE`, `PUSH_ANDROID_APP_ID`).

## 2. Signing

The build reads the upload key only from the environment:

```sh
export LUMEN_ANDROID_KEYSTORE_PATH=/secure/lumen-upload.jks
export LUMEN_ANDROID_KEYSTORE_PASSWORD=…
export LUMEN_ANDROID_KEY_ALIAS=upload
export LUMEN_ANDROID_KEY_PASSWORD=…
./gradlew :app:bundleRelease :app:assembleRelease
```

Without them the release APKs and AAB are **unsigned** (CI says so in a notice); they are useful
for inspection, not for installing. Keystores are never committed (`.gitignore` blocks `*.jks`,
`*.keystore`, `*.p12`).

Create an upload key once:

```sh
keytool -genkeypair -v -keystore lumen-upload.jks -alias upload -keyalg RSA -keysize 4096 -validity 10000
```

**Play App Signing** (required for AABs): enrol the app, let Google generate (or upload) the
app signing key, and register the upload key above. Afterwards:

- App Links: put the **app signing key's** SHA-256 fingerprint (Play Console → Setup → App
  signing) into `APP_LINKS_ANDROID_SHA256` on the server, plus the upload key's fingerprint if
  you also distribute APKs signed with it. The server then serves `/.well-known/assetlinks.json`
  on `app.<domain>`; build the app with `-Plumen.appLinkHosts=app.<domain>`.
- Side-loaded APKs (direct download) must be signed with a key whose fingerprint is in
  `APP_LINKS_ANDROID_SHA256` too, or App Links fall back to the disambiguation dialog.

## 3. Artifacts

| Output | Path | Use |
|---|---|---|
| AAB | `app/build/outputs/bundle/release/app-release.aab` | Google Play (Play splits it per ABI/density) |
| Per-ABI APKs | `app/build/outputs/apk/release/app-{arm64-v8a,armeabi-v7a,x86_64,x86}-release*.apk` | direct download; most phones need `arm64-v8a` |
| Universal APK | `app/build/outputs/apk/release/app-universal-release*.apk` | all ABIs in one file (large: four copies of the Rust SDK) |

Sizes of the unsigned 1.0.0 release built on 2026-10-15 (call widget bundled): AAB 102 MiB;
APKs `arm64-v8a` 66 MiB, `armeabi-v7a` 46 MiB, `x86_64` 72 MiB, `x86` 76 MiB, universal 245 MiB.
`libmatrix_sdk_ffi.so` alone is 61 MiB (arm64-v8a); Play's per-device download from the AAB is
roughly the size of the matching per-ABI APK.

Native libraries: `arm64-v8a` and `x86_64` of `libmatrix_sdk_ffi.so` are 16 KB page aligned
(checked with `readelf`, LOAD alignment `0x4000`), which Google Play requires for apps targeting
Android 15+. Libraries are stored uncompressed (`useLegacyPackaging = false`).

Publish SHA-256 checksums with every release (CI writes `SHA256SUMS-android.txt`).

## 4. Permissions and Play Console declarations

| Permission | Why | Play Console |
|---|---|---|
| `INTERNET`, `ACCESS_NETWORK_STATE` | Matrix sync, media, calls | — |
| `POST_NOTIFICATIONS` (runtime, 13+) | message and call notifications | — |
| `RECORD_AUDIO`, `CAMERA` (runtime, asked when a call starts) | calls | — |
| `MODIFY_AUDIO_SETTINGS`, `BLUETOOTH_CONNECT` | call audio routing (Core-Telecom endpoints, Bluetooth headsets) | — |
| `MANAGE_OWN_CALLS` | self-managed calls in the system Telecom stack (Core-Telecom; ConnectionService on Android 8–13, transactional call API on 14+) | — |
| `USE_FULL_SCREEN_INTENT` | full-screen incoming-call screen | **Full-screen intent declaration**: category "Calling". On Android 14+ the permission is auto-granted only to apps whose core function is calling; Lumen offers voice/video calls as a core function. If not granted, Settings shows a shortcut to the system page and incoming calls appear as heads-up notifications. |
| `FOREGROUND_SERVICE` + `FOREGROUND_SERVICE_PHONE_CALL`, `…_MICROPHONE`, `…_CAMERA` | `CallService`: keeps an ongoing call alive with its notification; types `phoneCall\|microphone\|camera` (camera only for video calls) | **Foreground service declaration**: "Phone call" (ongoing VoIP call started or answered by the user), "Microphone" and "Camera" (used during the call). Provide a short video of starting a call and backgrounding the app. |
| `FOREGROUND_SERVICE_SPECIAL_USE` | `KeepConnectedService` ("Stay connected"), **off by default**, only for builds/servers without push | **Special use** with the subtype declared in the manifest (`PROPERTY_SPECIAL_USE_FGS_SUBTYPE`): "keeps the end-to-end-encrypted Matrix sync connection open so messages and calls arrive when no push service is configured". `dataSync` was not used because Android 15 stops `dataSync` services after 6 hours a day. If Google rejects the special-use declaration, ship the Play build with FCM configured and remove the toggle (the code path is optional). |
| `FOREGROUND_SERVICE_DATA_SYNC` | WorkManager's expedited push worker runs as a short `dataSync` foreground service on Android 11 and lower | **Data sync**: "fetches and decrypts the new message a push notification refers to; runs for seconds". |
| `USE_BIOMETRIC` | optional app lock | — |
| `VIBRATE`, `WAKE_LOCK` (WorkManager) | notifications, background work | — |

No location, contacts, SMS, phone-state, storage or `QUERY_ALL_PACKAGES` permissions are used.
Attachments come from the system Photo Picker and Storage Access Framework.

## 5. Data safety form (Play Console)

Answer for the app as shipped (operators run their own servers; Lumen as the developer does not
receive this data unless it operates the server, e.g. the hosted service):

| Question | Answer |
|---|---|
| Does the app collect or share user data? | **Yes, collected** (sent to the user's chosen Matrix server to provide the service). Not shared with third parties, except push metadata to Google (below). |
| Encrypted in transit? | Yes (TLS; message content additionally end-to-end encrypted). |
| Can users request deletion? | Yes: sign-out deletes local data; Settings → "Delete account…" opens the operator's account-deletion page (`account_delete_url`, shown when the server advertises it), which also serves as the "account deletion" link Play requires (enter the same URL in the Data safety form). |
| Personal info | Name (display name), user IDs — collected, required, app functionality. E-mail is handled by the portal in the browser, not by the app. |
| Messages | "Other in-app messages" — collected (stored on the server **end-to-end encrypted**; the server cannot read them), app functionality. |
| Photos/videos, files | collected only when the user sends them, end-to-end encrypted, app functionality. |
| Audio | voice/video calls — media is end-to-end encrypted between participants when the call screen says so; nothing is recorded or stored. |
| Contacts, location, health, financial, web history | not collected. |
| App activity, app info and performance, crash logs, diagnostics | **not collected** — no analytics or crash-reporting SDKs. |
| Device or other IDs | Matrix device ID (generated at sign-in), app functionality; FCM registration token when push is enabled (shared with Google as the push transport). |
| Push notifications (FCM) | Google receives the FCM token and, per push, the room ID, event ID and unread count (`event_id_only` format) — never message content. Disclose under "Device or other IDs" → shared with Google for app functionality. Builds without FCM identifiers share nothing with Google. |

Privacy policy URL: the operator's `privacy_url`.

## 6. Firebase Cloud Messaging and Sygnal

1. Create a Firebase project (console.firebase.google.com). Disable Google Analytics for it.
2. Add an Android app with package `io.lumen.secure` (or your `lumen.applicationId`). You may
   download `google-services.json` to read the values, but **do not add it to the repository**;
   the build does not use it.
3. Build with the four public identifiers (from that file or Project settings):

   | Gradle property | `google-services.json` field |
   |---|---|
   | `lumen.fcm.projectId` | `project_info.project_id` |
   | `lumen.fcm.appId` | `client[].client_info.mobilesdk_app_id` |
   | `lumen.fcm.apiKey` | `client[].api_key[].current_key` |
   | `lumen.fcm.senderId` | `project_info.project_number` |

   In CI they come from repository *variables* (not secrets): `LUMEN_FCM_PROJECT_ID`,
   `LUMEN_FCM_APP_ID`, `LUMEN_FCM_API_KEY`, `LUMEN_FCM_SENDER_ID`. Restrict the API key in Google
   Cloud to the Firebase Installations and FCM Registration APIs and to the app's package and
   signing-certificate fingerprints.
4. Server: create a service account with the "Firebase Cloud Messaging API Admin" role (FCM
   HTTP v1), download its JSON key and install it as a server secret:
   `lumenctl set-secret push_fcm_service_account < key.json`; set `PUSH_ENABLED=true` and
   `PUSH_FCM_PROJECT_ID=<project id>` in `lumen.conf` and apply. Lumen renders Sygnal's
   `apps: {io.lumen.secure.android: {type: gcm, api_version: v1, project_id, service_account_file}}`
   and advertises `push_gateway_url` in `/.well-known/matrix/client`.
5. The app registers a pusher (`kind: http`, `format: event_id_only`, `app_id:
   io.lumen.secure.android`) when it sees `push_gateway_url`. Settings → Notifications → Delivery
   shows the result.

## 7. Internal testing → production

1. `./gradlew :app:testDebugUnitTest :app:lintRelease :app:bundleRelease` with the upload key.
2. Play Console → Testing → **Internal testing**: upload the AAB, add testers, complete the
   declarations in §4 and the Data safety form in §5, content rating, target audience (not for
   children), app access (provide a test account on a test server: SSO login page credentials).
3. On real devices (at least: one Android 8/9 device, one Android 14+, one Android 15+ with
   16 KB pages if available, one tablet) run the manual checks in §8.
4. **Closed testing** with a wider group; watch Android vitals (crashes are only visible there:
   the app has no crash reporter).
5. **Production**: staged rollout (e.g. 10 % → 50 % → 100 %).
6. Publish the per-ABI and universal APKs with `SHA256SUMS-android.txt` for direct download,
   signed with a key listed in `APP_LINKS_ANDROID_SHA256`.

## 8. Not verified (needs devices, accounts or a live server)

Everything in [FEATURES.md](../../apps/android/FEATURES.md) marked "Builds, unverified", in
particular:

- SSO round trip in Custom Tabs against a Lumen server, including the nonce surviving process
  death while the browser is open;
- sliding sync, room list, timeline, sending, attachments, receipts, typing on a real account;
- recovery set-up/recover and SAS verification with another client (web or iOS);
- push delivery through Sygnal + FCM, background decryption with the screen locked, Doze;
- calls: widget in the WebView with the Rust widget driver, media E2EE label, Core-Telecom on
  Android 8–13 (ConnectionService path) and 14+, Bluetooth/wired/speaker routing, full-screen
  incoming call on the lock screen, PiP, decline sending the RTC decline;
- App Links verification with a deployed `assetlinks.json`;
- StrongBox key generation on a device that has StrongBox;
- TalkBack pass, large-screen layouts on a real tablet/foldable;
- signed release build and Play pre-launch report.
