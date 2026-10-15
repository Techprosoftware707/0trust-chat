#!/usr/bin/env node
/** Writes release/SHA256SUMS for every distributable in release/ (installers, archives, update metadata). */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const release = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../release");
const files = fs
  .readdirSync(release, { withFileTypes: true })
  .filter((e) => e.isFile() && /\.(exe|msi|msix|appx|dmg|zip|AppImage|deb|yml|blockmap)$/.test(e.name))
  .map((e) => e.name)
  .sort();
const lines = files.map((f) => `${createHash("sha256").update(fs.readFileSync(path.join(release, f))).digest("hex")}  ${f}`);
fs.writeFileSync(path.join(release, "SHA256SUMS"), lines.join("\n") + "\n");
console.log(lines.join("\n"));
