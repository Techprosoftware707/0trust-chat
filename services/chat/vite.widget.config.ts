/**
 * Build of the mobile apps' call widget (docs/apps/integration.md §6.2):
 *
 *   npm run build:widget  →  dist-widget/index.html + dist-widget/assets/…
 *
 * Same sources, plugins and settings as the web app (vite.config.ts), with:
 *  - entry widget.html (emitted as index.html);
 *  - relative asset URLs (`base: "./"`): the bundle is served from
 *    https://appassets.androidplatform.net/call-widget/, lumen-widget://call/ and
 *    https://app.<domain>/widget/call/;
 *  - no public/ files: nothing is fetched from a server at run time (no /config.json,
 *    no /brand/): the widget works from its bundled assets alone;
 *  - no Rust crypto (WASM): the widget client never holds keys — the app's Rust SDK encrypts
 *    and decrypts for it — so matrix-js-sdk's lazily loaded crypto module is replaced by a stub.
 */
import { renameSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig, type Plugin } from "vite";
import base from "./vite.config";

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, "dist-widget");

const NO_CRYPTO = "\0lumen-widget-no-rust-crypto";

/**
 * matrix-js-sdk loads its Rust crypto (7.8 MB of WebAssembly) only from `initRustCrypto()`,
 * through `import("./rust-crypto/index.js")` in lib/client.js. The widget's RoomWidgetClient
 * never calls it; the stub keeps the WASM out of the apps' bundle and fails loudly if anything
 * ever did.
 */
function noRustCrypto(): Plugin {
  return {
    name: "lumen-widget-no-rust-crypto",
    enforce: "pre",
    resolveId(source, importer) {
      if (source === "./rust-crypto/index.js" && importer && /[\\/]matrix-js-sdk[\\/]lib[\\/]client\.js$/.test(importer)) return NO_CRYPTO;
      return null;
    },
    load(id) {
      if (id !== NO_CRYPTO) return null;
      return 'export async function initRustCrypto() { throw new Error("The call widget has no crypto store: the app encrypts for it."); }\n';
    },
  };
}

/** widget.html → index.html (the name the apps load). */
function widgetIndex(): Plugin {
  return {
    name: "lumen-widget-index",
    apply: "build",
    closeBundle() {
      const from = path.join(outDir, "widget.html");
      if (existsSync(from)) renameSync(from, path.join(outDir, "index.html"));
    },
  };
}

export default mergeConfig(
  base,
  defineConfig({
    base: "./",
    publicDir: false,
    plugins: [noRustCrypto(), widgetIndex()],
    build: {
      outDir,
      emptyOutDir: true,
      rollupOptions: { input: path.join(here, "widget.html") },
    },
  }),
);
