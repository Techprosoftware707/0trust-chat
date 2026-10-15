#!/usr/bin/env python3
"""Convert the Lucide icons the Android app uses into VectorDrawables (ISC licence, see
app/src/main/assets/licenses/LICENSE-lucide.txt).

    python3 apps/android/tools/lucide_to_vector.py

Sources, in order: design/icons/<name>.svg (lucide-static, the design system's set), then the
same Lucide release's icon data in services/chat/node_modules/lucide-react (read only) for icons
the design set does not contain. Output: app/src/main/res/drawable/ic_lucide_<name>.xml.
Strokes are black and tinted at runtime by Compose's Icon(). Path data is re-serialised with
explicit separators (Android's parser is strict about packed arc flags).
"""
from __future__ import annotations

import math
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
DESIGN = ROOT / "design" / "icons"
LUCIDE_REACT = ROOT / "services" / "chat" / "node_modules" / "lucide-react" / "dist" / "esm" / "icons"
OUT = Path(__file__).resolve().parents[1] / "app" / "src" / "main" / "res" / "drawable"

ICONS = [
    "arrow-left", "ban", "bell", "bluetooth", "check", "check-check", "circle-alert", "clock", "cloud-off",
    "copy", "download", "ear", "external-link", "eye-off", "file", "headphones", "image", "info",
    "key-round", "laptop", "lock", "log-out", "message-circle", "messages-square", "more-horizontal",
    "paperclip", "pencil", "phone", "phone-incoming", "phone-off", "picture-in-picture-2", "plus",
    "refresh-cw", "reply", "search", "send", "settings", "shield", "shield-alert", "shield-check",
    "smartphone", "trash-2", "triangle-alert", "user", "user-plus", "user-x", "video", "volume-2",
    "wifi-off", "x",
]

NUM = re.compile(r"[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?")


def tokenize_path(d: str) -> list[str]:
    """Split SVG path data into commands and numbers, honouring packed arc flags."""
    out: list[str] = []
    i, cmd, argi = 0, None, 0
    arity = {"M": 2, "L": 2, "H": 1, "V": 1, "C": 6, "S": 4, "Q": 4, "T": 2, "A": 7, "Z": 0}
    while i < len(d):
        c = d[i]
        if c.isalpha():
            cmd, argi = c, 0
            out.append(c)
            i += 1
            continue
        if c in " ,\t\n\r":
            i += 1
            continue
        if cmd and cmd.upper() == "A" and argi % 7 in (3, 4) and c in "01":
            out.append(c)  # a single-character flag
            argi += 1
            i += 1
            continue
        m = NUM.match(d, i)
        if not m:
            raise ValueError(f"bad path data near {d[i:i+12]!r}")
        out.append(m.group(0))
        argi += 1
        i = m.end()
    return out


def fmt(x: float) -> str:
    s = f"{x:.4f}".rstrip("0").rstrip(".")
    return "0" if s in ("-0", "") else s


def normalise_path(d: str) -> str:
    return " ".join(tokenize_path(d))


def num(v) -> float:
    return float(v) if v not in (None, "") else 0.0


def shape_to_path(tag: str, a: dict) -> str:
    if tag == "path":
        return normalise_path(a["d"])
    if tag == "circle":
        cx, cy, r = num(a.get("cx")), num(a.get("cy")), num(a.get("r"))
        return (f"M {fmt(cx - r)} {fmt(cy)} A {fmt(r)} {fmt(r)} 0 1 0 {fmt(cx + r)} {fmt(cy)} "
                f"A {fmt(r)} {fmt(r)} 0 1 0 {fmt(cx - r)} {fmt(cy)} Z")
    if tag == "ellipse":
        cx, cy, rx, ry = num(a.get("cx")), num(a.get("cy")), num(a.get("rx")), num(a.get("ry"))
        return (f"M {fmt(cx - rx)} {fmt(cy)} A {fmt(rx)} {fmt(ry)} 0 1 0 {fmt(cx + rx)} {fmt(cy)} "
                f"A {fmt(rx)} {fmt(ry)} 0 1 0 {fmt(cx - rx)} {fmt(cy)} Z")
    if tag == "rect":
        x, y, w, h = num(a.get("x")), num(a.get("y")), num(a.get("width")), num(a.get("height"))
        rx = num(a.get("rx", a.get("ry")))
        ry = num(a.get("ry", a.get("rx")))
        rx, ry = min(rx, w / 2), min(ry, h / 2)
        if rx <= 0:
            return f"M {fmt(x)} {fmt(y)} H {fmt(x + w)} V {fmt(y + h)} H {fmt(x)} Z"
        return (f"M {fmt(x + rx)} {fmt(y)} H {fmt(x + w - rx)} A {fmt(rx)} {fmt(ry)} 0 0 1 {fmt(x + w)} {fmt(y + ry)} "
                f"V {fmt(y + h - ry)} A {fmt(rx)} {fmt(ry)} 0 0 1 {fmt(x + w - rx)} {fmt(y + h)} "
                f"H {fmt(x + rx)} A {fmt(rx)} {fmt(ry)} 0 0 1 {fmt(x)} {fmt(y + h - ry)} "
                f"V {fmt(y + ry)} A {fmt(rx)} {fmt(ry)} 0 0 1 {fmt(x + rx)} {fmt(y)} Z")
    if tag == "line":
        return f"M {fmt(num(a['x1']))} {fmt(num(a['y1']))} L {fmt(num(a['x2']))} {fmt(num(a['y2']))}"
    if tag in ("polyline", "polygon"):
        pts = [float(p) for p in re.split(r"[\s,]+", a["points"].strip()) if p]
        pairs = list(zip(pts[0::2], pts[1::2]))
        d = "M " + " L ".join(f"{fmt(px)} {fmt(py)}" for px, py in pairs)
        return d + (" Z" if tag == "polygon" else "")
    raise ValueError(f"unsupported element {tag}")


def from_svg(path: Path) -> list[str]:
    tree = ET.parse(path)
    out = []
    for el in tree.getroot().iter():
        tag = el.tag.split("}")[-1]
        if tag in ("path", "circle", "ellipse", "rect", "line", "polyline", "polygon"):
            out.append(shape_to_path(tag, el.attrib))
    return out


NODE = re.compile(r'\[\s*"(\w+)"\s*,\s*\{([^}]*)\}\s*\]')
ATTR = re.compile(r'(\w+)\s*:\s*"([^"]*)"')


def from_lucide_react(name: str) -> list[str]:
    src = (LUCIDE_REACT / f"{name}.mjs").read_text()
    out = []
    for tag, attrs in NODE.findall(src):
        a = dict(ATTR.findall(attrs))
        a.pop("key", None)
        out.append(shape_to_path(tag, a))
    return out


def vector_xml(name: str, paths: list[str]) -> str:
    body = "\n".join(
        f'    <path\n        android:pathData="{p}"\n        android:strokeColor="#FF000000"\n'
        f'        android:strokeWidth="2"\n        android:strokeLineCap="round"\n        android:strokeLineJoin="round" />'
        for p in paths
    )
    return (f'<?xml version="1.0" encoding="utf-8"?>\n<!-- Lucide "{name}" (ISC). Generated by tools/lucide_to_vector.py. -->\n'
            f'<vector xmlns:android="http://schemas.android.com/apk/res/android"\n    android:width="24dp"\n'
            f'    android:height="24dp"\n    android:viewportWidth="24"\n    android:viewportHeight="24"\n'
            f'    android:autoMirrored="false">\n{body}\n</vector>\n')


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    missing = []
    for name in ICONS:
        svg = DESIGN / f"{name}.svg"
        try:
            paths = from_svg(svg) if svg.exists() else from_lucide_react(name)
        except FileNotFoundError:
            missing.append(name)
            continue
        (OUT / f"ic_lucide_{name.replace('-', '_')}.xml").write_text(vector_xml(name, paths))
    if missing:
        print("missing icons:", ", ".join(missing), file=sys.stderr)
        return 1
    print(f"wrote {len(ICONS)} icons to {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
