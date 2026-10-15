#!/usr/bin/env node
/**
 * Compiles the main process, preloads and desktop pages (esbuild) into dist/, copies the
 * pages' static files and writes dist/desktop-config.json from LUMEN_DEFAULT_SERVER
 * (a server name such as "example.com"; empty or unset = the user is asked on first run).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const repo = path.resolve(root, "../..");
const dist = path.join(root, "dist");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

for (const d of ["main", "preload", "pages"]) fs.rmSync(path.join(dist, d), { recursive: true, force: true });

const common = { bundle: true, sourcemap: false, minify: false, legalComments: "inline", logLevel: "info", target: "es2023" };

// Main process (Node + Electron). electron-updater stays a runtime dependency (node_modules in the asar).
await build({
  ...common,
  entryPoints: [path.join(root, "src/main/index.ts")],
  outfile: path.join(dist, "main/index.cjs"),
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["electron", "electron-updater"],
  define: { "process.env.LUMEN_BUILD_VERSION": JSON.stringify(pkg.version) },
});

// Preloads run sandboxed: only `electron` (renderer subset) may be required; no Node built-ins.
for (const name of ["app", "lock", "settings", "picker"]) {
  await build({
    ...common,
    entryPoints: [path.join(root, `src/preload/${name}.ts`)],
    outfile: path.join(dist, `preload/${name}.cjs`),
    platform: "browser",
    format: "cjs",
    target: "chrome130",
    external: ["electron"],
  });
}

// Desktop pages (served from app://desktop/, CSP script-src 'self').
const pagesOut = path.join(dist, "pages");
for (const name of ["setup", "lock", "settings", "picker"]) {
  await build({
    ...common,
    entryPoints: [path.join(root, `src/pages/${name}.ts`)],
    outfile: path.join(pagesOut, `${name}.js`),
    platform: "browser",
    format: "iife",
    target: "chrome130",
  });
  fs.copyFileSync(path.join(root, `src/pages/${name}.html`), path.join(pagesOut, `${name}.html`));
}
fs.copyFileSync(path.join(root, "src/pages/pages.css"), path.join(pagesOut, "pages.css"));
fs.copyFileSync(path.join(repo, "design/tokens.css"), path.join(pagesOut, "tokens.css"));
fs.copyFileSync(path.join(repo, "branding/logo.svg"), path.join(pagesOut, "logo.svg"));
fs.mkdirSync(path.join(pagesOut, "fonts"), { recursive: true });
for (const f of fs.readdirSync(path.join(repo, "design/fonts"))) fs.copyFileSync(path.join(repo, "design/fonts", f), path.join(pagesOut, "fonts", f));

// Build-time default server (ADR 0003 D6): a server name, never a URL.
const def = (process.env.LUMEN_DEFAULT_SERVER ?? "").trim().toLowerCase();
if (def && !/^[a-z0-9.-]+(:\d{1,5})?$/.test(def)) {
  console.error(`LUMEN_DEFAULT_SERVER must be a server name like example.com, got "${def}"`);
  process.exit(1);
}
fs.writeFileSync(path.join(dist, "desktop-config.json"), JSON.stringify({ default_server: def }, null, 2) + "\n");
console.log(`desktop-config.json: default server ${def ? `"${def}"` : "(none: ask on first run)"}`);
