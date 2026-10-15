# Lumen Secure for iPhone and iPad: feature status

Status values:

- **implemented**: built for iOS and covered by tests that passed (where:
  see the notes).
- **implemented-unverified**: the code exists, but the feature has not been
  built for iOS or run on a simulator or device yet.
- **not implemented**.

Current state (2026-10-15):

- Nothing in this app has been compiled with Xcode yet; CI on macOS is the
  first place it will be. So every row is at most *implemented-unverified*.
- The logic in `LumenCore` builds in Swift 6 mode and its 62 XCTest cases
  pass with Swift 6.3.3 on Linux, including all of `apps/shared/test-vectors`.
- The Matrix layer (`Lumen/Matrix`, SDK-facing `Lumen/Shared`)
  type-checks against the real `matrix-rust-components-swift` 26.10.02
  bindings and headers on Linux (`scripts/linux-check.sh`).
- These notes say where a row rests on that evidence. A row becomes
  *implemented* only after the simulator tests pass in CI; anything that
  needs hardware stays unverified until a device test is recorded.

## Sign-in and account

| Feature | iOS | Notes |
|---|---|---|
| Server picker with build-time default (`LUMEN_DEFAULT_SERVER`) | implemented-unverified | Input parsing and default-server handling unit-tested (LumenCore, Linux) |
| Discovery: well-known, `io.lumen.app`, `/versions`, `/login`, sliding-sync check | implemented-unverified | Parser and service unit-tested with a fake HTTP client, incl. shared vectors |
| URL policy (https only, no user-info, loopback http in Debug only) | implemented-unverified | Shared vectors pass (Linux) |
| SSO via `ASWebAuthenticationSession` + `startSsoLogin` / `SsoHandler.finish` | implemented-unverified | Nonce check unit-tested; SDK calls type-checked |
| Password login | not implemented | Lumen servers are SSO-only; the app explains this on password-only servers |
| Sign-up in Safari view (`signup_url`) | implemented-unverified | |
| Session in Keychain (AfterFirstUnlockThisDeviceOnly, shared group) | implemented-unverified | |
| Encrypted SQLite store in app group, random passphrase in Keychain, file protection | implemented-unverified | |
| Device named "Lumen on iPhone/iPad" after sign-in | implemented-unverified | `PUT /devices/{id}`; request unit-tested |
| Sign out (server logout, wipe stores, Keychain, settings) | implemented-unverified | Offers "this device only" when the server is unreachable |
| Devices list, remove with UIA (SSO fallback page) | implemented-unverified | API and UIA parsing unit-tested |
| Verified state of *other* own devices in the list | not implemented | The SDK FFI has no per-device trust API; only this device's state is shown |
| Manage account link (`account_url`) | implemented-unverified | |
| Multiple accounts | not implemented | |

## Messaging

| Feature | iOS | Notes |
|---|---|---|
| Room list (RoomListService, dynamic adapters), unread and mention badges | implemented-unverified | Diff application unit-tested |
| Room search filter | implemented-unverified | SDK `normalizedMatchRoomName` filter |
| Timeline with diff updates, back-pagination, date dividers, read marker | implemented-unverified | |
| Text (inline Markdown), emotes, notices | implemented-unverified | |
| Replies, reactions, edits, deletion | implemented-unverified | |
| Images and files (encrypted attachments by the SDK), preview with Quick Look | implemented-unverified | |
| Video / audio messages | implemented-unverified (as files) | Opened in Quick Look; no inline player or voice messages |
| Delivery state from SDK send state (Sending / Sent / Read / Not sent + retry) | implemented-unverified | Mapping unit-tested: a local echo is never "delivered" |
| Read receipts public or private per setting | implemented-unverified | |
| Typing notices with toggle | implemented-unverified | |
| Start DM (encrypted, trusted private chat) / create encrypted group | implemented-unverified | |
| Accept / decline / block from invitations | implemented-unverified | |
| Block (ignore) and unblock users | implemented-unverified | |
| Report a message (App Review 1.2) | implemented-unverified | `Room.reportContent` |
| `matrix.to` / `matrix:` / web-app links, with confirmation | implemented-unverified | Router unit-tested incl. shared vectors |
| Offline / reconnecting / error banner from SyncService state | implemented-unverified | Banner logic unit-tested |
| Message search | not implemented | |
| Threads, polls (voting), stickers, location, spaces | not implemented | Shown as placeholder text in the timeline |
| Room settings (rename, topic, avatar, permissions) | not implemented | Use the web app |
| User and room avatars (images) | not implemented | Initials only |
| Link previews | not implemented | Deliberately: previews would leak URLs to the server |

## Encryption and verification

| Feature | iOS | Notes |
|---|---|---|
| Set up recovery: key shown once, typed back to confirm | implemented-unverified | Confirmation rule unit-tested |
| Recover with key; change recovery key | implemented-unverified | |
| Verify this device with another device (SAS emoji) | implemented-unverified | SessionVerificationController |
| Accept incoming verification requests | implemented-unverified | |
| Verify a contact (user verification) | implemented-unverified | |
| Identity-change banner with acknowledge / withdraw verification | implemented-unverified | Warning logic unit-tested |
| Unable-to-decrypt explanations | implemented-unverified | |
| "How your data is protected" screen (no PQ claims) | implemented-unverified | |

## App lock and privacy

| Feature | iOS | Notes |
|---|---|---|
| Face ID / Touch ID / passcode lock with timeout | implemented-unverified | Timer logic unit-tested (monotonic clock) |
| Privacy cover in the app switcher | implemented-unverified | |
| Statement that app lock doesn't protect against a compromised OS | implemented-unverified | Settings and security screen |
| Redacted on-device diagnostics log | implemented-unverified | Redactor unit-tested |

## Notifications

| Feature | iOS | Notes |
|---|---|---|
| Pusher (`event_id_only`, `mutable-content`) only with `push_gateway_url` | implemented-unverified | Payload unit-tested |
| NSE decrypting with NotificationClient and the shared store | implemented-unverified | Needs a device and a push gateway |
| Preview policy (hidden by default / sender / sender and text) | implemented-unverified | Policy unit-tested |
| Explanation when push is unavailable (no gateway, permission denied) | implemented-unverified | Unit-tested: never claims calls ring without a gateway |
| Local notifications from sync while running / background refresh | implemented-unverified | |

## Calls

| Feature | iOS | Notes |
|---|---|---|
| Lumen call widget in WKWebView via `lumen-widget://` scheme handler | implemented-unverified | Path resolver unit-tested; the widget build (`build:widget`) doesn't exist yet in `services/chat` |
| Secure-context check, fallback to the server's `call_widget_url`, shown in About | implemented-unverified | Needs a device |
| Widget bridge (integration.md §6.2): filtering, `io.lumen.call_state`, `io.lumen.call_action` | implemented-unverified | Filter and script escaping unit-tested |
| Capabilities = `getElementCallRequiredPermissions` | implemented-unverified | App-level test in LumenTests |
| Camera/microphone granted only to the widget origin while the call screen shows | implemented-unverified | |
| CallKit start / answer / decline (MSC4310 decline via SDK) / end / mute | implemented-unverified | |
| Ring cancelled when declined on another device or expired | implemented-unverified | |
| Incoming ring via NSE → PushKit → CallKit | implemented-unverified | Needs a device |
| Audio session, Bluetooth/AirPlay route picker, speaker | implemented-unverified | Needs a device |
| Camera switch, video on/off | implemented-unverified | Sent to the widget as actions |
| Encryption label from the widget's `e2ee` state only | implemented-unverified | Label rule unit-tested |
| Call history from the timeline (rtc notifications) | implemented-unverified | Outcome rules unit-tested |
| Picture-in-picture | implemented-unverified (configuration only) | `allowsPictureInPictureMediaPlayback`; depends on the widget |
| Screen sharing | not implemented | |

## Platform and UI

| Feature | iOS | Notes |
|---|---|---|
| iPhone and iPad (NavigationSplitView) | implemented-unverified | |
| Light and dark themes from `design/tokens.css` | implemented-unverified | Tokens generated; CI checks they are current |
| Dynamic Type (system text styles), VoiceOver labels | implemented-unverified | Not audited with VoiceOver yet |
| App icon and launch screen from `branding/logo.svg` | implemented-unverified | Rendered by `scripts/gen-app-icon.py` |
| Privacy manifest, usage descriptions, export-compliance key | implemented-unverified | See docs/apps/release-ios.md |
| iPad multiple windows | not implemented | Single scene |
