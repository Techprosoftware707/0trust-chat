#!/usr/bin/env python3
"""WCAG 2.2 contrast of the Nexus brand's colour pairs, light and dark.

    python3 tests/nexus/brand_contrast.py            # table; exit 1 if any pair fails
    python3 tests/nexus/brand_contrast.py --markdown # the same as a Markdown table

Colours come from design/tokens.css overridden by branding/theme.css (resolving var()),
plus the literal colours of services/chat/src/styles/workspace.css (tags, rail badge,
avatars) and the gradient stops behind .btn-gradient labels. Translucent "soft" fills are
composited over the surface they sit on. Every pair is text at body size, so the bar is
4.5:1 (AA, 1.4.3); focus rings and non-text UI need 3:1 (1.4.11) and are listed as such.
No dependencies.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
DECL = re.compile(r"--([a-z0-9-]+)\s*:\s*([^;]+);")


def strip_comments(css: str) -> str:
    return re.sub(r"/\*.*?\*/", "", css, flags=re.S)


def block(css: str, selector: str) -> dict[str, str]:
    """Declarations of the first rule whose selector is exactly ``selector`` (outside @media)."""
    css = strip_comments(css)
    depth = 0
    i = 0
    while i < len(css):
        if css.startswith("@media", i) and depth == 0:
            # skip the whole @media block
            j = css.index("{", i)
            d = 0
            for k in range(j, len(css)):
                d += css[k] == "{"
                d -= css[k] == "}"
                if d == 0:
                    i = k + 1
                    break
            continue
        j = css.find("{", i)
        if j < 0:
            break
        sel = css[i:j].strip().split("}")[-1].strip()
        end = css.index("}", j)
        if sel == selector:
            return {m.group(1): m.group(2).strip() for m in DECL.finditer(css[j:end])}
        i = end + 1
    return {}


def resolve(name: str, env: dict[str, str], seen=()) -> str:
    value = env[name]
    m = re.fullmatch(r"var\(--([a-z0-9-]+)\)", value)
    if m:
        if m.group(1) in seen:
            raise ValueError(f"cycle at {name}")
        return resolve(m.group(1), env, (*seen, name))
    return value


def rgba(value: str) -> tuple[float, float, float, float]:
    value = value.strip()
    if value.startswith("#") and len(value) == 7:
        return int(value[1:3], 16), int(value[3:5], 16), int(value[5:7], 16), 1.0
    m = re.fullmatch(r"rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([0-9.]+))?\s*\)", value)
    if m:
        return int(m.group(1)), int(m.group(2)), int(m.group(3)), float(m.group(4) or 1)
    raise ValueError(f"not a colour: {value}")


def over(fg, bg):
    r, g, b, a = fg
    br, bgc, bb, _ = bg
    return (r * a + br * (1 - a), g * a + bgc * (1 - a), b * a + bb * (1 - a), 1.0)


def luminance(c) -> float:
    def ch(v):
        v /= 255
        return v / 12.92 if v <= 0.03928 else ((v + 0.055) / 1.055) ** 2.4

    r, g, b, _ = c
    return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b)


def ratio(fg, bg) -> float:
    fg = over(fg, bg) if fg[3] < 1 else fg
    l1, l2 = sorted([luminance(fg), luminance(bg)], reverse=True)
    return (l1 + 0.05) / (l2 + 0.05)


def themes() -> dict[str, dict[str, str]]:
    tokens = (REPO / "design/tokens.css").read_text(encoding="utf-8")
    brand = (REPO / "branding/theme.css").read_text(encoding="utf-8")
    light = {**block(tokens, ":root"), **block(brand, ":root")}
    dark = {**light, **block(tokens, ':root[data-theme="dark"]'), **block(brand, ':root[data-theme="dark"]')}
    return {"light": light, "dark": dark}


def workspace_tags() -> dict[str, dict[str, tuple[str, str]]]:
    css = strip_comments((REPO / "services/chat/src/styles/workspace.css").read_text(encoding="utf-8"))
    out: dict[str, dict[str, tuple[str, str]]] = {"light": {}, "dark": {}}
    # Top-level rules only (the @media copy of the dark rules is indented and skipped).
    for m in re.finditer(r"^(:root\[data-theme=\"dark\"\] )?\.ws-tag-([a-z]+) \{ --tag-fg: (#[0-9a-f]{6}); --tag-bg: (#[0-9a-f]{6}); \}", css, re.M):
        out["dark" if m.group(1) else "light"][m.group(2)] = (m.group(3), m.group(4))
    return out


def pairs(theme: str, env: dict[str, str]):
    c = lambda n: rgba(resolve(n, env))  # noqa: E731
    surface, bg, s2, elevated = c("surface"), c("bg"), c("surface-2"), c("bg-elevated")
    text = [
        ("text on bg", c("text"), bg),
        ("text on surface", c("text"), surface),
        ("text on surface-2", c("text"), s2),
        ("text-muted on bg", c("text-muted"), bg),
        ("text-muted on surface", c("text-muted"), surface),
        ("text-muted on surface-2", c("text-muted"), s2),
        ("text-subtle on bg", c("text-subtle"), bg),
        ("text-subtle on surface", c("text-subtle"), surface),
        ("text-subtle on surface-2", c("text-subtle"), s2),
        ("accent (links) on bg", c("accent"), bg),
        ("accent (links) on surface", c("accent"), surface),
        ("accent on accent-soft (active item, badge)", c("accent"), over(c("accent-soft"), surface)),
        ("accent-contrast on accent (primary button)", c("accent-contrast"), c("accent")),
        ("accent-contrast on accent-hover", c("accent-contrast"), c("accent-hover")),
        ("success on success-soft (badge)", c("success"), over(c("success-soft"), surface)),
        ("warning on warning-soft (badge)", c("warning"), over(c("warning-soft"), surface)),
        ("danger on surface (overdue)", c("danger"), surface),
        ("danger on danger-soft (alert)", c("text"), over(c("danger-soft"), bg)),
        ("info on info-soft (Demo badge)", c("info"), over(c("info-soft"), surface)),
        ("text-inverse on surface-inverse", c("text-inverse"), c("surface-inverse")),
        ("env banner text", c("nexus-env-fg"), c("nexus-env-bg")),
        ("rail label", c("nexus-rail-fg"), c("nexus-rail-bg")),
        ("rail active label", c("nexus-rail-active-fg"), c("nexus-rail-active-bg")),
        ("rail badge", rgba("#0a1430"), rgba("#e7efff")),
        ("avatar initials (gradient start)", rgba("#ffffff"), rgba("#2563eb")),
        ("avatar initials (gradient end)", rgba("#ffffff"), rgba("#1e3a8a")),
        ("text on elevated (forms, lists)", c("text"), elevated),
    ]
    if theme == "light":
        for stop in ("#a9cfff", "#6ea8ff", "#4a8dfa"):
            text.append((f".btn-gradient label on {stop}", rgba("#04111f"), rgba(stop)))
    for name, (fg, tag_bg) in workspace_tags()[theme].items():
        text.append((f"tag {name}", rgba(fg), rgba(tag_bg)))
    ui = [
        ("focus ring vs bg (non-text, 3:1)", c("accent"), bg),
        ("bar fill vs track (non-text, 3:1)", c("accent"), s2),
        ("input/button border vs surface (non-text, 3:1)", c("border-strong"), surface),
        ("input/button border vs bg (non-text, 3:1)", c("border-strong"), bg),
    ]
    return text, ui


def dark_copies_match() -> list[str]:
    """theme.css repeats the dark tokens for prefers-color-scheme; both copies must agree."""
    css = strip_comments((REPO / "branding/theme.css").read_text(encoding="utf-8"))
    explicit = block(css, ':root[data-theme="dark"]')
    m = re.search(r"@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme=\"light\"\]\) \{(.*?)\}\s*\}", css, re.S)
    media = {d.group(1): d.group(2).strip() for d in DECL.finditer(m.group(1))} if m else {}
    return sorted(k for k in set(explicit) | set(media) if explicit.get(k) != media.get(k))


def main() -> int:
    markdown = "--markdown" in sys.argv
    failed = 0
    rows = []
    drift = dark_copies_match()
    if drift:
        print(f"FAIL  dark tokens differ between the two copies in branding/theme.css: {', '.join(drift)}")
        failed += 1
    for theme, env in themes().items():
        text, ui = pairs(theme, env)
        for label, fg, bg in text:
            r = ratio(fg, bg)
            ok = r >= 4.5
            failed += not ok
            rows.append((theme, label, r, "4.5", ok))
        for label, fg, bg in ui:
            r = ratio(fg, bg)
            ok = r >= 3.0
            failed += not ok
            rows.append((theme, label, r, "3.0", ok))
    if markdown:
        print("| Theme | Pair | Contrast | Needs | Result |\n|---|---|---|---|---|")
        for theme, label, r, need, ok in rows:
            print(f"| {theme} | {label} | {r:.2f}:1 | {need}:1 | {'pass' if ok else 'FAIL'} |")
    else:
        for theme, label, r, need, ok in rows:
            print(f"{'PASS' if ok else 'FAIL'}  {theme:5}  {r:5.2f}:1 (>= {need})  {label}")
        print(f"\n{len(rows)} pairs, {failed} failing")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
