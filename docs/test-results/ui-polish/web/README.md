# Web chat client and desktop app — UI polish (before / after)

Scope: the web chat client (`services/chat`, also the desktop app's main window and, for the
call screen, the mobile apps' call widget) and the desktop app's own pages (`apps/desktop`).

- `before/` — the code at `898ed0a` (before the shared token updates `0755f71` and `eefa6ab`
  and before this work), built from a separate worktree.
- `after/` — this work, on top of the updated tokens (rounder radii, softer shadows, the
  brand wash, the AA-contrast accent, `--danger-contrast`).

Both sets have the same 43 file names: 34 web screens and 9 desktop pages, each PNG under
300 KB (larger captures are palette-quantised). The full sets (about 185 web screenshots: every
screen at 360×740, 390×844, 768×1024, 1024×768, 1280×800 and 1920×1080, light and dark, plus
640×400 = 200 % zoom on a 1280×800 laptop) are written to `tests/chat/output/gallery/`
(git-ignored) by the gallery script.

## How the screenshots are made

```sh
cd services/chat && npm run devserver:up && npm run build && npm run build:widget
cd ../.. && NODE_EXTRA_CA_CERTS=/etc/lumen/ca/caddy-local-root.crt \
  node tests/chat/ui-gallery.mjs --calls --out docs/test-results/ui-polish/web/after
#   --dist DIR / --widget-dist DIR serve another build (the "before" set used a worktree of 898ed0a)
#   --only REGEX runs only matching sections
cd apps/desktop && npm run build && node test/gallery/pages.mjs --out ../../docs/test-results/ui-polish/web/after
```

`tests/chat/ui-gallery.mjs` signs in five users on the disposable dev homeserver and creates real
content through the app: an encrypted DM with short and long messages, a code block, a link, an
image, a file, a reply, reactions, an edit, a deletion, an undecryptable message (an encrypted
event for an unknown Megolm session) and a run of call events (MatrixRTC memberships, rings and a
decline as another client sends them); groups with a long name, unread counts and a mention, a
group whose last message can't be decrypted, an invitation and an empty account. Calls on the dev
homeserver cover the header states, the incoming-call card and the lobby (Chromium's fake camera
and microphone). The in-call screens need a real SFU: with `--calls` they are taken against the
deployed dev stack (`https://app.lumen.test`, portal SSO accounts like `tests/calls`), with the
page's HTML, JS and CSS served from the local build through Playwright routes (the deployed
response headers, including the CSP, are kept), so they show the code under review.
`apps/desktop/test/gallery/pages.mjs` opens the built desktop pages with stand-ins for their
preload APIs; the real desktop app is covered by its e2e suite.

## Issues found and fixed

| # | Issue (before) | Fix | Screenshots |
|---|---|---|---|
| 1 | **Conversation header**: the name truncated ("Gr…", "G", "Grac…" with a panel open) or vanished entirely at 768 px, while the Encrypted / Not verified badges and five icon buttons took the row. | The name gets the whole title row; the encryption and trust chips move to the subtitle line next to the presence; History / Search / Details fold into a "More options" menu when the header is narrower than 560 px (CSS container query), and the chips show icons only below 440 px (labels stay for screen readers). Tests' selectors (`.room-header .badge`, button names) unchanged. | `dm-360-light`, `dm-390-light`, `dm-768-light`, `info-1280-light`, `search-1280-dark` |
| 2 | **Call events** rendered as a stack of seven large pills. | Each call event is one compact row (small icon, text, time on the right); consecutive call events share one card, a short "call log". Missed calls stay red, an ongoing call is highlighted with its Join button. `.call-item[data-call]` kept. | `dm-1280-light`, `dm-1920-light`, `calls-run-390-dark` |
| 3 | **"Unable to decrypt message"** in the room list and a warning-coloured block in the timeline looked alarming. | Room list: "Encrypted message" with a lock, plus "· waiting for its key" only when the failure is an unknown session (the key may still arrive). Timeline: calm wording chosen from the real failure code — "Waiting for this message's key", "This message can't be read on this device" or "Message not shown" (the trust-based blocks) — with the specific reason, "Verify this device" when this device isn't verified and that would help, otherwise "Keeping another of your signed-in devices open can help"; a quiet dashed placeholder instead of a warning. Nothing is hidden or softened: every failure is still shown as one. | `utd-preview-1280-dark`, `group-1280-light`, `dm-1280-dark` |
| 4 | **"Set up secure backup" banner**: a warning-coloured box with a warning shield for an optional, positive step; no visible action. | A calm card on the brand wash: key icon in an accent tile, title, one short line, a chevron as the action affordance. The warning tone is kept only for "Verify this device" (earlier messages really are unreadable then). | `nudge-1280-light`, `empty-account-390-dark` |
| 5 | Composer placeholder wrapped and was clipped at 360 px. | Shorter placeholder on phones ("Encrypted message…"). | `dm-360-light` |
| 6 | File card: the size/"encrypted" line ran under the Download button (768 px). | Grid column can shrink; long names wrap to two lines then ellipsis; meta ellipsis. | `dm-768-light` |
| 7 | Composer hint off-centre on wide screens. | Centred under the composer. | `dm-1920-light` |
| 8 | Incoming call card on phones: buttons wrapped 2 + 1; "Decline" white on pink in dark mode (2.45:1). | Three equal buttons on one row; danger buttons use `--danger-contrast`; the ring pulses on the caller's avatar instead of the whole card. | `incoming-390-dark` |
| 9 | Call screen: thick teal frames on both tiles all the time (continuous speech), dark slabs in light mode, the phone top bar wrapped into three rows, pure-black video letterboxing. | Who's speaking: a ring round the avatar in voice, a soft frame round video; airy tiles in light mode; one-row phone top bar with the encryption/trust chips below; call-stage colour instead of black; safe areas. | `call-voice-1280-light`, `call-voice-390-dark`, `call-video-1280-light`, `call-mini-390-dark` |
| 10 | Call widget (mobile apps): "Joining the call…" printed twice. | One title with a calm pulsing spinner on the brand wash. | `widget-joining-390-dark` |
| 11 | Emoji verification: seven emoji laid out 4 + 3 left-aligned (and 3 + 4 at 360 px). | Exact 4 + 3 grid with the second row centred; names fit at 360 px; a short staggered entrance. | `verify-sas-360-light` |
| 12 | Sessions: the current session's row misaligned (empty placeholder had no width); "Last active Just now". | Aligned rows; lower-case "just now". | `settings-sessions-390-dark` |
| 13 | Security & privacy: device facts glued to the alert above (no spacing). | Stack spacing applies to key-value lists. | `settings-security-390-light` |
| 14 | State notices (created, joined, invited, encryption on…) took a line each with large gaps. | One quiet block per run of notices. | `group-1280-light` |
| 15 | Empty and start states were bare ("No conversations yet." / "Start one", no "no results" state, "This is the beginning of the conversation." as a lone line). | Friendly empty states with one sentence, one action and an icon on the brand wash (no conversations, nothing matches the filter, no search results); conversation-start hero that says, truthfully, whether messages are end-to-end encrypted; a greeting on the welcome pane ("Good morning, Ada" / "Welcome to Lumen, Emmy"). | `empty-account-390-dark`, `dm-1280-dark` (top in the full set: `dm-top-*`) |
| 16 | Loading showed bare spinners. | Skeletons: a conversation-shaped placeholder while the client starts, a one-line shimmer while loading earlier messages (same height as the button it replaces, so no jump). | transient; not in the curated set |
| 17 | Touch targets: icon buttons 38 px, chips and reactions about 26 px. | On touch layouts (≤ 759 px or a coarse pointer) icon buttons, menu items, settings tabs and the send button are 44 px; chips, reactions, badge buttons and small buttons get a 44 px hit area. | `dm-390-light` |
| 18 | Focus ring forced a 6 px radius onto every focused element (room items, cards changed shape when focused). | The ring follows each component's own radius. | — |
| 19 | Dark mode: the mention badge was white on light violet (2.4:1). | `--accent-contrast` text. | — |
| 20 | Motion ignored reduced-motion in places (typing dots), smooth scroll always. | Message entrance (fade/rise, 360 ms), send-button pop, success icons pop (spring) — all via the duration tokens, which are 0 under `prefers-reduced-motion`; typing dots, staggered emoji and smooth scrolling stop too. | — |
| 21 | Phones: notch and home-indicator areas, and the on-screen keyboard on iOS (which doesn't resize the layout). | Safe-area insets for the app, call screen, incoming card, toasts and sidebar footer; the app height follows the visual viewport, so the composer stays above the keyboard. | — |
| 22 | Desktop lock screen in a dark OS theme: dark title and icon on a dark card on a light page (`--surface-inverse` flips). | Always the dark brand look (hero background, glass card, explicit colours), lock badge, calm error. | `desktop-lock-dark`, `desktop-lock-error-dark` |
| 23 | Desktop pages: square buttons and native checkboxes, unlike the web client; empty "Windows" heading in the screen picker. | Pill buttons, switches, focus ring, the brand wash, card radii from the tokens; empty picker sections hidden. | `desktop-settings-light`, `desktop-settings-dark`, `desktop-server-picker-*`, `desktop-picker-dark` |
| 24 | Matrix / "new" / WireGuard weren't explained. | Sign-in: "Welcome back" and "New · Secure messaging built on Matrix, the open standard. Learn more" (the website's security page). Settings → About: "Lumen runs on Matrix" (homeserver, Matrix ID, session ID, encryption on and whether this session is verified), no lock-in (federation, other Matrix apps such as Element), MatrixRTC with per-frame encryption, and that Lumen servers include WireGuard for private administration only (chats don't travel through it). Details panel: "encrypted … with Matrix's Olm/Megolm encryption". Desktop: the same line on the server picker, an About section in desktop settings, About-panel credits. "Open-source licences" renamed "Third-party licences" (Lumen itself isn't called open source anywhere). | `login-1280-light`, `login-390-dark`, `settings-about-1280-light`, `info-1280-light`, `desktop-server-picker-dark`, `desktop-settings-light` |
| 25 | Success moments were flat. | "You're all set." when the backup is saved, "Nicely done." when this device is verified, a small pop on the success icon. | full set: `backup-*`, `verify-done-*`, `verify-restored-*` |

Not changed on purpose: information architecture, features, the E2EE and verification states
(per-message shields, room and trust chips, call "End-to-end encrypted" badge) — same truth,
calmer presentation. The shared tokens (`design/tokens.css`) were not edited.

## Test results (this work)

| Suite | Result |
|---|---|
| `services/chat` `npm test` (vitest) | 107 passed (9 files; 3 new tests: undecryptable previews, website link, timeline runs) |
| `npm run typecheck`, `npm run lint` | clean |
| `npm run test:e2ee` | 5 passed |
| `npm run test:ui` (production build, production CSP) | 23 passed, no CSP violations or page errors |
| `apps/desktop` `npm test` | typecheck clean, 34 passed |
| `apps/desktop` `npm run build && npm run test:e2e` (Electron, deployed stack) | 11 passed, no CSP violations |
| `tests/chat/ui-gallery.mjs --calls` | all sections passed (the in-call section was retried once while the shared stack was being restarted by another test) |

The calls suites (`tests/calls`, deployed stack and network namespaces) were not run here; the
call UI parts changed are listed in the hand-over below.

## Changed call UI (for the calls regression)

- `CallTimelineItem`: one row per event with a separate `<time>`; consecutive rows inside a
  `.call-log` card. `.call-item[data-call=started|ended|missed|declined|legacy]` and the texts
  ("… declined the call", "Missed call from …", "Call ended · …") are unchanged; the time is no
  longer part of the sentence.
- `CallScreen`: tiles with video get `.has-video`; CSS only otherwise (speaking ring, light tiles,
  phone top bar, safe areas). Labels, `data-*` attributes and roles unchanged.
- Incoming-call card and mini call: CSS only.
- Room header: Voice call / Video call / Join the call / In call buttons unchanged; Call history,
  Search messages and Conversation details are inside "More options" when the header is narrower
  than 560 px (phones, 768 px tablets, a 1280 px window with a side panel open).
- Call widget: `WidgetStatus` no longer repeats its title in the spinner label.
