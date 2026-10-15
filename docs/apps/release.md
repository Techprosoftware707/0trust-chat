# Releasing the Lumen apps

How Windows, macOS, Android and iOS/iPadOS builds are produced, signed and
published. Platform specifics:

- [release-desktop.md](release-desktop.md) (Windows, macOS);
- [release-android.md](release-android.md);
- [release-ios.md](release-ios.md).

## Pipeline

| Workflow | Runs on | When | Produces |
|---|---|---|---|
| `ci.yml` | ubuntu-24.04 | every push and PR | token and renderer checks, shellcheck, TLS-bypass and secret guards, web client checks and build, portal tests |
| `desktop.yml` | ubuntu-24.04, windows-2025, macos-15 | changes to `apps/desktop`, `services/chat`, `design`, `branding` | Windows `.exe` (NSIS), macOS `.dmg` + `.zip`, Linux `.AppImage` + `.deb`, update metadata, `SHA256SUMS-*.txt` |
| `android.yml` | ubuntu-24.04 (+ emulator with KVM) | changes to `apps/android` | unit tests, lint, debug + release `.apk`, release `.aab`, instrumented tests on an API 35 emulator |
| `ios.yml` | macos-15, Xcode 26 | changes to `apps/ios` | generated Xcode project, simulator build and tests (iPhone, iPad), unsigned `.xcarchive` |
| `release.yml` | all of the above | tag `vX.Y.Z` or manual | everything above, one `SHA256SUMS.txt`, and a **draft** GitHub release whose notes state the signing status of each artifact |
| `toolchains.yml` | all runners | on demand | inventory of Xcode, SDK and Android versions on the runners |

Third-party actions are pinned to commit SHAs. Every job has
`permissions: contents: read`, except the release publishing job, which has
`contents: write`.

## Versions

| Item | Rule |
|---|---|
| Tag | `vMAJOR.MINOR.PATCH`; all four apps share the version of the release |
| Android `versionCode` | `MAJOR*10000 + MINOR*100 + PATCH`, set with Gradle properties |
| iOS | `CFBundleShortVersionString` = version, `CFBundleVersion` = CI run number |
| Desktop | `apps/desktop/package.json` `version`; electron-updater compares it |

## Signing material (GitHub repository secrets, never committed)

| Secret | Used for | Without it |
|---|---|---|
| `WINDOWS_CSC_LINK`, `WINDOWS_CSC_KEY_PASSWORD` | Authenticode certificate (base64 `.pfx`) for the installer and the app executable | Unsigned installer. SmartScreen warns. Auto-update stays disabled. |
| `MACOS_CSC_LINK`, `MACOS_CSC_KEY_PASSWORD` | "Developer ID Application" certificate (base64 `.p12`) | Unsigned app. Gatekeeper blocks it unless the user overrides. No auto-update. |
| `APPLE_API_KEY_BASE64`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` | App Store Connect API key: macOS notarization, iOS TestFlight upload | No notarization or upload |
| `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` | Android **upload key**. With Play App Signing, Google holds the app signing key. | Unsigned release APK and AAB. The debug APK is signed with the debug key, for testing only. |
| `IOS_DIST_CERT_P12_BASE64`, `IOS_DIST_CERT_PASSWORD`, `IOS_PROFILES_BASE64` | Apple Distribution certificate and the provisioning profiles for the app and the notification extension | Unsigned archive only |

Public build settings are not secrets. They are GitHub repository
**variables**:

- `LUMEN_DEFAULT_SERVER`;
- `LUMEN_UPDATE_URL`;
- `LUMEN_FCM_PROJECT_ID`, `LUMEN_FCM_APP_ID`, `LUMEN_FCM_API_KEY`,
  `LUMEN_FCM_SENDER_ID`. Firebase client identifiers ship inside every APK
  anyway.

No private key, password, certificate or provisioning profile is ever
committed. The `ci.yml` guard fails on `.jks`, `.keystore`, `.p12`, `.pfx`,
`.p8`, `.mobileprovision`, `google-services.json` and
`GoogleService-Info.plist` files, and on PEM private keys.

## Making a release

1. Update the version (see above). Make sure `ci.yml`, `desktop.yml`,
   `android.yml` and `ios.yml` are green on the release commit.
2. `git tag -s vX.Y.Z && git push origin vX.Y.Z`.
3. `release.yml` builds everything on the native runners and creates a
   **draft** release with the artifacts, `SHA256SUMS.txt`, and notes listing
   which artifacts are signed.
4. Review the draft:
   - signing status;
   - [feature matrix](feature-matrix.md) and test report for this version;
   - for desktop updates, check that `latest.yml` / `latest-mac.yml` match the
     signed files.
5. Publish the draft. Desktop clients that update from GitHub releases see it
   only after publication.
6. Store submissions are manual: Play Console (AAB), App Store Connect
   (archive), Microsoft Store (MSIX, optional). See the platform guides.

## Verifying a download

```bash
sha256sum -c SHA256SUMS.txt                       # Linux
shasum -a 256 -c SHA256SUMS.txt                   # macOS
Get-FileHash .\Lumen-Setup-X.Y.Z.exe -Algorithm SHA256   # Windows (compare by hand)
```

The signatures themselves can be checked as follows:

- Windows: `Get-AuthenticodeSignature`.
- macOS: `codesign --verify --deep --strict` and `spctl -a -vv`.
- Android: `apksigner verify --print-certs`. The certificate fingerprint must
  match `APP_LINKS_ANDROID_SHA256` on the operator's server.
- iOS: through TestFlight / App Store installation.

## What CI does not prove

CI builds the apps and runs their unit, simulator and emulator tests. It does
not cover:

- push delivery through Google or Apple;
- CallKit or Telecom with the phone app;
- Bluetooth audio;
- real cameras;
- real internet NAT traversal.

Those need signed builds on physical devices, and the
[feature matrix](feature-matrix.md) records them separately.
