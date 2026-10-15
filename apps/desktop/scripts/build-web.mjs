#!/usr/bin/env node
/**
 * Builds the Lumen web client (services/chat) for the desktop app and copies it into
 * dist/web (served as app://lumen/). Runs the web client's own type check and production
 * Vite build, but writes to dist/web instead of services/chat/dist so a concurrent web
 * build is not disturbed. Branding goes to dist/web/brand (the web deployment serves it
 * from /brand/ the same way).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, "..");
const repo = path.resolve(desktop, "../..");
const chat = path.join(repo, "services/chat");
const out = path.join(desktop, "dist/web");

function run(args, cwd) {
  console.log(`> node ${args.join(" ")}   (in ${path.relative(repo, cwd) || "."})`);
  execFileSync(process.execPath, args, { cwd, stdio: "inherit", env: { ...process.env, NODE_ENV: "production" } });
}

if (!fs.existsSync(path.join(chat, "node_modules", "vite"))) {
  console.log("services/chat dependencies missing: npm ci --ignore-scripts");
  execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: chat, stdio: "inherit", shell: process.platform === "win32" });
}

run([path.join(chat, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.json", "--noEmit"], chat);
fs.rmSync(out, { recursive: true, force: true });
run([path.join(chat, "node_modules/vite/bin/vite.js"), "build", "--outDir", out, "--emptyOutDir"], chat);

const brand = path.join(out, "brand");
fs.mkdirSync(brand, { recursive: true });
for (const f of ["logo.svg", "favicon.svg", "theme.css"]) fs.copyFileSync(path.join(repo, "branding", f), path.join(brand, f));

for (const required of ["index.html", "theme-init.js"]) {
  if (!fs.existsSync(path.join(out, required))) throw new Error(`web build incomplete: ${required} missing`);
}
if (fs.existsSync(path.join(out, "config.json"))) fs.rmSync(path.join(out, "config.json"));
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else files.push(fs.statSync(p).size);
  }
})(out);
const wasm = fs.readdirSync(path.join(out, "assets")).filter((f) => f.endsWith(".wasm"));
if (!wasm.length) throw new Error("web build has no crypto WASM");
console.log(`web client: ${files.length} files, ${(files.reduce((a, b) => a + b, 0) / 1e6).toFixed(1)} MB -> ${path.relative(repo, out)}`);
