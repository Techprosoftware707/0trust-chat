#!/usr/bin/env python3
"""Render the iOS app icon and launch logo from the Lumen mark.

    python3 apps/ios/scripts/gen-app-icon.py

The geometry and colours mirror branding/logo.svg (viewBox 0 0 64 64): a
midnight rounded square, a cyan glow at (42,22) r16, an L-shaped stroke
M21 16 v22.5 A9.5 9.5 0 0 0 30.5 48 H46 (width 7, round caps) and a dot at
(42,22) r5.5, both filled with the cyan -> teal -> violet gradient from
(10,8) to (56,58). No SVG rasteriser is needed (Pillow + numpy only), so the
output is reproducible on any machine. If logo.svg changes, update the
constants below and re-run.

Outputs (in apps/ios/Lumen/Resources/Assets.xcassets):
  AppIcon.appiconset/AppIcon-1024.png   opaque, full-bleed (iOS applies the mask)
  LaunchLogo.imageset/LaunchLogo{,@2x,@3x}.png   96 pt, transparent corners
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "Lumen" / "Resources" / "Assets.xcassets"

MIDNIGHT = (0x0A, 0x16, 0x30)
GLOW = (0x8B, 0xE3, 0xF0)
STOPS = [(0.0, (0x5C, 0xD0, 0xE6)), (0.55, (0x3C, 0xCF, 0xB6)), (1.0, (0x86, 0x76, 0xF4))]
GRAD_FROM, GRAD_TO = (10.0, 8.0), (56.0, 58.0)


def gradient(size: int, to_px) -> np.ndarray:
    """RGB array of the linear gradient in pixel space."""
    ax, ay = to_px(*GRAD_FROM)
    bx, by = to_px(*GRAD_TO)
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float32) + 0.5
    dx, dy = bx - ax, by - ay
    t = ((xx - ax) * dx + (yy - ay) * dy) / (dx * dx + dy * dy)
    t = np.clip(t, 0.0, 1.0)
    out = np.zeros((size, size, 3), dtype=np.float32)
    for ch in range(3):
        xs = [s[0] for s in STOPS]
        ys = [s[1][ch] for s in STOPS]
        out[..., ch] = np.interp(t, xs, ys)
    return out


def render(size: int, full_bleed: bool) -> Image.Image:
    """Renders supersampled and downsamples for anti-aliasing."""
    ss = 2 if size >= 512 else 4
    big = size * ss
    if full_bleed:
        # The logo's rounded square (2..62) becomes the whole canvas.
        k = big / 60.0
        def to_px(x, y): return ((x - 2.0) * k, (y - 2.0) * k)
    else:
        k = big / 64.0
        def to_px(x, y): return (x * k, y * k)

    canvas = np.zeros((big, big, 4), dtype=np.float32)
    # Background
    bg_mask = Image.new("L", (big, big), 0)
    d = ImageDraw.Draw(bg_mask)
    if full_bleed:
        d.rectangle([0, 0, big, big], fill=255)
    else:
        x0, y0 = to_px(2, 2)
        x1, y1 = to_px(62, 62)
        d.rounded_rectangle([x0, y0, x1, y1], radius=18 * k, fill=255)
    bg_a = np.asarray(bg_mask, dtype=np.float32) / 255.0
    for ch in range(3):
        canvas[..., ch] = MIDNIGHT[ch]
    canvas[..., 3] = bg_a

    # Glow: radial, alpha 0.55 at the centre to 0 at r=16
    cx, cy = to_px(42, 22)
    r = 16 * k
    yy, xx = np.mgrid[0:big, 0:big].astype(np.float32) + 0.5
    dist = np.sqrt((xx - cx) ** 2 + (yy - cy) ** 2)
    glow_a = np.clip(1.0 - dist / r, 0.0, 1.0) * 0.55 * bg_a
    for ch in range(3):
        canvas[..., ch] = canvas[..., ch] * (1 - glow_a) + GLOW[ch] * glow_a

    # Stroke + dot mask
    mark = Image.new("L", (big, big), 0)
    md = ImageDraw.Draw(mark)
    w = 7 * k
    half = w / 2
    p_top, p_corner_start = to_px(21, 16), to_px(21, 38.5)
    p_corner_end, p_end = to_px(30.5, 48), to_px(46, 48)
    md.line([p_top, p_corner_start], fill=255, width=int(round(w)))
    md.line([p_corner_end, p_end], fill=255, width=int(round(w)))
    acx, acy = to_px(30.5, 38.5)
    rr = 9.5 * k + half  # Pillow draws arc width inwards from the bbox
    md.arc([acx - rr, acy - rr, acx + rr, acy + rr], start=90, end=180, fill=255, width=int(round(w)))
    for (px, py) in (p_top, p_end, p_corner_start, p_corner_end):
        md.ellipse([px - half, py - half, px + half, py + half], fill=255)
    dx, dy = to_px(42, 22)
    dr = 5.5 * k
    md.ellipse([dx - dr, dy - dr, dx + dr, dy + dr], fill=255)
    mark_a = np.asarray(mark, dtype=np.float32) / 255.0
    grad = gradient(big, to_px)
    for ch in range(3):
        canvas[..., ch] = canvas[..., ch] * (1 - mark_a) + grad[..., ch] * mark_a

    rgba = np.zeros((big, big, 4), dtype=np.uint8)
    rgba[..., :3] = np.clip(canvas[..., :3], 0, 255).astype(np.uint8)
    rgba[..., 3] = np.clip(canvas[..., 3] * 255, 0, 255).astype(np.uint8)
    img = Image.fromarray(rgba, "RGBA").resize((size, size), Image.LANCZOS)
    if full_bleed:
        img = img.convert("RGB")  # App Store icons must not have an alpha channel
    return img


def write_json(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=2) + "\n")


def main() -> None:
    info = {"author": "xcode", "version": 1}
    write_json(ASSETS / "Contents.json", {"info": info})

    icon_dir = ASSETS / "AppIcon.appiconset"
    icon_dir.mkdir(parents=True, exist_ok=True)
    render(1024, full_bleed=True).save(icon_dir / "AppIcon-1024.png", optimize=True)
    write_json(icon_dir / "Contents.json", {
        "images": [{"filename": "AppIcon-1024.png", "idiom": "universal", "platform": "ios", "size": "1024x1024"}],
        "info": info,
    })

    launch_dir = ASSETS / "LaunchLogo.imageset"
    launch_dir.mkdir(parents=True, exist_ok=True)
    images = []
    for scale in (1, 2, 3):
        name = "LaunchLogo.png" if scale == 1 else f"LaunchLogo@{scale}x.png"
        render(96 * scale, full_bleed=False).save(launch_dir / name, optimize=True)
        images.append({"filename": name, "idiom": "universal", "scale": f"{scale}x"})
    write_json(launch_dir / "Contents.json", {"images": images, "info": info})

    def color(r, g, b):
        return {"color-space": "srgb", "components": {"red": f"0x{r:02X}", "green": f"0x{g:02X}", "blue": f"0x{b:02X}", "alpha": "1.000"}}

    # Launch background: midnight-950 in both appearances (the mark is designed for a dark ground).
    write_json(ASSETS / "LaunchBackground.colorset" / "Contents.json", {
        "colors": [
            {"idiom": "universal", "color": color(0x05, 0x0B, 0x1A)},
            {"idiom": "universal", "appearances": [{"appearance": "luminosity", "value": "dark"}], "color": color(0x05, 0x0B, 0x1A)},
        ],
        "info": info,
    })
    # Accent: --accent light (cyan-600) / dark (cyan-400) from design/tokens.css.
    write_json(ASSETS / "AccentColor.colorset" / "Contents.json", {
        "colors": [
            {"idiom": "universal", "color": color(0x0E, 0x8F, 0xB0)},
            {"idiom": "universal", "appearances": [{"appearance": "luminosity", "value": "dark"}], "color": color(0x5C, 0xD0, 0xE6)},
        ],
        "info": info,
    })
    print(f"wrote {ASSETS}")


if __name__ == "__main__":
    main()
