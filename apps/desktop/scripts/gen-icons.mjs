#!/usr/bin/env node
/**
 * Generates every icon from branding/logo.svg (rendered with sharp/librsvg):
 *   build/generated/icon.icns            macOS app icon (PNG-based ICNS, padded to Apple's grid)
 *   build/generated/icon.ico             Windows app/installer icon (16–256 px, PNG entries)
 *   build/generated/png/<n>x<n>.png      Linux icon set (16–1024)
 *   dist/icons/tray.ico | tray.png       tray icon (Windows | Linux)
 *   dist/icons/trayTemplate(@2x).png     macOS menu-bar template image (monochrome glyph)
 *   dist/icons/icon-256.png, icon-512.png  window / notification icon (Linux)
 *   dist/icons/badge-dot.png             Windows taskbar overlay for unread messages
 * ICO and ICNS containers are written here (both are simple PNG-entry formats).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const repo = path.resolve(root, "../..");
const logo = fs.readFileSync(path.join(repo, "branding/logo.svg"), "utf8");
const gen = path.join(root, "build/generated");
const icons = path.join(root, "dist/icons");
fs.mkdirSync(path.join(gen, "png"), { recursive: true });
fs.mkdirSync(icons, { recursive: true });

const render = (svg, size) => sharp(Buffer.from(svg), { density: Math.max(72, (72 * size) / 64) * 4 }).resize(size, size).png({ compressionLevel: 9 }).toBuffer();

/** The logo centred on Apple's icon grid (824/1024 content), transparent margin. */
function paddedSvg() {
  const inner = logo.replace(/<\?xml[^>]*>/, "").replace(/<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-7.75 -7.75 79.5 79.5">${inner}</svg>`;
}

/** Monochrome glyph (the logo's stroke and dot) for the macOS menu bar. */
function templateSvg() {
  const d = /<path[^>]*\sd="([^"]+)"/.exec(logo)?.[1];
  const circles = [...logo.matchAll(/<circle[^>]*cx="([\d.]+)"[^>]*cy="([\d.]+)"[^>]*r="([\d.]+)"[^>]*fill="url\(#lm-g\)"/g)];
  const dot = circles.at(-1);
  if (!d || !dot) throw new Error("couldn't find the glyph in branding/logo.svg");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="12 9 46 46"><path d="${d}" fill="none" stroke="#000" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/><circle cx="${dot[1]}" cy="${dot[2]}" r="${dot[3]}" fill="#000"/></svg>`;
}

function ico(entries) {
  const header = Buffer.alloc(6 + 16 * entries.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  let offset = header.length;
  entries.forEach(({ size, png }, i) => {
    const o = 6 + 16 * i;
    header.writeUInt8(size >= 256 ? 0 : size, o);
    header.writeUInt8(size >= 256 ? 0 : size, o + 1);
    header.writeUInt8(0, o + 2);
    header.writeUInt8(0, o + 3);
    header.writeUInt16LE(1, o + 4);
    header.writeUInt16LE(32, o + 6);
    header.writeUInt32LE(png.length, o + 8);
    header.writeUInt32LE(offset, o + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...entries.map((e) => e.png)]);
}

function icns(chunks) {
  const parts = chunks.map(({ type, png }) => {
    const h = Buffer.alloc(8);
    h.write(type, 0, "ascii");
    h.writeUInt32BE(png.length + 8, 4);
    return Buffer.concat([h, png]);
  });
  const body = Buffer.concat(parts);
  const h = Buffer.alloc(8);
  h.write("icns", 0, "ascii");
  h.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([h, body]);
}

const full = {};
for (const s of [16, 20, 24, 32, 40, 48, 64, 128, 256, 512, 1024]) full[s] = await render(logo, s);
for (const s of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) fs.writeFileSync(path.join(gen, "png", `${s}x${s}.png`), full[s]);
fs.writeFileSync(path.join(gen, "icon.png"), full[1024]);
fs.writeFileSync(path.join(gen, "icon.ico"), ico([16, 24, 32, 48, 64, 128, 256].map((size) => ({ size, png: full[size] }))));

const padded = paddedSvg();
const mac = {};
for (const s of [16, 32, 64, 128, 256, 512, 1024]) mac[s] = await render(padded, s);
fs.writeFileSync(
  path.join(gen, "icon.icns"),
  icns([
    { type: "icp4", png: mac[16] },
    { type: "icp5", png: mac[32] },
    { type: "icp6", png: mac[64] },
    { type: "ic07", png: mac[128] },
    { type: "ic08", png: mac[256] },
    { type: "ic09", png: mac[512] },
    { type: "ic10", png: mac[1024] },
    { type: "ic11", png: mac[32] },
    { type: "ic12", png: mac[64] },
    { type: "ic13", png: mac[256] },
    { type: "ic14", png: mac[512] },
  ]),
);

fs.writeFileSync(path.join(icons, "tray.ico"), ico([16, 20, 24, 32, 40, 48].map((size) => ({ size, png: full[size] }))));
fs.writeFileSync(path.join(icons, "tray.png"), full[32]);
const tpl = templateSvg();
fs.writeFileSync(path.join(icons, "trayTemplate.png"), await render(tpl, 16));
fs.writeFileSync(path.join(icons, "trayTemplate@2x.png"), await render(tpl, 32));
fs.writeFileSync(path.join(icons, "icon-256.png"), full[256]);
fs.writeFileSync(path.join(icons, "icon-512.png"), full[512]);
fs.writeFileSync(
  path.join(icons, "badge-dot.png"),
  await render(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="#e5484d" stroke="#fff" stroke-width="1.5"/></svg>`, 16),
);
console.log(`icons: ${fs.readdirSync(icons).length} runtime icons in dist/icons, icns/ico/png set in build/generated`);
