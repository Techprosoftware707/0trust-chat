#!/usr/bin/env node
/** Downloads the Electron binary for tests if `npm ci --ignore-scripts` skipped electron's install step. */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.join(root, "node_modules/electron");
if (!fs.existsSync(path.join(dir, "path.txt"))) {
  console.log("electron binary missing: running electron's install script");
  execFileSync(process.execPath, [path.join(dir, "install.js")], { stdio: "inherit", cwd: dir });
}
