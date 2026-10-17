# UI polish: Android app

Scope: `apps/android` (Jetpack Compose, Material 3). It uses the generated `LumenTokens.kt`
(from `design/tokens.css`, tokens of `eefa6ab`). The information architecture and the features
are unchanged; the only changes are clear UX improvements and the messaging the coordinator
asked for (Lumen is new, built on Matrix, and uses WireGuard for private administration). The
real encryption and verification states are shown exactly as before, in friendlier words.

## How the screenshots are made

JVM screenshot tests render the **real screen composables** with fake state, using Robolectric
native graphics and Roborazzi. There is no emulator, no network and no SDK session.

```
cd apps/android && ./gradlew :app:screenshots      # → app/build/outputs/roborazzi/*.png
```

- `app/src/test/java/io/lumen/secure/screenshots/ScreensScreenshotTest.kt` renders 45 screen
  states on 8 variants:
  - **Screens:** sign-in and discovery errors, the room list (populated, banners, search, empty,
    loading), the timeline (own and other messages, long text with a link, reply, reactions,
    edit, deletion, a message that can't be decrypted yet, an image, a file, a call, a read
    marker, an authenticity warning, sending, failed), the composer with a multi-line draft and
    a reply, message actions, identity warnings, an invitation, chat search and the list-detail
    layout. Also room details and members, new chat, every settings screen, encryption and
    recovery, the recovery key, emoji verification, the app lock, and the incoming-call and
    calls-unavailable screens.
  - **Variants:** phones at 360×640 dp and 411×891 dp and a tablet at 840×1280 dp, each in light
    and dark. Large text (150 %) is on the 360 dp phone in light and the 411 dp phone in dark.
- `LargeTextScreenshotTest.kt` renders the six busiest screens at 200 % text: the 411 dp phone in
  light and the 360 dp phone in dark.
- `Shots.kt` pauses the Compose clock and steps it together with the main looper. Entry
  animations settle, dialogs and bottom sheets are captured, and endless animations (spinners,
  the skeleton pulse) freeze on a stable frame.
- These tests are kept out of `testDebugUnitTest`. CI renders them in the new `screenshots` job
  of `android.yml` and uploads them as the `android-screenshots` artifact.

The full sets (372 PNGs) stay in `app/build/outputs/roborazzi/`. The curated 40 per set are in
[`before/`](before/) and [`after/`](after/), with the same name in both:
`<screen>__<device>_<theme>[_fs<text size %>].png`.

- **before**: the app UI as of `3890515`, with the tokens of `eefa6ab`. The Android UI code there
  is unchanged since `5eb3848`, apart from a behaviour-neutral refactor that splits each screen
  into a stateful wrapper and a stateless `…Content` composable, so it can be rendered with
  fake data.
- **after**: the commit that adds this README.

## Issues found → fixes

| # | Issue (before) | Fix (after) | Screenshots |
|---|---|---|---|
| 1 | **Every font weight rendered as Regular.** Inter and JetBrains Mono are variable fonts, and a `res/font` resource never applies the `wght` axis. Titles, names and buttons had no hierarchy, on devices too. | The fonts moved to `assets/fonts/` and load through `Font(path, assets, weight, variationSettings = wght)`. A Material 3 type scale tuned for Inter replaces Roboto's tracking, which is too loose for Inter. | every pair, e.g. `settings__phone411_dark` |
| 2 | **Large text broke the invitation row.** At 150 % on a 360 dp phone, "Decline and block" was squeezed into a one-letter-wide column of vertical text. | The invitation actions are in a `FlowRow` (tonal Accept, Decline, Decline and block), so they wrap. | `rooms_populated__phone360_light_fs150` |
| 3 | **The room header lost its text.** Four action icons truncated the name ("Maya Lindqv…") and pushed "End-to-end encrypted" onto two lines. | Compact windows keep the voice call; video call, search and details move into an overflow menu. The encryption state is one line with a lock icon. Below 380 dp the avatar gives way to the text. Wide windows show every action. | `room_timeline__phone411_light`, `room_timeline__phone360_light` |
| 4 | **Messages had no structure or grouping.** Every bubble had the same 16 dp corners and other people's bubbles had shadows. Retry sat inside the bubble, a call was a grey word, the date was plain text and links weren't tappable. | Bubbles from the same sender within 5 minutes are grouped (2 dp gap, asymmetric corners, the sender's name once). Other people's bubbles get a hairline border in light mode. A reply quote has an accent bar. Reactions are 32 dp pills, with yours highlighted. Links are underlined and tappable. Dates are pills reading Today or Yesterday. Calls are a pill with an icon and the time. A failed message has a danger outline, with "Not sent · Retry" under it. | `room_timeline__*`, `room_group_typing__phone360_light` |
| 5 | **Undecryptable messages read like an error** ("Unable to decrypt…" in italics, with a warning-coloured lock). | Calm copy that matches the real state, with a clock icon: "This message is encrypted and its key hasn't reached this device yet. It often arrives shortly. Verifying this device or entering your recovery key can help." The room-list preview reads "Waiting for the key to this message". | `room_timeline__phone411_dark_fs150`, `rooms_populated__*` |
| 6 | **The composer was a rectangular outlined field** with a grey send icon. | A pill-shaped field with the attach button inside. The 48 dp round send button lights up with the brand gradient and a small spring pop, and gives a confirm haptic on send. The reply/edit context is a card with a preview. Insets come from `safeDrawing`, so the composer sits right on the keyboard or the navigation bar with no double gap. | `room_reply_composer__phone411_light` |
| 7 | **Message actions were an `AlertDialog`.** | A bottom sheet: 48 dp quick reactions first, then full-width actions, with Delete in the danger colour. Long press keeps its haptic. A delete confirmation has an icon. | `room_message_actions__phone411_light` |
| 8 | **Loading was a lone spinner.** There was no way back to the newest message. | Skeleton rows for the room list and skeleton bubbles while a chat opens. A jump-to-latest button appears once you scroll up. | `rooms_loading__phone411_dark` |
| 9 | **Empty, error and waiting states** were a small grey icon and a text button. | A brand illustration (an icon on a cyan, violet and peach glow, decorative only), one friendly sentence and one clear action as a gradient primary button. The room list hides its FAB while the empty state offers "Start a chat". | `rooms_empty__phone411_light`, `room_empty__phone411_dark`, `list_no_detail__tablet840_dark` |
| 10 | **Banners were full-bleed strips.** Their actions squeezed the text into a narrow column. | Rounded tonal cards, with the action buttons on their own row. | `rooms_banners__phone360_light`, `room_warnings__phone360_dark` |
| 11 | **Welcome and sign-in were top-aligned**, leaving half of a tablet empty. There was no brand feel, and the Continue spinner sat off-centre. | The content is centred. The brand wash is behind it in light mode and the midnight hero glow in dark mode. The logo has a glow, then a "New · Built on Matrix" pill, the tagline "Secure messaging built on Matrix, the open standard.", and the controls on a card. The gradient primary button shows an inline, centred spinner. The server shows as a pill. | `auth_server_picker__*`, `auth_sign_in__phone411_light`, `auth_discovery_error__phone360_light` |
| 12 | **The room list** opened search through an icon, had an icon-only FAB, plain chips and a full-bleed selection, and an urgent red mention badge. | A persistent rounded search field. An extended "New chat" FAB that shrinks on scroll. Accent filter pills, and a rounded selection with a gradient avatar ring. Unread chats have bold names and an accent timestamp. Mentions get a calm "@" badge with the right content description. Timestamps align right. | `rooms_populated__*` |
| 13 | **Settings was one long flat list.** Switch rows had no icons, so the alignment broke. | A profile card (avatar with a gradient ring, Matrix ID, device), then grouped rounded cards with tinted icon tiles. Rows show a chevron for in-app navigation and an external-link icon for the browser. Sign out and Delete account are in their own card in the danger colour. Choice dialogs have 48 dp rows. | `settings__phone411_light`, `settings__phone411_dark` |
| 14 | **About said nothing about Matrix.** | A "Lumen runs on Matrix" card shows the homeserver, Matrix ID, device ID and encryption (Olm and Megolm, vodozemac in the Matrix Rust SDK), and this device's real verification state. Below it are one sentence on federation and other Matrix apps and one sentence: "Lumen servers include WireGuard for private administration." "Open-source licences" is now "Third-party licences", since Lumen itself is described as "built on open standards". | `about__phone411_light` |
| 15 | **Room details showed encryption only as a warning when it was off.** | An "End-to-end encrypted with Matrix" row with what it means (a warning card when encryption is off). Members get a "Verified" badge. Actions are in cards and the header avatar is 88 dp with a gradient ring. | `room_info__phone411_light`, `room_info_unencrypted__phone360_dark` |
| 16 | **Encryption and recovery was a plain list.** | A status card: verified (success) or "Verify this device" (warning), with a gradient primary action and recovery key as the secondary one. The recovery card colours its real state, and adds "You can restore your encrypted messages on any new device." once recovery is set up. | `encryption_unverified__phone411_light`, `encryption_ok__phone411_dark` |
| 17 | **Verification:** the emoji were cramped, every button was a text button, and "Verified" had no feedback. | The emoji sit on tiles that grow with the text size, and "They match" is a filled button. Success shows a check that settles with the token spring and a confirm haptic: "Verification complete. Nice work. Lumen will show this as verified from now on." | `verify_emoji__phone360_light`, `verify_done__phone411_dark` |
| 18 | **The recovery key dialog** was a plain box with a text button. | A key icon, the key in JetBrains Mono at its real weight on a bordered surface, a tonal Copy button (still marked sensitive on Android 13 and later), and "I have saved it" as a filled button. | `recovery_key__tablet840_light` |
| 19 | **The app lock** was a logo on a flat background. | "Welcome back" on the brand background, then "Lumen is locked. Unlock to continue to your chats.", a fingerprint Unlock button, and the limits note. | `lock__phone411_dark` |
| 20 | **Incoming call:** three pill buttons were squeezed on a 360 dp phone. | 72 dp round buttons with labels underneath (each one touch target), and the caller's avatar with a gradient ring and a soft breathing ring. | `call_incoming__phone360_light` |
| 21 | **Large screens and motion:** list and detail switched with no transition, the empty detail was plain, and settings stretched across the tablet. | Screen changes slide and fade (220 ms ease-out from the tokens; Compose follows the system animator duration scale). Predictive back makes the screen follow the gesture. On ≥ 1000 dp the list is 400 dp wide. Settings-type screens keep a readable 680 dp width, centred. The app bar takes a tonal colour once content scrolls under it. | `list_detail__tablet840_light`, `list_no_detail__tablet840_dark` |
| 22 | **Contrast and tokens.** | Material's `onError` is the new `dangerContrast`. The window accent (`colors.xml`) is `#0B6F8A`. Avatar initials sit on deep 700-tone gradients, at least 5.7:1 with white. The gradient primary button uses the 700 tones with white text in light mode and the token gradient with dark text in dark mode. Peach appears only in background glows, never behind or as text. | all |
| 23 | **Copy.** | The tone is warm, plain and in the second person, with calm errors that say what happened and what to do and never blame the user. "Welcome back" greets you on the app lock. There is at most one exclamation mark per screen and no emoji in UI copy. | all |
| 24 | **The ringing banner sat under the status bar** (the app is edge-to-edge). | The banner pads for the status bar, and the screen below consumes that inset. | — |

Kept intact on purpose:

- every test tag and text the instrumented and real-server tests rely on (`server_input` … `sign_out_confirm`, `R.string.room_encrypted` in the room header, and the delivery content descriptions merged into the message bubble);
- the encryption and verification states;
- the recovery key's sensitive-clipboard flag;
- 48 dp targets (reaction pills are 32 dp high, above the WCAG 2.2 AA minimum of 24).

## Verification

Local (this host, no emulator), on the commit that adds this README:

- `./gradlew :app:testDebugUnitTest :core:test`: all pass (app 8, core 56).
- `./gradlew :app:lintDebug`: **0 errors**. There are 2 warnings, both pre-existing `InlinedApi`
  on `POST_NOTIFICATIONS` and the full-screen-intent settings action, which are guarded by SDK
  checks. The new `ModifierParameter` and `UnusedResources` warnings were fixed.
- `./gradlew :app:screenshots`: 372 images, no failures.

CI: `android.yml` run [39014421352](https://github.com/Techprosoftware707/0trust-chat/actions/runs/39014421352)
on `aab721c` (the polish commit) passed. Every job was green:

| Job | Result |
|---|---|
| Build, test, package (unit tests, lint, debug/release APK, AAB) | success |
| Screenshots (every screen, sizes, themes, large text) | success (372 images; renders identical to the local ones) |
| Instrumented tests (emulator) | success |
| App against a real Lumen server (emulator) | success: `android e2e: all steps passed` (42 PASS, 0 FAIL). This covers SSO sign-in through the portal, accepting the web user's invitation in the room list, the decrypted message, the reply confirmed by the server, and sign-out. |
| Installs and starts on Android 8.0 / Android 9 (emulator) | success |

[`emulator/`](emulator/) holds the first screen from the Android 8.0 (API 26) and Android 9
(API 28) jobs of that run. The real emulator renders Inter's weights, the brand wash and the
"New · Built on Matrix" pill. On API 26 the keyboard is open, because adb starts the app outside
touch mode and the field takes focus; the card scrolls above the keyboard.
