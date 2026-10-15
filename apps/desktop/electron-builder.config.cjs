/**
 * electron-builder configuration for Lumen Secure desktop.
 *
 * Every signing / notarization / update input comes from the environment (CI secrets);
 * nothing secret is in the repository. Without them the build is unsigned and says so.
 *
 *   LUMEN_DEFAULT_SERVER         build-time default server name (scripts/build-app.mjs)
 *   LUMEN_APP_ID                 white-label app ID (default io.lumen.secure); also the URL scheme
 *   LUMEN_PRODUCT_NAME           white-label product name (default "Lumen Secure")
 *   LUMEN_UPDATE_URL             update feed (generic provider: https://…/desktop/)  — or
 *   LUMEN_UPDATE_GITHUB          "owner/repo" for GitHub releases. Neither: no auto-update feed.
 *   CSC_LINK, CSC_KEY_PASSWORD   code-signing certificate (.p12/.pfx) for macOS (Developer ID
 *                                Application) or Windows (Authenticode); WIN_CSC_LINK /
 *                                WIN_CSC_KEY_PASSWORD override for Windows when both are built
 *   LUMEN_WIN_PUBLISHER_NAME     Authenticode subject CN(s), comma-separated, that updates must be
 *                                signed with (electron-updater check); derived from the cert if unset
 *   AZURE_TRUSTED_SIGNING_ENDPOINT, AZURE_TRUSTED_SIGNING_ACCOUNT, AZURE_TRUSTED_SIGNING_PROFILE
 *                                Windows signing via Azure Trusted Signing (with AZURE_TENANT_ID,
 *                                AZURE_CLIENT_ID, AZURE_CLIENT_SECRET for the service principal)
 *   APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER   notarization with an App Store Connect API key
 *   APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID  notarization with an Apple ID (alternative)
 *   LUMEN_MSIX_PUBLISHER         "CN=…" of the MSIX/AppX signing certificate (appx target only)
 */
const env = process.env;
// CI passes secrets as env vars that are empty when the secret isn't configured; an empty
// CSC_LINK would make electron-builder try to load a certificate from the working directory.
for (const k of [
  "CSC_LINK",
  "CSC_KEY_PASSWORD",
  "CSC_NAME",
  "WIN_CSC_LINK",
  "WIN_CSC_KEY_PASSWORD",
  "APPLE_API_KEY",
  "APPLE_API_KEY_ID",
  "APPLE_API_ISSUER",
  "APPLE_ID",
  "APPLE_APP_SPECIFIC_PASSWORD",
  "APPLE_TEAM_ID",
  "APPLE_KEYCHAIN_PROFILE",
  "LUMEN_UPDATE_URL",
  "LUMEN_UPDATE_GITHUB",
  "LUMEN_WIN_PUBLISHER_NAME",
  "AZURE_TRUSTED_SIGNING_ENDPOINT",
  "AZURE_TRUSTED_SIGNING_ACCOUNT",
  "AZURE_TRUSTED_SIGNING_PROFILE",
]) {
  if (env[k] !== undefined && env[k].trim() === "") delete env[k];
}
const appId = env.LUMEN_APP_ID || "io.lumen.secure";
const productName = env.LUMEN_PRODUCT_NAME || "Lumen Secure";
const has = (...names) => names.every((n) => !!env[n]);

const macSigning = has("CSC_LINK") || has("CSC_NAME");
const notarize = macSigning && (has("APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER") || has("APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID") || has("APPLE_KEYCHAIN_PROFILE"));
const azure = has("AZURE_TRUSTED_SIGNING_ENDPOINT", "AZURE_TRUSTED_SIGNING_ACCOUNT", "AZURE_TRUSTED_SIGNING_PROFILE");
const winPublisher = (env.LUMEN_WIN_PUBLISHER_NAME || "").split(",").map((s) => s.trim()).filter(Boolean);

let publish = null;
if (env.LUMEN_UPDATE_URL) {
  if (!/^https:\/\//.test(env.LUMEN_UPDATE_URL)) throw new Error("LUMEN_UPDATE_URL must be an https URL");
  publish = [{ provider: "generic", url: env.LUMEN_UPDATE_URL, useMultipleRangeRequest: false }];
} else if (env.LUMEN_UPDATE_GITHUB) {
  const [owner, repo] = env.LUMEN_UPDATE_GITHUB.split("/");
  if (!owner || !repo) throw new Error("LUMEN_UPDATE_GITHUB must be owner/repo");
  publish = [{ provider: "github", owner, repo, releaseType: "release" }];
}

/** @type {import("electron-builder").Configuration} */
module.exports = {
  appId,
  productName,
  copyright: "Lumen contributors — AGPL-3.0-or-later",
  directories: { output: "release", buildResources: "build" },
  files: ["dist/**/*", "package.json", "!**/*.map", "!**/node_modules/**/*.{map,md,d.ts}"],
  asar: true,
  compression: "normal",
  // electron-updater (and its dependencies) is the only node_modules content; the rest is bundled by esbuild.
  extraMetadata: { main: "dist/main/index.cjs" },
  protocols: [{ name: `${productName} sign-in`, schemes: [appId] }],
  publish,
  electronFuses: {
    runAsNode: false,
    enableCookieEncryption: true,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
    loadBrowserProcessSpecificV8Snapshot: false,
    grantFileProtocolExtraPrivileges: false,
    // Unsigned macOS builds: re-apply the ad-hoc signature after flipping fuses (arm64 refuses
    // to run binaries with a broken signature). Signed builds are signed after the fuses anyway.
    resetAdHocDarwinSignature: !macSigning,
  },
  // No spaces in file names: GitHub release assets and update feeds rewrite them.
  artifactName: `${productName.replace(/\s+/g, "-")}-\${version}-\${os}-\${arch}.\${ext}`,

  // ---------------------------------------------------------------- macOS
  mac: {
    category: "public.app-category.social-networking",
    icon: "build/generated/icon.icns",
    target: [
      { target: "dmg", arch: ["arm64", "x64"] },
      { target: "zip", arch: ["arm64", "x64"] },
    ],
    // Hardened runtime for Developer ID builds (required for notarization). An ad-hoc signed
    // build can't use it without disabling library validation, so unsigned test builds go without.
    hardenedRuntime: macSigning,
    gatekeeperAssess: false,
    entitlements: "build/entitlements.mac.plist",
    entitlementsInherit: "build/entitlements.mac.inherit.plist",
    // No certificate: ad-hoc signature, so Apple-silicon builds still launch locally (Gatekeeper
    // will refuse them when downloaded: unsigned builds are for testing only).
    identity: macSigning ? undefined : "-",
    notarize,
    extendInfo: {
      NSCameraUsageDescription: "Lumen uses the camera for video calls.",
      NSMicrophoneUsageDescription: "Lumen uses the microphone for calls.",
      NSAudioCaptureUsageDescription: "Lumen can share your computer's audio when you share your screen in a call.",
    },
  },
  dmg: {
    sign: false,
    writeUpdateInfo: false,
  },

  // ---------------------------------------------------------------- Windows
  win: {
    icon: "build/generated/icon.ico",
    target: [{ target: "nsis", arch: ["x64"] }],
    // Editing the exe resources needs no Wine (resedit); signing only when configured.
    signAndEditExecutable: true,
    ...(azure
      ? {}
      : {
          signtoolOptions: {
            ...(winPublisher.length ? { publisherName: winPublisher } : {}),
            signingHashAlgorithms: ["sha256"],
            rfc3161TimeStampServer: "http://timestamp.digicert.com",
          },
        }),
    ...(azure
      ? {
          azureSignOptions: {
            endpoint: env.AZURE_TRUSTED_SIGNING_ENDPOINT,
            codeSigningAccountName: env.AZURE_TRUSTED_SIGNING_ACCOUNT,
            certificateProfileName: env.AZURE_TRUSTED_SIGNING_PROFILE,
            ...(winPublisher.length ? { publisherName: winPublisher[0] } : {}),
          },
        }
      : {}),
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowElevation: false,
    allowToChangeInstallationDirectory: false,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: productName,
    deleteAppDataOnUninstall: false,
    runAfterFinish: true,
    include: "build/installer.nsh",
    installerIcon: "build/generated/icon.ico",
    uninstallerIcon: "build/generated/icon.ico",
    uninstallDisplayName: productName,
    differentialPackage: true,
  },
  // Optional Store/Intune package: `npm run dist:win:appx` on a Windows runner with the Windows SDK.
  appx: {
    applicationId: "LumenSecure",
    identityName: env.LUMEN_MSIX_IDENTITY || appId,
    displayName: productName,
    publisher: env.LUMEN_MSIX_PUBLISHER || "CN=Lumen Development (unsigned)",
    publisherDisplayName: env.LUMEN_MSIX_PUBLISHER_DISPLAY || "Lumen",
    backgroundColor: "#0a1630",
    languages: ["en-US"],
    capabilities: ["internetClient", "microphone", "webcam"],
  },

  // ---------------------------------------------------------------- Linux (local testing)
  linux: {
    icon: "build/generated/png",
    category: "Network;Chat;InstantMessaging;",
    executableName: "lumen-secure",
    maintainer: "Lumen <noreply@lumen.invalid>",
    synopsis: "End-to-end encrypted chat and calls",
    target: [
      { target: "AppImage", arch: ["x64"] },
      { target: "deb", arch: ["x64"] },
    ],
    syncDesktopName: true,
  },
  deb: {
    depends: ["libnss3", "libsecret-1-0", "libnotify4", "libxtst6", "libxss1", "libgbm1", "libasound2t64 | libasound2"],
  },
  appImage: { artifactName: `${productName.replace(/\s+/g, "-")}-\${version}-linux-\${arch}.\${ext}` },
};
