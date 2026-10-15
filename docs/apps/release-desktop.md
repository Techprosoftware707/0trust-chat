# Releasing the desktop app (Windows, macOS)

How the Lumen Secure desktop app (`apps/desktop`) is built, signed, published, updated,
installed, removed and verified. Code and architecture: [apps/desktop/README.md](../../apps/desktop/README.md).
Feature status: [apps/desktop/FEATURES.md](../../apps/desktop/FEATURES.md).

## 1. Build matrix

| OS | Runner | Command | Output in `apps/desktop/release/` |
|---|---|---|---|
| Windows | `windows-2025` | `npm run dist:win` | `Lumen-Secure-<v>-win-x64.exe` (NSIS), `.blockmap`, `latest.yml` (with a feed) |
| macOS | `macos-15` (arm64) | `npm run dist:mac` | `Lumen-Secure-<v>-mac-arm64.dmg`/`.zip`, `Lumen-Secure-<v>-mac-x64.dmg`/`.zip`, `latest-mac.yml` (with a feed) |
| Linux (testing only) | `ubuntu-24.04` | `npm run dist:linux` | `Lumen-Secure-<v>-linux-x86_64.AppImage`, `Lumen-Secure-<v>-linux-amd64.deb` |

Every job runs the same steps:

1. `npm ci --ignore-scripts` in `services/chat`, then `npm ci` in `apps/desktop`;
2. `npm test`;
3. `npm run dist:<os>`, which builds the web client itself;
4. `npm run test:smoke`;
5. `npm run checksums`.

The workflow is `.github/workflows/desktop.yml`. All tool versions are pinned in
`apps/desktop/package-lock.json`: Electron 44.7.2, electron-builder 26.17.0,
electron-updater 6.8.10.

The Windows installer must be built on Windows. electron-builder cross-compiles the NSIS
scripts on Linux without Wine (it edits exe resources with `resedit`), but it runs the
generated uninstaller-writer `.exe`, which needs Wine on Linux.

## 2. Code signing

Signing material comes only from CI secrets or environment variables. Nothing is committed.
Without secrets the jobs still build, unsigned, and say so in a workflow notice. Empty
secret variables are treated as absent (`electron-builder.config.cjs`).

### Windows (Authenticode)

- **Certificate file:** `CSC_LINK` (base64 or path of a `.pfx`) and `CSC_KEY_PASSWORD`. When
  both platforms build in one job, use `WIN_CSC_LINK`/`WIN_CSC_KEY_PASSWORD`. electron-builder
  signs the app exe, the installer and the uninstaller with SHA-256 and an RFC 3161 timestamp.
- **Azure Trusted Signing** (no exportable key, recommended for new publishers): set
  `AZURE_TRUSTED_SIGNING_ENDPOINT`, `AZURE_TRUSTED_SIGNING_ACCOUNT` and
  `AZURE_TRUSTED_SIGNING_PROFILE`, plus the service principal in `AZURE_TENANT_ID`,
  `AZURE_CLIENT_ID` and `AZURE_CLIENT_SECRET`. The config then uses electron-builder's
  `azureSignOptions`, and the runner needs the `TrustedSigning` PowerShell module
  (electron-builder installs it).
- **Update publisher check:** `LUMEN_WIN_PUBLISHER_NAME` is the certificate subject CN (several,
  comma-separated, during a certificate change). It is written to `app-update.yml`, and
  electron-updater refuses an update whose Authenticode signer doesn't match. When unset,
  electron-builder derives it from the certificate.

**SmartScreen.** A new certificate, OV or EV alike since 2024, starts without reputation, so
early downloads show "Windows protected your PC". Reputation builds per certificate and per file
as people install. Azure Trusted Signing certificates are short-lived but keep reputation per
publisher identity. Plan a soft launch. Never ask users to turn SmartScreen off.

### macOS (Developer ID + notarization)

- **Certificate:** `CSC_LINK` is the "Developer ID Application" `.p12`, with `CSC_KEY_PASSWORD`.
  Signed builds use the hardened runtime with these entitlements:
  - `com.apple.security.cs.allow-jit` (V8);
  - `com.apple.security.device.camera`;
  - `com.apple.security.device.audio-input`.

  There is no `disable-library-validation` and no DYLD exception. `NSCameraUsageDescription`,
  `NSMicrophoneUsageDescription` and `NSAudioCaptureUsageDescription` are in `Info.plist`.
- **Notarization:** set `APPLE_API_KEY` (path to the App Store Connect `.p8`; the workflow
  decodes `APPLE_API_KEY_BASE64`), `APPLE_API_KEY_ID` and `APPLE_API_ISSUER`. The alternative is
  `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID`. electron-builder then notarizes
  with `notarytool` and staples the app.
- **Without a certificate:** the build is ad-hoc signed (`identity: "-"`, so Apple-silicon
  binaries still run locally), without the hardened runtime, and not notarized. Gatekeeper
  blocks such a download ("cannot be opened because the developer cannot be verified"). It is
  for testing only.

**Gatekeeper check** of a release, on a Mac:

```bash
spctl -a -vvv -t exec "/Applications/Lumen Secure.app"       # source=Notarized Developer ID
codesign --verify --deep --strict --verbose=2 "/Applications/Lumen Secure.app"
xcrun stapler validate "Lumen-Secure-<v>-mac-arm64.dmg"
```

### Linux

Builds are unsigned and for testing only. The deb installs `chrome-sandbox` setuid and an
AppArmor profile for Ubuntu 24.04. The AppImage needs user namespaces or `--no-sandbox`, and a
released build refuses `--no-sandbox`.

## 3. Updates and the feed

- **Feed:** set at build time with `LUMEN_UPDATE_URL` (generic provider, any https static host)
  or `LUMEN_UPDATE_GITHUB=owner/repo` (GitHub releases). electron-builder then writes
  `app-update.yml` into the app and `latest.yml` / `latest-mac.yml` next to the installers.
- **Hosting a generic feed:** upload `latest*.yml`, the installers/ZIPs and their `.blockmap`s
  to the same directory over https. macOS updates use the ZIP, Windows the NSIS exe
  (differential, via blockmap). The yml files carry SHA-512 hashes of the artifacts, and
  electron-updater verifies them after download.
- **What has to hold for an update to run:**
  - **Windows:** the running exe has a valid Authenticode signature (checked with
    `Get-AuthenticodeSignature`), and the downloaded installer is signed by `publisherName`
    (checked by electron-updater).
  - **macOS:** the running app is Developer ID signed (`codesign` with
    `Authority=Developer ID Application` and a team ID), and Squirrel.Mac checks that the update
    has the same designated requirement.
- **Never:** in development builds, without a feed, in unsigned builds, or on Linux. Desktop
  settings then say why, e.g. "Updates are disabled in unsigned builds."
- **Schedule:** updates download in the background and install when the app quits, or with
  "Restart and update". The app checks at start and every 6 hours. No pre-releases, no
  downgrades.
- **Chromium security fixes** reach users only through new releases. Track the Electron stable
  line and re-release for Chromium security updates.

## 4. MSIX vs NSIS

| | NSIS (default) | MSIX/AppX (`npm run dist:win:appx`) |
|---|---|---|
| Install | Per-user, no admin rights (`%LOCALAPPDATA%\Programs\Lumen Secure`); no install-mode page | Per-user; Store, Intune or sideloading (needs a trusted certificate) |
| Updates | electron-updater (above) | Store / App Installer, not electron-updater |
| Protocol `io.lumen.secure` | Registered under `HKCU\Software\Classes` by the installer (and by the app at runtime) | Declared in the package manifest (electron-builder `protocols`) |
| Data on uninstall | Kept, unless "Also delete my local data" is ticked | Windows removes the package's virtualised data |
| Status | Built on CI | Configured (`appx` section; `LUMEN_MSIX_PUBLISHER` must match the signing certificate's subject); **not built or tested yet** (needs the Windows SDK) |

## 5. Install, uninstall, data locations

| | Windows | macOS | Linux |
|---|---|---|---|
| App | `%LOCALAPPDATA%\Programs\Lumen Secure\` | `/Applications/Lumen Secure.app` (drag from the DMG) | `/opt/Lumen Secure/` (deb) or the AppImage |
| User data (sessions, IndexedDB, settings, logs) | `%APPDATA%\Lumen Secure\` | `~/Library/Application Support/Lumen Secure/` | `~/.config/Lumen Secure/` |
| Store key / PIN verifier | `store-key.bin`, `applock.bin` in user data, DPAPI-encrypted (the DPAPI key is in `Local State`) | same files, encrypted with the "Lumen Secure Safe Storage" Keychain item | same files; libsecret/KWallet, or the fixed `basic_text` key with a warning |
| Update cache | `%LOCALAPPDATA%\lumen-desktop-updater\` | `~/Library/Caches/lumen-desktop-updater/` | — |
| Log | `<user data>\logs\main.log` (1 MB, rotated once; never tokens, keys, PINs or message content) | same | same |
| Uninstall | Settings → Apps. The uninstaller has an option page, "Also delete my local data", unticked by default. Ticking it removes user data and the update cache. Updates never delete data. Silent uninstall keeps data unless run with `--delete-app-data`. | Move the app to the Bin. Data stays until the user deletes the folders above. The Keychain item stays until deleted in Keychain Access. | `apt remove` keeps `~/.config/Lumen Secure` |

Signing out in the app deletes that account's local data and the store key, whatever the
installer does. Use it before handing a computer on.

## 6. Verifying a release

1. Compare checksums against the release's `SHA256SUMS`:
   - Windows: `Get-FileHash -Algorithm SHA256 .\Lumen-Secure-<v>-win-x64.exe`
   - macOS/Linux: `shasum -a 256 -c SHA256SUMS --ignore-missing`

   The CI artifact also contains `smoke-<os>-<arch>.json` with the packaged-app checks.
2. Check signatures:
   - Windows: `Get-AuthenticodeSignature`, which must say `Valid` with the expected signer.
   - macOS: `codesign`/`spctl`/`stapler` as in §2.
3. Check the hardening of an installed copy: `"<app exe>" --self-check=report.json` exits 0.
   It runs with a throw-away profile, opens the server picker and checks CSP, sandbox, context
   isolation, permission denials and the navigation lock; it reads no user data.
   - Windows: also expect `renderer process sandboxed by the OS` and safeStorage = DPAPI.
   - macOS: also expect `renderer process sandboxed by the OS`.
4. Fuses: `npx @electron/fuses read --app "<app exe or .app>"` must show RunAsNode, NodeOptions
   and NodeCliInspect off, and asar integrity and only-load-from-asar on.

## 7. CI evidence

| Run | Commit | Linux | Windows | macOS |
|---|---|---|---|---|
| [38703895098](https://github.com/Techprosoftware707/0trust-chat/actions/runs/38703895098) | 05cc2fb | ✓ unit 34/34, dist:linux, smoke 41/41 (packaged, setuid sandbox) | see report | ✗ packaging: empty `CSC_LINK` secret taken as a certificate path (fixed: empty signing variables are now ignored) |

## 8. Not verified yet

These need credentials, devices or real machines that this project has not had:

- Authenticode signing, SmartScreen reputation, and Developer ID signing + notarization +
  Gatekeeper on a real signed release.
- Auto-update end to end with a signed feed, on both OSes.
- The NSIS install/uninstall on a real Windows machine, including the "Also delete my local
  data" option, shortcuts and the `io.lumen.secure` registration through the browser.
- The macOS `open-url` SSO return through a real browser.
- Touch ID, the macOS camera/microphone/screen-recording prompts, real cameras and microphones,
  Bluetooth headsets.
- Windows taskbar overlay badge, notifications in the Windows Action Center and macOS
  Notification Center, open at login.
- MSIX/AppX.
