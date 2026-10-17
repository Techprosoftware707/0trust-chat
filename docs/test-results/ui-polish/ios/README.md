# iOS UI polish: before and after

All screenshots here were rendered by CI on GitHub's macOS runners (Xcode
26.3, iOS 26.2 simulators). Nothing was rendered on a Mac or a device by
hand, and nothing here was signed in to a server.

## How the screenshots are made

`LumenUITests/ScreenshotTests` launches the app with `-LumenScreenshots`. That
launch argument switches on a screenshot mode that exists only in Debug
builds (`apps/ios/Lumen/Debug/`, every file wrapped in `#if DEBUG`). It shows
no real screen, signs nothing in and contacts no server. Instead it renders
the app's real SwiftUI screens from made-up data
(`apps/ios/Lumen/Matrix/PreviewFixtures.swift`) in a window of each device's
size and safe area, and writes PNG files:

- iPhone SE (375 x 667 pt), iPhone 16 Pro (402 x 874), iPhone Pro Max
  (440 x 956), on the iPhone 17 Pro Max simulator;
- iPad 11" portrait (834 x 1210) and landscape (1210 x 834), iPad 13"
  landscape (1376 x 1032), and 13" Split View widths (683 and 375 pt), on the
  iPad Pro 13" simulator;
- light and dark (iPhone Pro Max, iPad 11" landscape and the Split View
  widths: light only); and on iPhone SE, the smallest screen, also the
  xxxLarge and accessibility-2 (AX2) text sizes for the key screens;
- long screens (Settings, About, room details) are also captured scrolled
  down (`--p2`, `--p3`, ...).

`ci-build.sh` checks that the Release archive doesn't contain the screenshot
mode (it fails if the binary contains its launch argument, environment
variable or type names). The full sets are the CI artifact
`lumen-ios-screenshots` (kept 3 days); `manifest-<set>.txt` lists every file
with its render method and time.

The call screen's video area is the call widget (a web page), which the
harness doesn't load: the call screenshots show the app's own controls over
a placeholder.

## Runs

| | Run | Commit | Result |
|---|---|---|---|
| Before | [39011503390](https://github.com/Techprosoftware707/0trust-chat/actions/runs/39011503390) | d102b18 (harness only, no visual changes; design tokens as of eefa6ab) | Build, LumenCore `swift test`, the 80 unit tests on each simulator and the launch UI test passed; 386 screenshots; 2 of the 5 screenshot tests failed (see below) |
| After, first pass | [39013686839](https://github.com/Techprosoftware707/0trust-chat/actions/runs/39013686839) | 1dd83dd (polish) | Green: build without Swift warnings; LumenCore `swift test`; 80/80 unit tests on each simulator incl. `SdkTlsTests`; launch UI test; 7/7 screenshot tests (494 screenshots); Release binary check; unsigned archive |
| After (final) | [39016001073](https://github.com/Techprosoftware707/0trust-chat/actions/runs/39016001073) | 0a9bb93 (second pass from those screenshots) | Green: build without Swift warnings; LumenCore `swift test`; 80/80 unit tests on the iPhone 17 Pro Max and on the iPad Pro 13-inch (M5) simulator (iOS 26.2), incl. both `SdkTlsTests` (trusted certificate works, self-signed refused); launch UI test on both; 7/7 screenshot tests (466 screenshots, 0 failures); the Release binary contains no screenshot mode; unsigned archive built. The discovery UI test was skipped (no `LUMEN_UITEST_SERVER`) |

The before run's two failed screenshot tests timed out on UI queries while
the app was busy rendering ("Timed out while evaluating UI query"); that
harness bug is fixed (the test now waits for the manifest file). Because of
it, the before set has iPhone 16 Pro screens up to the security screens
only, and 5 iPad landscape screens; the curated before images below come
from what was rendered.

The `after/` images are from the final run. `before/` and `after/` hold the same curated file names
(`<device>__<screen>--<appearance>[--<text size>].png`), downscaled to under
300 KB each.

## Issues and fixes

Each row links the curated screenshots (`b` = before, `a` = after). The
review was done against the Human Interface Guidelines and WCAG 2.2 AA
(contrast figures computed from the generated tokens).

| # | Issue (before) | Fix (after) | Screens |
|---|---|---|---|
| 1 | Welcome and sign-in: a plain left-aligned form, no brand moment, no word about Matrix; the disabled Continue button was the accent at 50 % opacity (looked broken) | Centred welcome: glowing mark, "New · Built on Matrix", "Welcome to Lumen Secure", "Secure messaging built on Matrix, the open standard"; server field and sign-in in one card on the brand wash (light) or hero (dark); disabled buttons use a neutral fill with readable text | [b](before/iphone-16-pro__welcome--light.png) [a](after/iphone-16-pro__welcome--light.png), [b](before/iphone-16-pro__welcome--dark.png) [a](after/iphone-16-pro__welcome--dark.png), [b](before/iphone-16-pro__sign-in--light.png) [a](after/iphone-16-pro__sign-in--light.png) |
| 2 | Sign-in errors: a red band; waiting for the browser showed only a spinner | Calm error card with what to do next; "Waiting for your sign-in page…" with a line explaining it; the server row stacks at AX2 instead of truncating | [b](before/iphone-16-pro__welcome-server-error--light.png) [a](after/iphone-16-pro__welcome-server-error--light.png), [b](before/iphone-se__sign-in--light--ax2.png) [a](after/iphone-se__sign-in--light--ax2.png) |
| 3 | Room list on iPhone used the sidebar style: rooms in inset cards, and in dark mode a pure black background instead of the token background | Plain list on iPhone on the page background, sidebar style on iPad with a set column width | [b](before/iphone-16-pro__rooms--light.png) [a](after/iphone-16-pro__rooms--light.png), [b](before/iphone-16-pro__rooms--dark.png) [a](after/iphone-16-pro__rooms--dark.png) |
| 4 | Every avatar was the same purple gradient with one letter | Stable soft brand tint per person, two initials, a brand-gradient ring for invitations and headers | same as 3 |
| 5 | Rows: one-line preview, small badges, unread time not marked, no marker for unencrypted rooms, VoiceOver read the parts separately | Two-line previews, unread time in the accent, call badge on the avatar, "not encrypted" lock marker, one VoiceOver label per row ("Design crew, 3 unread, …, group"); at accessibility sizes the name and time stack | [b](before/iphone-se__rooms--light--xxxl.png) [a](after/iphone-se__rooms--light--xxxl.png), [b](before/iphone-pro-max__rooms--light.png) [a](after/iphone-pro-max__rooms--light.png) |
| 6 | Connection and session banners sat in a top inset that tinted the navigation bar; the verification banner's button said "Set up" | Banners are cards inside the list; "Verify" for verification, "Set up" for recovery; calmer copy ("You're back online", "Lumen keeps trying") | [b](before/iphone-16-pro__rooms-offline--light.png) [a](after/iphone-16-pro__rooms-offline--light.png) |
| 7 | Empty and loading states: a system placeholder telling people to use "the pencil button", and a bare spinner | Friendly empty state with one action ("Start a conversation"), skeleton rows while loading | [b](before/iphone-16-pro__rooms-empty--light.png) [a](after/iphone-16-pro__rooms-empty--light.png), [b](before/iphone-se__rooms-loading--light.png) [a](after/iphone-se__rooms-loading--light.png) |
| 8 | Conversation: every message repeated the sender's name, no avatars, identical corners; on iPad bubbles and lines ran across the whole detail column | Runs of messages share one name and one avatar with tighter inner corners; bubbles at most 560 pt in a centred column of at most 820 pt; per-person name colours chosen for at least 5.3:1 contrast | [b](before/iphone-16-pro__conversation--light.png) [a](after/iphone-16-pro__conversation--light.png), [b](before/ipad-11-portrait__conversation--light.png) [a](after/ipad-11-portrait__conversation--light.png) |
| 9 | "@maya:lumen.example is typing…" | "Maya Chen is typing…" with soft animated dots (static with Reduce Motion) | same as 8 |
| 10 | Unable-to-decrypt messages in the warning colour with an alarm icon and "Blocked:" | Calm muted text with a lock: "The key for this message hasn't arrived yet. Verifying this device or entering your recovery key usually helps." (each cause keeps its own true explanation) | [b](before/iphone-16-pro__conversation-special-events--light.png) [a](after/iphone-16-pro__conversation-special-events--light.png) |
| 11 | Day dividers read "Saturday, 17 October 2026"; deleted messages looked like normal bubbles | "Today", "Yesterday", weekday, in a pill; deleted and unsupported messages in italic muted text; file attachments as cards with type and size | [b](before/iphone-16-pro__conversation-media--light.png) [a](after/iphone-16-pro__conversation-media--light.png) |
| 12 | Composer: 36 pt attach and 32 pt send buttons (below 44 pt), a flat background, raw Markdown in the reply bar | 44 pt targets, material bar with a hairline, gradient send button, "Encrypted message" placeholder only once the room is known to be encrypted, reply bar with an accent rule, interactive keyboard dismissal, light haptic on send | [b](before/iphone-16-pro__composer-reply--light.png) [a](after/iphone-16-pro__composer-reply--light.png), [b](before/iphone-16-pro__composer-multiline--light.png) [a](after/iphone-16-pro__composer-multiline--light.png) |
| 13 | Navigation bar: three trailing buttons squeezed the title ("Design…" at AX2) | The title shows the name and the encryption state and opens the details; the info button is gone; during a call a green "Join" replaces the call buttons | [b](before/iphone-se__conversation--light--ax2.png) [a](after/iphone-se__conversation--light--ax2.png) |
| 14 | Room details: left-aligned header; the footer said "Message contents are end-to-end encrypted" even in unencrypted rooms | Centred header with ring avatar, "End-to-end encrypted with Matrix" (or "Not encrypted"), member count; the footer follows the room's real state | [b](before/iphone-16-pro__room-details--light.png) [a](after/iphone-16-pro__room-details--light.png), [b](before/ipad-11-portrait__room-details--light.png) [a](after/ipad-11-portrait__room-details--light.png) |
| 15 | Settings: plain rows, statuses as grey text, and on a device without a passcode "Require Unavailable (no passcode set)" | Profile header, Settings-style icon rows, coloured status values ("Verified", "Set up"); without a passcode the app-lock toggle is disabled with an explanation | [b](before/iphone-16-pro__settings--light.png) [a](after/iphone-16-pro__settings--light.png), [b](before/iphone-16-pro__settings--dark.png) [a](after/iphone-16-pro__settings--dark.png), [b](before/ipad-11-portrait__settings--dark.png) [a](after/ipad-11-portrait__settings--dark.png) |
| 16 | About: no explanation of Matrix; called Lumen "free software" | "Lumen runs on Matrix" with homeserver, Matrix ID, device ID, encryption and this device's status; one sentence on federation and other Matrix apps; one on WireGuard for private server administration (optional, doesn't carry messages); "Built on open standards" | [b](before/iphone-16-pro__settings-about--light.png) [a](after/iphone-16-pro__settings-about--light.png) |
| 17 | Devices: text-only rows | Device glyphs, "This device" capsule, "Active 5 minutes ago", context menu to remove | [b](before/iphone-16-pro__settings-devices--light.png) [a](after/iphone-16-pro__settings-devices--light.png) |
| 18 | **Bug**: the verification sheet closed itself the moment a verification finished, so "Verified" (or why it was cancelled) was never seen | The sheet stays until Done, with a short celebration and a success haptic | [b](before/iphone-se__verification-verified--light.png) [a](after/iphone-se__verification-verified--light.png), [b](before/iphone-se__verification-emoji--light.png) [a](after/iphone-se__verification-emoji--light.png) |
| 19 | Security onboarding and recovery key: text-heavy, left-aligned | Hero glyph on the brand wash, short warm copy, the key in a card with a two-minute copy, "You're all set" at the end | [b](before/iphone-se__security-confirm-its-you--light.png) [a](after/iphone-se__security-confirm-its-you--light.png), [b](before/iphone-se__security-recovery-key--light.png) [a](after/iphone-se__security-recovery-key--light.png) |
| 20 | **Bug**: on an iPhone SE the call controls overflowed (mute and end call cut off) | Controls spread evenly in a glass capsule that fits 375 pt; header in a material card | [b](before/iphone-se__call--dark.png) [a](after/iphone-se__call--dark.png) |
| 21 | Lock screen: "Lumen is locked"; without a device passcode it would offer "Unlock with Unavailable (no passcode set)" and never unlock | "Welcome back", the right biometry glyph, and without a passcode an explanation of how to unlock | [b](before/iphone-se__app-lock--light.png) [a](after/iphone-se__app-lock--light.png), [b](before/ipad-11-landscape__app-lock--light.png) [a](after/ipad-11-landscape__app-lock--light.png) |
| 22 | Launch failure: message and two buttons on a plain background | Title, calm message, primary "Try again", destructive "Sign out on this device" in red | [b](before/iphone-se__launch-failed--light.png) [a](after/iphone-se__launch-failed--light.png) |
| 23 | Launch screen: midnight background, then a light app (a flash in light mode); icon on a flat background | Launch background is the page background in both appearances; the icon gets the brand-hero depth and iOS 18 dark and tinted variants | (asset catalog) |
| 24 | New chat: an empty form | A hint about names and Matrix IDs, avatars in results | [b](before/iphone-se__new-chat--light.png) [a](after/iphone-se__new-chat--light.png) |
| 25 | Found in the first after run (39013686839): with the new row colours, the selected iPad sidebar row had dark text on the teal highlight | Selected rows switch to the accent's contrast colour (read from `backgroundProminence`) | [b](before/ipad-11-landscape__rooms--light.png) [a](after/ipad-11-landscape__rooms--light.png), [b](before/ipad-11-portrait__rooms--light.png) [a](after/ipad-11-portrait__rooms--light.png) |
| 26 | No Increase Contrast, haptics or Reduce Motion handling | Increase Contrast draws subtle text and hairlines with their stronger tokens; haptics on send, react, errors, verified, recovery set up and unlock; animations become fades or nothing with Reduce Motion | (all screens) |

Contrast (computed from `LumenTokens.swift`, WCAG 2.2): subtle text 5.1:1 on
the light background and 6.0:1 on the dark one; muted text 6.5:1 and 9.1:1;
the accent as text 5.4:1 and 10.5:1; labels on the primary button 5.8:1 at
the accent end and 5.0:1 at the violet end (light), 10.5:1 and 7.6:1 (dark);
initials on avatar tints at least 9.5:1; message text on own bubbles 15.5:1
and 11.4:1.

## Not verified

- Nothing here ran on a device or against a server: the screens use made-up
  data. Haptics, Face ID, keyboard behaviour with a hardware or software
  keyboard, and VoiceOver were not exercised (no device; VoiceOver labels
  and actions were added but not audited with VoiceOver).
- The screenshots show the app on the iOS 26.2 simulator with the iOS 26 SDK
  (Liquid Glass bars). The deployment target stays iOS 17, which wasn't
  rendered.
- Status bars aren't drawn (each screen is rendered in its own window), and
  the call widget's video area is a placeholder.
