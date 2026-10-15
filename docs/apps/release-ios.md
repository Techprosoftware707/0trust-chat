# Releasing the iOS/iPadOS app

Building, signing and publishing Lumen Secure for iPhone and iPad. The app's
source and local build: [apps/ios/README.md](../../apps/ios/README.md).
Shared pipeline, versions and secrets: [release.md](release.md).

Nothing in this guide has been carried out end to end yet: no Apple developer
account was available while the app was written. Each step is what the
project and the code are prepared for; the [last section](#what-has-not-been-verified)
lists what still has to be tried on real devices and in App Store Connect.

## 1. What you need

- An **Apple Developer Program** membership. Publish as an organisation
  (needs a D-U-N-S number) so the seller name matches your company.
- A Mac with **Xcode 26** for local signing, or the CI workflow
  (`.github/workflows/ios.yml`, macos-15 runner, Xcode 26.3).
- Your **own bundle ID** if you are not the Lumen publisher.
  `io.lumen.secure` can exist only once on the App Store.
- For push: access to the Lumen server's `lumen.conf` and `lumenctl`.

## 2. Identifiers

| Item | Value | Where it is set |
|---|---|---|
| App bundle ID | `$(LUMEN_BUNDLE_ID)`, default `io.lumen.secure` | build setting |
| NSE bundle ID | `$(LUMEN_BUNDLE_ID).LumenNSE` | `project.yml` |
| App group | `group.$(LUMEN_BUNDLE_ID)` | `LUMEN_APP_GROUP` |
| Keychain access group | `<TeamID>.$(LUMEN_BUNDLE_ID)` | entitlements (`$(AppIdentifierPrefix)`) |
| URL scheme | `$(LUMEN_BUNDLE_ID)` (plus `matrix:`) | `Info.plist` |
| SSO redirect | `$(LUMEN_BUNDLE_ID):/sso-callback?n=<nonce>` | code |
| Pusher `app_id` | `$(LUMEN_BUNDLE_ID).ios` | `LUMEN_PUSH_APP_ID` |
| BG refresh task | `$(LUMEN_BUNDLE_ID).refresh` | `Info.plist` |

The SSO redirect carries a per-attempt nonce. Synapse's
`sso.client_whitelist` matches by prefix, so the whitelisted
`<scheme>:/sso-callback` covers it. For a white-label bundle ID, set
`APP_URL_SCHEME=<your bundle ID>` in `lumen.conf`; otherwise users see an
extra "continue to app" confirmation page after signing in.

## 3. App IDs and capabilities (developer portal → Identifiers)

Create two explicit App IDs.

**App** (`com.example.chat`):

- Push Notifications;
- App Groups: `group.com.example.chat`;
- Data Protection: *Complete Until First User Authentication*. The NSE has
  to read the store while the device is locked;
- Associated Domains, only if you enable universal links (§8).

**Notification service extension** (`com.example.chat.LumenNSE`):

- App Groups: the same group;
- Data Protection: the same class.

Notes:

- Keychain sharing between the app and the NSE uses the team-prefixed
  access group in both entitlements files. It needs no portal capability.
- The background modes (`audio`, `voip`, `remote-notification`, `fetch`)
  are `Info.plist` keys, not portal capabilities. App Review checks that
  `voip` and `audio` are used for calls: CallKit and the call widget's
  audio.
- Optional: the **notification filtering** entitlement
  (`com.apple.developer.usernotifications.filtering`) has to be requested
  from Apple. With it, the NSE could hide the regular "Incoming call"
  banner that currently appears next to the CallKit ring. The project does
  not use it.

## 4. Push notifications (APNs → Sygnal)

1. In the developer portal → Keys, create an **APNs auth key** (`.p8`).
   Note its Key ID and your Team ID. One key works for every app of the
   team, in both environments.
2. On the server, in `lumen.conf`:

   ```ini
   PUSH_ENABLED=true
   PUSH_APNS_TEAM_ID=ABCDE12345
   PUSH_APNS_KEY_ID=XYZ1234567
   PUSH_APNS_TOPIC=com.example.chat     # the app's bundle ID
   PUSH_IOS_APP_ID=com.example.chat.ios # = LUMEN_PUSH_APP_ID of your build
   PUSH_APNS_SANDBOX=false              # true only while testing Debug builds run from Xcode
   ```

   Then run `sudo ./lumenctl set-secret push_apns_key < AuthKey_XYZ1234567.p8`
   and `sudo ./update.sh`. The server then publishes `push_gateway_url` in
   its `io.lumen.app` block. The app registers a pusher only when that URL
   is present.
3. **Environments.** Debug builds have `aps-environment = development`, so
   their device tokens are sandbox tokens. TestFlight and App Store builds
   use production. Sygnal sends one app ID to one environment, so test
   Debug builds with `PUSH_APNS_SANDBOX=true`, then switch back.
4. **What the pusher sends.** The pusher is `kind: http`,
   `format: event_id_only`, with
   `default_payload: {"aps":{"mutable-content":1,"alert":{"loc-key":"NEW_MESSAGE"}}}`.
   - Apple and the gateway see the room ID, event ID and unread count,
     never content.
   - `NEW_MESSAGE` is localised by the app ("New message") in case the
     extension doesn't run.
5. **Calls.** No VoIP certificate or VoIP token is used. A ring arrives as
   an ordinary push.
   - The NSE decrypts it and calls `CXProvider.reportNewIncomingVoIPPushPayload`.
   - iOS then wakes the app through PushKit, and the app reports the call
     to CallKit.
   - Without a push gateway, calls ring only while the app is running, and
     the app says so in Settings → Notifications.

## 5. Signing and building

**Local (Xcode).** Open the generated project and select your team for both
targets, or pass it on the command line:

```bash
cd apps/ios && xcodegen generate
xcodebuild -project Lumen.xcodeproj -scheme Lumen -configuration Release \
  -destination 'generic/platform=iOS' -archivePath build/Lumen.xcarchive \
  -allowProvisioningUpdates DEVELOPMENT_TEAM=ABCDE12345 \
  LUMEN_BUNDLE_ID=com.example.chat LUMEN_DEFAULT_SERVER=example.com \
  MARKETING_VERSION=1.0.0 CURRENT_PROJECT_VERSION=42 archive
```

Export and upload with an App Store Connect API key (team admin → Users and
Access → Integrations):

```bash
cat > ExportOptions.plist <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>upload</string>
  <key>teamID</key><string>ABCDE12345</string>
  <key>signingStyle</key><string>automatic</string>
</dict></plist>
EOF
xcodebuild -exportArchive -archivePath build/Lumen.xcarchive \
  -exportOptionsPlist ExportOptions.plist -allowProvisioningUpdates \
  -authenticationKeyPath AuthKey_API.p8 -authenticationKeyID KEYID \
  -authenticationKeyIssuerID ISSUER-UUID
```

**CI.** `apps/ios/scripts/ci-build.sh` always produces an unsigned archive,
`Lumen-unsigned.xcarchive.zip`, with `CODE_SIGNING_ALLOWED=NO`. That
archive can't be installed. Signing in CI uses these secrets:

- `IOS_DIST_CERT_P12_BASE64`, `IOS_DIST_CERT_PASSWORD`;
- `IOS_PROFILES_BASE64`: App Store profiles for the app **and** the NSE;
- `APPLE_API_KEY_*` for the upload.

None of them is ever committed (see release.md).

## 6. TestFlight and App Store

1. App Store Connect → Apps → **+**. Enter the bundle ID, name (for
   example "Lumen Secure"), primary language and SKU.
2. Upload a build (§5).
   - Internal testers get it after processing.
   - External testers need Beta App Review: give a demo server and a test
     account in the review notes. The account must be a real account on a
     server you control. Never use a user's.
3. Fill in the listing:
   - **Category:** Social Networking (or Business, for workspace offerings).
   - **Privacy policy URL** (required): the server's `privacy_url`.
   - **Support URL**: `help_url`.
   - **Age rating:** answer the questionnaire for user-generated content.
     The app lets users message each other.
4. Rules App Review will check:
   - **1.2, user-generated content.** The app provides:
     - block (ignore) per user, in the room details and on invitations;
     - **Report** on other people's messages (`Room.reportContent`). In
       encrypted rooms the server receives the event ID and the reason,
       not the text, so moderation relies on the reporter's description
       and the operator's policy. Explain this in the review notes;
     - a published contact (`help_url`).
   - **5.1.1(v), account deletion.** Accounts are created in the portal,
     which the app opens for sign-up. "Manage account" (`account_url`)
     must therefore lead to account deletion in the portal. Check this on
     your server before submitting.
   - **Encryption:** see §7. App Store Connect asks for every build until
     the questions are answered.
5. Submit for review, then release manually or automatically.

## 7. Export compliance (encryption)

This is an engineering analysis to help whoever signs the export
declaration. It is **not legal advice**; the publisher must confirm it with
export counsel.

**What the app contains.**

- **Matrix Rust SDK** (vodozemac / matrix-sdk-crypto). Published,
  standard algorithms:
  - Olm and Megolm: Curve25519, Ed25519, AES-256-CBC, HMAC-SHA-256, HKDF;
  - encrypted attachments: AES-256-CTR with SHA-256;
  - key backup and secret storage: AES-CTR, HMAC-SHA-256 and PBKDF2;
  - an encrypted local store with a ChaCha20-Poly1305-based store cipher.
- **TLS** through the SDK's HTTP stack.
- **Calls:** WebRTC's DTLS-SRTP, and frame encryption with AES-GCM keys
  exchanged over Olm. This runs inside WebKit, using WebCrypto.

The app's purpose is confidential person-to-person communication.

**Consequences.**

- **`ITSAppUsesNonExemptEncryption = YES`** (set in `Info.plist`). The
  exemptions for apps that use encryption only for authentication,
  copyright protection, or only the operating system's HTTPS **do not
  apply**: the app implements end-to-end encryption with its own library.
- **Note 4 doesn't help.** EAR Category 5 Part 2 Note 4 releases items
  whose primary function is not information security, computing,
  communications or networking. A messenger's primary function *is*
  communications, so the app remains in Category 5 Part 2.
- **Likely classification: ECCN 5D992.c, mass market.** That is
  Cryptography Note 3: generally available to consumers, user cannot
  change the cryptography, no technical support needed. It is exported
  under License Exception ENC §740.17(b)(1) / NLR, except to embargoed
  destinations.
- **Self-classification report.** BIS amended the EAR on 29 March 2021
  (86 FR 16482). Since then, most mass-market products under
  §740.17(b)(1) no longer need a self-classification report or a
  classification request. Counsel should confirm that no remaining
  exception applies, for example sales to government end users or
  non-standard cryptography.
- **Open source.** The app's and the SDK's source code is published and
  uses standard cryptography. Under §734.3(b)(3) / §742.15(b) such
  *source code* is not subject to the EAR once published, and the 2021
  rule removed the e-mail notification for standard cryptography. The
  compiled binary distributed through the App Store is still exported by
  the publisher. Treat it as above.
- **Embargoes and sanctions.** In App Store Connect → Pricing and
  Availability, exclude the territories your counsel identifies:
  - comprehensively embargoed countries;
  - possibly Russia and Belarus, where the 2022 rules add license
    requirements for many Category 5 items.
- **France.** App Store Connect asks whether the app will be available in
  France. Supplying encryption means there needs a declaration to ANSSI
  ("déclaration de fourniture d'un moyen de cryptologie", LCEN art. 30).
  Either file it and upload the acknowledgement to App Store Connect, or
  exclude France.
- **Compliance code.** If Apple reviews documentation (for example a
  CCATS or the French declaration), it issues an
  `ITSEncryptionExportComplianceCode`. Only then add that key to
  `Info.plist`, so later builds skip the questions. The project doesn't set
  it.

**Suggested App Store Connect answers.** The exact wording changes; answer
from the facts above.

| Question | Answer |
|---|---|
| Uses encryption? | Yes |
| Type | Standard encryption algorithms, in addition to the OS's |
| Exempt (authentication only, OS only, …)? | No |
| Available in France? | Per your decision above |

## 8. Universal links (optional)

1. On the server, set `APP_LINKS_APPLE_TEAM_ID` (and
   `APP_LINKS_APPLE_BUNDLE_ID` if it differs). The server then serves
   `https://app.<domain>/.well-known/apple-app-site-association` for
   `#/room/*` and `#/user/*`.
2. Build with `LUMEN_ENTITLEMENTS_FILE=LumenWithLinks.entitlements`
   `LUMEN_ASSOCIATED_DOMAIN=app.<domain>`, and enable Associated Domains on
   the App ID.

The app routes `#/room/<id>`, `#/dm/<user>` and `#/user/<user>`, and always
asks before opening or joining.

## 9. App Privacy ("nutrition label")

**Who the "developer" is.** App Store Connect asks what *the developer and
its partners* collect.

- If you publish the app **and** run the server (hosted Lumen), the server
  data below is collected by you.
- If you only publish a client and users connect to servers you don't run,
  the server operator, not you, receives that data. Answer for your actual
  situation.

**Collected by the server, for app functionality, linked to the user, not
used for tracking:**

| App Privacy type | What it is |
|---|---|
| Contact Info → Name | Profile display name |
| Identifiers → User ID | Matrix ID |
| Identifiers → Device ID | Matrix device ID, push token |
| User Content → Photos or Videos | Profile and room pictures. These are not end-to-end encrypted. Images *in* encrypted rooms are encrypted. |
| User Content → Other User Content | Room names, topics and membership, which Matrix does not encrypt. Encrypted message content is unreadable to the server. It is listed here conservatively. |

**Not collected:**

- Location, contacts, browsing history, purchases;
- diagnostics: the app has no crash reporter or analytics, and its
  diagnostics log never leaves the device;
- usage data for analytics;
- Contact Info → Email: email addresses are collected by the portal
  *website* when an account is created, not by the app.

`apps/ios/Lumen/Resources/PrivacyInfo.xcprivacy` declares the same data
types and these required-reason APIs:

| API category | Reason | Used for |
|---|---|---|
| UserDefaults | CA92.1 | the app's own settings |
| UserDefaults | 1C8F.1 | app-group settings read by the NSE |
| File timestamps | C617.1 | the SDK's SQLite stores in the app and app-group containers |
| System boot time | 35F9.1 | app-lock timer on a monotonic clock |

The NSE has its own manifest. If App Store Connect reports a missing
reason (ITMS-91053) after upload, add it.

## 10. Screenshots

Required sizes:

- iPhone 6.9" (1320 × 2868);
- iPad 13" (2064 × 2752).

Take them on simulators against a demo server with demo accounts. Never
use real conversations.

1. Sign-in with the server picker and the "Continue with your Lumen
   account" button.
2. Room list with unread badges (iPad: split view with a conversation
   open).
3. Conversation showing "Start of the conversation. Messages are
   end-to-end encrypted.", replies and reactions.
4. Emoji verification.
5. Recovery key setup.
6. Call screen showing the widget's encryption label. Only use a
   screenshot where the call really reported "End-to-end encrypted".
7. Settings → How your data is protected.

## What has not been verified

The code exists for everything below, but none of it has been run on a
device or in App Store Connect. Each item is a test to do before the first
release.

**Push and background:**

- [ ] APNs → Sygnal → device delivery (sandbox and production).
- [ ] The NSE decrypting with the shared store while the device is locked:
  Keychain item class, app-group file protection, the cross-process lock
  with the running app, and the 24 MB NSE memory limit.
- [ ] Ring hand-over: NSE → `reportNewIncomingVoIPPushPayload` → PushKit →
  CallKit, with the app suspended or killed.
- [ ] Background refresh (`BGAppRefreshTask`) on a server without a push
  gateway.

**Calls:**

- [ ] CallKit together with WebRTC inside WKWebView: audio session
  ownership, mute from the lock screen, Bluetooth and AirPlay routes,
  speaker override.
- [ ] Whether WebKit treats the `lumen-widget://` scheme as a secure
  context, which getUserMedia needs. Without it, the server-copy fallback
  path takes over.
- [ ] The call widget itself: `services/chat` has no `build:widget` yet.
- [ ] Picture-in-picture of call video.

**Device features:**

- [ ] Face ID / Touch ID app lock; the app-switcher privacy cover.
- [ ] Universal links with a real AASA file.

**Distribution:**

- [ ] App Review outcome (1.2, 5.1.1(v), background modes).
- [ ] The export classification, confirmed by counsel.
