# Lumen Secure — desktop app (Windows, macOS)

An Electron shell around the Lumen web client (`services/chat`). The production build of the
web client is **bundled inside the signed app** and served from `app://lumen/`, never loaded
from a server ([ADR 0003](../../docs/adr/0003-client-apps.md) D2). Sign-in is SSO in the system
browser, session secrets are sealed with an OS-protected store key, and the app adds OS
integration: notifications, tray, app lock and updates.

- Feature status per OS: [FEATURES.md](FEATURES.md)
- Signing, notarization, updates, install/uninstall, verification: [docs/apps/release-desktop.md](../../docs/apps/release-desktop.md)
- Server contract (discovery, SSO redirect, deep links): [docs/apps/integration.md](../../docs/apps/integration.md)

## Layout

```
apps/desktop/
  src/core/        pure logic, unit-tested with node:test (no Electron imports)
    url.ts           URL validation (shared vectors: url-validation.json)
    discovery.ts     .well-known + io.lumen.app parsing, discovery, mapping to the web client's config.json
    deeplink.ts      io.lumen.secure / matrix.to / matrix: routing (shared vectors: deeplinks.json)
    sso.ts           system-browser SSO with a per-attempt nonce
    csp.ts           Content-Security-Policy builder
    permissions.ts   permission policy
    app-path.ts      app:// path → bundle file, traversal-proof
    pin.ts           app-lock PIN verifier (PBKDF2-SHA-256, 600 000 iterations) and back-off
    settings.ts      desktop settings schema
    switches.ts      command-line switches a released build refuses
  src/main/        Electron main process (protocol, windows, IPC, secrets, lock, tray, updates, …)
  src/preload/     sandboxed preloads: app.ts (window.lumenDesktop / lumenSetup), lock, settings, picker
  src/pages/       desktop pages served from app://desktop/: server picker, lock screen, settings, screen picker
  scripts/         build-web.mjs, build-app.mjs, gen-icons.mjs, checksums.mjs, ensure-electron.mjs
  build/           electron-builder resources: entitlements, NSIS include; build/generated = icons (generated)
  test/unit/       node:test unit tests (+ apps/shared/test-vectors)
  test/e2e/        Playwright `_electron` suite against a Lumen dev stack (Linux, Xvfb)
  test/smoke/      packaged-app smoke test (CI, every OS, no server)
  electron-builder.config.cjs
```

The web client's side of the contract is `services/chat/src/platform/desktop-api.ts` (types only),
`services/chat/src/platform/desktop.ts` and `DesktopNotice.tsx`. In a browser
`window.lumenDesktop` doesn't exist and the web app behaves exactly as before.

## Commands

Node 22. Install `services/chat` first: the desktop build compiles the web client.

```bash
(cd services/chat && npm ci --ignore-scripts)
cd apps/desktop && npm ci

npm test              # typecheck + unit tests (node:test, shared test vectors)
npm run build         # web client → dist/web, icons, main/preload/pages → dist/
npm start             # build and run unpackaged (development)
npm run dist:linux    # AppImage + deb            → release/
npm run dist:win      # NSIS installer (x64)       → release/   (on Windows; see below)
npm run dist:mac      # DMG + ZIP, arm64 and x64   → release/   (on macOS)
npm run dist:win:appx # optional AppX/MSIX package (Windows SDK required)
npm run test:smoke    # checks the packaged app in release/ (Linux: under xvfb-run)
npm run checksums     # release/SHA256SUMS
npm run test:e2e      # end-to-end against the dev stack (Linux + Xvfb, see below)
```

Build-time settings (environment; full list in `electron-builder.config.cjs`):

| Variable | Effect |
|---|---|
| `LUMEN_DEFAULT_SERVER` | Server name (not a URL) pre-filled and discovered on first run. Empty: the server picker asks. Written to `dist/desktop-config.json` inside the signed bundle. |
| `LUMEN_UPDATE_URL` / `LUMEN_UPDATE_GITHUB` | Update feed (generic https URL, or `owner/repo` for GitHub releases). Neither: no update feed. |
| `LUMEN_APP_ID`, `LUMEN_PRODUCT_NAME` | White-label app ID / URL scheme and product name. |
| `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`, Azure Trusted Signing variables | Code signing and notarization (see the release doc). Never committed. |

## How it works

### Origins and the protocol handler

- `app://lumen/`: the web client from `dist/web` in the asar, plus `/config.json` generated from discovery.
- `app://desktop/`: the desktop pages, which get a separate origin and a policy with no network access at all.

`app` is registered as a privileged standard scheme (`standard`, `secure`, `supportFetchAPI`,
`corsEnabled`, `stream`, `codeCache`). Paths are decoded and checked in `core/app-path.ts`, which
rejects traversal, encoded separators, backslashes, NUL, dot-files and unknown file types.
Every response carries the CSP, `nosniff`, `Referrer-Policy: no-referrer`, COOP/CORP and a
Permissions-Policy.

**Web client CSP** (`core/csp.ts`; connect-src for the dev stack after sign-in):

```
default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' blob: data:;
media-src 'self' blob:; font-src 'self';
connect-src 'self' https://matrix.lumen.test wss://rtc.lumen.test https://rtc.lumen.test https://lumen.test blob:;
worker-src 'self' blob:; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'
```

Compared with the web deployment (`deploy/lib/render.py`), `connect-src` is not `https: wss:`.
It allows only the configured homeserver, the call SFU (wss plus its https origin, which LiveKit's
validate endpoint uses) and the portal. `form-action` is `'none'`.

Synapse answers `/rtc/transports` only for signed-in users, so before sign-in the SFU is unknown.
After sign-in the web client reports the advertised LiveKit URLs. The main process accepts only
`wss://` URLs without user-info (at most 4), stores them, and reloads the web client once so
that the new policy applies. Consequence: a call hosted on a federated server's SFU is outside
the policy and can't connect from the desktop app.

**Desktop pages CSP:** `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'none'; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'`.

### Hardening

- Every window: `contextIsolation`, `sandbox` (plus `app.enableSandbox()`), no `nodeIntegration`
  (also not in workers or subframes), `webSecurity`, no `<webview>`, no navigate-on-drop,
  `safeDialogs`. DevTools exist only in unpackaged builds.
- Navigation lock: `will-navigate`/`will-redirect` are allowed only from `app://lumen` to
  `app://lumen` (reload after sign-out); subframe navigations are blocked.
- New windows: `setWindowOpenHandler` always denies. `https:` and `mailto:` links go to the
  default browser through `shell.openExternal`; every other scheme is refused and logged.
- Permissions (`core/permissions.ts`) are granted only to the app origin, top-level frame, in the
  main window. Granted: `media` (audio/video only; on macOS also after the OS camera/mic prompt),
  `notifications`, `clipboard-sanitized-write` (Copy buttons), `fullscreen` (call view),
  `speaker-selection` (audio output). Everything else is denied: geolocation, clipboard read,
  MIDI, HID/USB/serial/Bluetooth device access, idle detection, window management, storage
  access, and so on. Desktop pages get nothing. Screen share goes through
  `setDisplayMediaRequestHandler`: app origin, top frame, user gesture, not while locked, and the
  user picks a screen or window in the app's own picker (`desktopCapturer`). System audio
  (`loopback`) is offered on Windows only.
- Fuses (electron-builder `electronFuses`, checked by `test:smoke`): RunAsNode off,
  NODE_OPTIONS/NODE_EXTRA_CA_CERTS off, `--inspect` off, embedded asar integrity on,
  only-load-from-asar on, cookie encryption on, file:// extra privileges off.
- A released build refuses to start with `--remote-debugging-*`, `--inspect*`,
  `--ignore-certificate-errors*`, `--disable-web-security`, `--use-fake-ui/device-for-media-stream`,
  `--no-sandbox`, `--js-flags` and similar switches (`core/switches.ts`). Otherwise another
  program could drive the renderer and read the store key through the preload API, sidestepping
  the Keychain/DPAPI protection.
- Single-instance lock. Certificate validation is never touched: no `certificate-error` handler,
  no `setCertificateVerifyProc`. Discovery uses Electron's `net.fetch` (OS trust store and proxy).
- No third-party requests at start-up (checked with a net-log). On Linux the Chromium spellchecker
  is off because it would download Hunspell dictionaries from Google.

### Sign-in (RFC 8252)

1. The web client calls `lumenDesktop.sso.start(baseUrl, idpId)`. The main process accepts only
   the configured homeserver and a valid IdP ID.
2. It creates a 192-bit nonce and opens
   `<hs>/_matrix/client/v3/login/sso/redirect/<idp>?redirectUrl=io.lumen.secure:/sso-callback?n=<nonce>`
   in the default browser.
3. The OS delivers `io.lumen.secure:/sso-callback?n=…&loginToken=…`: `open-url` on macOS, or a
   second launch whose argv reaches the running instance through `second-instance` on Windows
   and Linux.
4. The callback is accepted only for the pending attempt, with a constant-time nonce comparison,
   once. Callbacks without an attempt, with a wrong nonce, replayed, after cancel or after the
   10-minute timeout are ignored and logged.
5. The login token goes back to the renderer, which logs in with `m.login.token`.

### Local secrets (ADR 0003 D7)

- **Store key.** The main process keeps a random 256-bit store key in `store-key.bin`, encrypted
  with `safeStorage`: DPAPI on Windows, Keychain on macOS, libsecret/KWallet on Linux.
  `lumenDesktop.storeKey` exposes it only to the app origin.
- **Session secrets.** The web client imports the key as a non-extractable AES-GCM key and seals
  the access token and the Rust-crypto store passphrase with it, instead of with a key kept in
  IndexedDB. A session saved by the browser build still loads, and without protected storage
  the browser key is used.
- **Sign-out** deletes the session and the key, then clears the app origin's browser storage:
  IndexedDB, localStorage, caches and service workers.
- **Linux without a keyring** (`basic_text`): Chromium's fixed fallback key is used and the app
  shows a visible warning in the chat view, the sign-in screen, the server picker and Desktop
  settings.

### App lock

- **PIN.** The verifier is PBKDF2-SHA-256 with 600 000 iterations and a 16-byte salt, stored
  safeStorage-encrypted. Back-off: 5 free attempts, then 30 s doubling up to 15 min, persisted
  across restarts. Touch ID is available on macOS.
- **When it locks:** at start, after N minutes without input in the app, and when the OS locks
  the screen or suspends.
- **While locked:**
  - an opaque `WebContentsView` covers the window;
  - the web client's document is set to `visibility: hidden` and made `inert`;
  - the window title loses unread counts and room names;
  - notifications lose their content;
  - screen sharing and permission prompts are refused.
- **Limits.** It doesn't protect against malware or anyone controlling the OS account, and the
  settings page says so.

### Configuration and discovery

- **First run.** The server picker (or `LUMEN_DEFAULT_SERVER`) runs discovery in the main
  process, following integration.md §2:
  1. `/.well-known/matrix/client` with the `io.lumen.app` block (https only, links that fail
     validation are dropped);
  2. `/_matrix/client/versions`;
  3. `/v3/login` (SSO provider; password only if offered);
  4. `/rtc/transports`.
- **What the web client gets.** The profile is saved in `server.json`, re-validated on every
  read, and served as `/config.json`. Custom homeservers are off in the web client.
- **Change server…** (File/app menu, Desktop settings):
  1. native confirmation;
  2. sign-out on the server, through the web client;
  3. local wipe;
  4. back to the server picker.

### OS integration

- **Notifications.** The web client hands notifications to the main process (Electron
  `Notification`), using the web client's own rules and its "Show message previews" setting
  (off by default). The main process drops them while Do-not-disturb is on and removes their
  content while locked. A click shows the window and opens the room. The Windows AppUserModelID
  is `io.lumen.secure`.
- **Window and tray.** Tray/menu-bar icon menu: Open, Do not disturb, Lock now, Desktop
  settings, Quit. Closing the window keeps the app running; the first time, a hint says so.
- **Login, badge, window state.** Open at login (off by default; Windows/macOS). Unread badge
  (`setBadgeCount`; a Windows taskbar overlay dot). Window position and size are remembered.
- **Menus and downloads.** Standard Edit/View/Window menus and shortcuts. Downloads always show
  a save dialog. Spellcheck uses the OS spellchecker (Windows/macOS).

### Updates

`electron-updater` runs only in an installed build:

- **Windows** with a valid Authenticode signature on the running exe; electron-updater then
  verifies each update's publisher;
- **macOS** with a Developer ID signature, checked with `codesign`; Squirrel.Mac requires the
  same identity;
- a feed must be configured.

Otherwise Desktop settings say why, for example "Updates are disabled in unsigned builds.".
Linux builds never auto-update: AppImage updates aren't signature-checked, and deb updates come
from the package manager.

## End-to-end test (`npm run test:e2e`)

The suite runs against the dev Lumen stack (`lumen.test`). It needs Xvfb, Playwright's Chromium
(`/opt/pw-browsers`), `certutil`, `dbus-daemon` and a Python with dbus-python/PyGObject.

The test environment stands in for the user's operating system without weakening the app:

- **Certificates.** A temporary `$HOME` per process has an NSS database that trusts the stack's
  CA. Verification stays on: no `--ignore-certificate-errors` and no `ignoreHTTPSErrors`.
- **Default browser.** A recording `xdg-open` on `PATH` captures the URL the app opens. Playwright
  Chromium then acts as the system browser, and the callback goes back to the app as the OS
  delivers it: a second launch with the URL as argument.
- **Notification daemon.** A private D-Bus session bus runs a test
  `org.freedesktop.Notifications` server (`test/e2e/lib/notification_server.py`). If the host has
  no libnotify, `test/e2e/setup-linux-deps.sh` unpacks the package into `test-output/` (no system
  change).
- **Harness-only switches.** Fake capture devices are on (`--use-fake-device-for-media-stream`);
  the fake media *UI* switch is not used, so the app's permission handler grants the camera.
  Running as root in a container adds `--no-sandbox`, which only unpackaged runs accept.

Steps:
- (a) first run and discovery;
- (b) SSO with a fresh portal login, plus stray and replayed callbacks;
- (c) encrypted DM in both directions with a web user;
- (e) notification over D-Bus and click;
- (e2) Do not disturb;
- (d) desktop↔web call: connected, media, E2EE label, screen share;
- (f) app lock;
- (h) secrets scan of `userData`: raw bytes plus Snappy-decompressed LevelDB blocks, with a
  positive control;
- (g) sign-out wipe;
- (i) Change server.

The report goes to `test-output/e2e-report.txt` and screenshots to `test-output/screenshots/`.
