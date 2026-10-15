# How the Lumen apps connect to a Lumen server

This is the integration reference for the Windows, macOS, Android and
iOS/iPadOS apps. Every value below comes from what the server actually serves.
Architecture and rationale: [ADR 0003](../adr/0003-client-apps.md).

## 1. Identifiers

| Item | Value | Configurable by |
|---|---|---|
| Application ID / bundle ID | `io.lumen.secure` | Gradle property `lumen.applicationId`, XcodeGen `LUMEN_BUNDLE_ID`, electron-builder `appId` (white-label builds) |
| URL scheme (SSO return, deep links) | `io.lumen.secure` (reverse-DNS, RFC 8252 §7.1) | same as application ID |
| SSO redirect URI | `io.lumen.secure:/sso-callback` | — |
| Pusher `app_id` | `io.lumen.secure.android`, `io.lumen.secure.ios` | must match the Sygnal configuration |
| Display name | from the server's `io.lumen.app.brand` (fallback "Lumen Secure") | operator |

## 2. Server discovery (no source changes per deployment)

The user enters a **server name** (`example.com`) or a full Matrix ID. A build
can pre-fill one with `LUMEN_DEFAULT_SERVER`. Discovery steps:

1. `GET https://<server-name>/.well-known/matrix/client`:

   ```json
   {
     "m.homeserver": {"base_url": "https://matrix.example.com"},
     "io.lumen.app": {
       "version": 1,
       "brand": {"name": "Lumen Secure", "short_name": "Lumen"},
       "portal_url": "https://example.com",
       "signup_url": "https://example.com/accounts/signup/",
       "account_url": "https://example.com/portal/security/",
       "privacy_url": "https://example.com/privacy/",
       "help_url": "https://example.com/docs/",
       "sso_idp_id": "oidc-lumen",
       "web_app_url": "https://app.example.com",
       "call_widget_url": "https://app.example.com/widget/call/",
       "push_gateway_url": "https://matrix.example.com/_matrix/push/v1/notify"
     }
   }
   ```

   - `io.lumen.app` is optional. A plain Matrix server (another operator's
     Synapse, matrix.org) has none, and the apps then work as generic Matrix
     clients.
   - `push_gateway_url` is present only when the operator enabled push
     (`PUSH_ENABLED=true` with credentials).
   - Every URL is validated before use:
     - `https` only;
     - no user-info;
     - `http` accepted only for `localhost` in debug builds;
     - unknown keys are ignored;
     - a malformed URL is dropped, not followed.
2. `GET <base_url>/_matrix/client/versions` must answer; otherwise the user
   sees "not a Matrix server".
3. `GET <base_url>/_matrix/client/v3/login` lists the login flows.
   - Lumen servers offer `m.login.sso` (provider `oidc-lumen`) and
     `m.login.token`.
   - Password login is disabled on Lumen servers. The apps show a password
     form only if a server offers `m.login.password`.

The TLS certificate of every host is validated by the OS trust store. No app
has a switch to disable that. The Rust SDK's `disableSslVerification` must
never be called, and CI greps for it.

## 3. Sign-in, registration, sessions

Sign-in: the RFC 8252 browser flow.

1. The app opens
   `<base_url>/_matrix/client/v3/login/sso/redirect/oidc-lumen?redirectUrl=io.lumen.secure%3A%2Fsso-callback`
   in the **system browser**:
   - Android: Custom Tabs;
   - iOS: `ASWebAuthenticationSession`;
   - desktop: the default browser.

   It does not use an embedded WebView, so the app never sees the user's
   password or MFA codes.
2. Synapse sends the user to the portal (OIDC, PKCE). The user signs in with
   password and MFA, or **registers** there (`signup_url`).
3. Synapse redirects to `io.lumen.secure:/sso-callback?loginToken=…`.
   - The redirect URI is in Synapse's `sso.client_whitelist`, so there is no
     extra confirmation page.
   - The login token is single-use and short-lived.
4. The app logs in:
   - mobile: `SsoHandler.finish(callbackUrl)`;
   - desktop: `POST /login` with `m.login.token`.

   The device gets a display name like "Lumen on Pixel 9".

Sessions:

- **Sign out:** `POST /_matrix/client/v3/logout`. This invalidates the access
  token and deletes the device on the server. The app then deletes its local
  stores and keys.
- **Session revocation:**
  - other devices are listed with `GET /devices`;
  - removing one is `DELETE /devices/{id}` with user-interactive auth
    (`m.login.sso` fallback page, opened in the system browser);
  - portal sessions are managed in the portal's security centre
    (`account_url`).
- **Account recovery** (lost password or MFA) is a portal function. Encrypted
  **history** recovery uses the user's recovery key (§4).

## 4. End-to-end encryption

| | Web and desktop | Android and iOS |
|---|---|---|
| Crypto core | `matrix-sdk-crypto-wasm` (vodozemac) | `matrix-sdk-ffi` (same `matrix-sdk-crypto` crate, native) |
| Room encryption | Megolm; all Lumen rooms are encrypted | same |
| Device and user verification | SAS emoji (`m.sas.v1`), cross-signing | same: `SessionVerificationController` for own devices, `requestUserVerification` for contacts |
| Identity changes | banner and per-message warnings, "withdraw verification" | `hasVerificationViolation` / identity-reset status; banner and acknowledgement |
| Key backup and recovery | secret storage + online key backup, unlocked by the recovery key | `encryption().enableRecovery`, `recover(recoveryKey)` |

The formats are identical across apps, so a recovery key created in any app
works in every other one.

## 5. Messaging features and their protocol source

| Feature | Protocol | Notes |
|---|---|---|
| 1:1 and group rooms | `m.room.*`, `is_direct` + `m.direct` account data | rooms are created encrypted (`m.megolm.v1.aes-sha2`) |
| Send / receive | `m.room.message`, sent as `m.room.encrypted` | **"Sent"** = the server returned an event ID. **"Read"** = a receipt from someone else. A local echo is shown as "sending", never as delivered. |
| Replies, reactions, edits, deletion | `m.relates_to` (`m.in_reply_to`, `m.annotation`, `m.replace`), redactions | |
| Typing, read receipts | `m.typing`, `m.receipt` (`m.read` / `m.read.private`) | both can be turned off; private receipts are used when off |
| Files, images | encrypted attachments (`EncryptedFile`, AES-CTR + SHA-256) | upload limit from `GET /media/config` (plan-dependent on Lumen) |
| Search | client-side over decrypted, locally held history | the server cannot search encrypted rooms |
| Blocking | `m.ignored_user_list` account data | |
| Invitations | room invites (`/invite`), `matrix.to` links, portal workspace invitations (`/invite/<token>/`, opened in the browser) | |

## 6. Calls

**Discovery and tokens:**
1. `GET /_matrix/client/unstable/org.matrix.msc4143/rtc/transports` returns
   `[{type: "livekit", url: "wss://rtc.example.com"}]`.
2. SFU tokens come from
   `POST /_matrix/client/unstable/io.element.msc4195/rtc/livekit/get_token`.
   Only room members get one, it lasts one hour, and the participant identity
   is pseudonymous.

**Membership and keys:**
- Call membership is the MatrixRTC state event
  (`org.matrix.msc4143.rtc.member`, legacy `org.matrix.msc3401.call.member`).
- The "leave" is a delayed event, so it fires even if the app is killed.
- Each participant has their own media key, sent as an Olm-encrypted to-device
  message `io.element.call.encryption_keys`. Keys are rotated whenever someone
  joins or leaves.

**Ringing:**
- `org.matrix.msc4075.rtc.notification` (`notification_type: ring` for DMs,
  `notification` for groups) rings the other side.
- `org.matrix.msc4310.rtc.decline` declines.

### 6.1 Desktop

Desktop calls use the bundled web client's call implementation unchanged.

### 6.2 Mobile: the Lumen call widget

The mobile apps run the **Lumen call widget**, built from
`services/chat/src/calls` (`npm run build:widget` → `services/chat/dist-widget/`).
It runs in a system WebView. The Rust SDK's widget driver connects it to the
user's session, so the widget never holds an access token.

**Where the widget is loaded from:**

- **Android:** bundled in `assets/call-widget/`, served by `WebViewAssetLoader`
  at `https://appassets.androidplatform.net/call-widget/index.html`.
- **iOS:** bundled in `CallWidget/`, served by a `WKURLSchemeHandler` at
  `lumen-widget://call/index.html`. If `window.isSecureContext` is false
  there, the app loads `call_widget_url` from the server instead and shows
  that in Settings → About.

**Widget URL parameters** (filled with the Rust SDK's `generateWebviewUrl`):

```
?widgetId=$WIDGET_ID&parentUrl=<widget page origin>&roomId=$matrix_room_id
&userId=$matrix_user_id&deviceId=$org.matrix.msc3819.matrix_device_id
&baseUrl=$org.matrix.msc4039.matrix_base_url&lang=<lang>&theme=<light|dark>
&intent=<start_call|join_existing>&video=<true|false>&notify=<ring|notification|none>
```

**Bridge:** the same scheme Element X uses, so it works with stock
`matrix-widget-api`.

1. **Widget → native.** The widget page posts widget-API messages to
   `window.parent`, which is the page itself in a top-level WebView. Its
   shim (inside the widget code) forwards every message that is a
   `fromWidget` request or a `toWidget` response to the native object:
   - Android: `window.lumenNative.postMessage(json)` (`addJavascriptInterface`
     on API < 33 is **not** used; `WebViewCompat.addWebMessageListener`
     restricted to the asset origin is);
   - iOS: `window.webkit.messageHandlers.lumenNative.postMessage(json)`.
2. **Native → widget.** Native passes each string to
   `WidgetDriverHandle.send(json)`. Strings from `WidgetDriverHandle.recv()`
   are delivered with `window.postMessage(<json>, "<widget origin>")` through
   `evaluateJavascript`.
3. **Call-state events.** The widget sends `io.lumen.call_state` messages to
   the native object, with `{state: "connecting"|"connected"|"reconnecting"|"ended",
   video, muted, e2ee: "encrypted"|"waiting-for-key"|"not-encrypted"|…}`. The
   native layer uses them to drive CallKit / `ConnectionService`. These
   messages never contain keys.
4. **Native → widget actions.** Native sends `io.lumen.call_action` with
   `{action: "hangup"|"mute"|"unmute"|"video_on"|"video_off"|"switch_camera"}`,
   for example from the CallKit UI or a Bluetooth headset button.

**Capabilities.** The driver's capability provider grants exactly what
`getElementCallRequiredPermissions(userId, deviceId)` returns, because that is
the same MatrixRTC event set:

- read and send call-member state (own state key only);
- encrypted to-device `io.element.call.encryption_keys`;
- delayed events;
- RTC transports;
- `m.room.member` / `m.room.create` / name / avatar reads;
- RTC notification and decline send/read.

**Media permissions.** Camera and microphone come from the OS permission. The
WebView's permission request is granted only for the widget origin, and only
while a call screen is shown.

## 7. Push notifications

| | Android | iOS/iPadOS | Desktop |
|---|---|---|---|
| Transport | FCM (Firebase Cloud Messaging) data messages | APNs alert with `mutable-content: 1` | none |
| Pusher registration | `POST /_matrix/client/v3/pushers/set`: `kind: http`, `app_id: io.lumen.secure.android`, `pushkey: <FCM token>`, `data: {url: <push_gateway_url>, format: "event_id_only"}` | same, `app_id: io.lumen.secure.ios`, `pushkey: <APNs token hex>`, `default_payload: {aps: {mutable-content: 1, alert: {loc-key: "NEW_MESSAGE"}}}` | — |
| What Google or Apple see | room ID, event ID, unread count, sender server timing | same | — |
| Showing the notification | the FCM service starts a short `NotificationClient` fetch (decrypt locally), then posts a notification | the Notification Service Extension uses `NotificationClient` with the app-group store, replaces the generic text | the running app (also in the tray) shows OS notifications from sync |
| Preview | hidden by default ("New message"); the user can choose to show sender and/or text | same | same |
| Incoming calls | ring event → full-screen call notification + `ConnectionService` (`addNewIncomingCall`) | NSE → `CXProvider.reportNewIncomingVoIPPushPayload` → CallKit | ring event in sync → notification + in-app ringing |

Without a push gateway (`push_gateway_url` absent):

- **Android:** shows "Notifications only while the app runs". It can keep a
  sync foreground service, opt-in, with a persistent notification, which
  Android requires.
- **iOS:** shows notifications only when the app is in the foreground or in
  short background refreshes.

The apps say this in Settings. They never claim calls will ring reliably when
they cannot.

## 8. Deep links

| Link | Handled by |
|---|---|
| `io.lumen.secure:/sso-callback?loginToken=…` | sign-in completion only; ignored when no sign-in is pending (it is checked against a per-attempt nonce stored before opening the browser) |
| `https://matrix.to/#/<@user|#alias|!room>` and `matrix:` URIs | open a room or user; the user always confirms before joining or starting a chat |
| `https://<web_app_url>/#/room/<id>` | open a room (Android App Links / iOS universal links, which need the operator's `assetlinks.json` / `apple-app-site-association`; see §10) |
| `https://<portal>/invite/<token>/` | opened in the browser (workspace invitations are a portal function) |

## 9. Local data

See ADR 0003 D7. In summary:

- Tokens and store passphrases are kept in Keystore, Keychain or DPAPI (via
  `safeStorage`).
- Message stores are encrypted.
- Logs are redacted: no tokens, keys, message bodies or room names.
- There are no crash reporters sending data to third parties.
- Sign-out wipes everything the app stored for that account.

## 10. Server-side configuration for apps (`lumen.conf`)

| Setting | Effect |
|---|---|
| `APP_LINKS_ANDROID_SHA256` | SHA-256 fingerprint(s) of the Android signing certificate. Turns on `https://app.<domain>/.well-known/assetlinks.json`. |
| `APP_LINKS_APPLE_TEAM_ID` | Apple team ID. Turns on `https://app.<domain>/.well-known/apple-app-site-association`. |
| `PUSH_ENABLED`, `PUSH_FCM_PROJECT_ID`, `PUSH_APNS_TOPIC`, `PUSH_APNS_KEY_ID`, `PUSH_APNS_TEAM_ID` | The Sygnal push gateway. The secrets (FCM service-account JSON, APNs `.p8` key) are stored with `lumenctl set-secret push_fcm_service_account` / `push_apns_key`. |

The SSO redirect URI `io.lumen.secure:/sso-callback` is always allowed in
Synapse's `sso.client_whitelist`.
