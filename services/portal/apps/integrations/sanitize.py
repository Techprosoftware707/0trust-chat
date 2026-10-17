"""Email bodies are untrusted: an allowlist HTML sanitizer and an HTML-to-text converter.

The sanitizer keeps a small set of formatting tags, drops everything that can run code, load
remote content or style the page (script, style, iframe, object, form, svg, event handlers,
style attributes, CSS), removes every image (no remote images: tracking pixels never load)
and rewrites links to open in a new tab without a referrer. The SPA additionally renders the
result inside a sandboxed iframe with a ``default-src 'none'`` policy, so even a sanitizer
gap could not run script or fetch anything. Text-only display is the default.
"""

from __future__ import annotations

import html
import re
from html.parser import HTMLParser

ALLOWED = {
    "a", "b", "strong", "i", "em", "u", "s", "p", "br", "div", "span", "ul", "ol", "li", "blockquote", "pre", "code",
    "h1", "h2", "h3", "h4", "h5", "h6", "table", "thead", "tbody", "tfoot", "tr", "td", "th", "hr", "small", "sub", "sup",
}
VOID = {"br", "hr"}
DROP_CONTENT = {"script", "style", "head", "title", "iframe", "object", "embed", "noscript", "template", "svg", "math",
                "form", "textarea", "select", "button", "canvas", "audio", "video", "applet", "frameset", "frame", "xml"}
BLOCK = {"p", "div", "br", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "hr", "table", "ul", "ol"}
SAFE_SCHEMES = ("http://", "https://", "mailto:")
_WS = re.compile(r"[ \t\r\f\v\u00a0]+")
_NL = re.compile(r"\n{3,}")


def _safe_href(value: str) -> str | None:
    v = html.unescape(value or "").strip()
    # Browsers ignore control characters and whitespace inside schemes ("java\tscript:").
    compact = re.sub(r"[\x00-\x20]", "", v).lower()
    if compact.startswith(SAFE_SCHEMES):
        return v
    return None


class _Sanitizer(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.out: list[str] = []
        self.stack: list[str] = []
        self.skip = 0
        self.images_blocked = 0

    def handle_starttag(self, tag, attrs):
        tag = tag.lower()
        if self.skip:
            if tag in DROP_CONTENT:
                self.skip += 1
            return
        if tag in DROP_CONTENT:
            self.skip = 1
            return
        if tag == "img":
            self.images_blocked += 1
            alt = next((v for k, v in attrs if k.lower() == "alt" and v), "")
            self.out.append(f"<span class=\"blocked-image\">[image{': ' + html.escape(alt[:80]) if alt else ''}]</span>")
            return
        if tag not in ALLOWED:
            return
        rendered = [tag]
        if tag == "a":
            href = next((v for k, v in attrs if k.lower() == "href"), None)
            safe = _safe_href(href) if href else None
            if safe:
                rendered.append(f'href="{html.escape(safe, quote=True)}"')
                rendered.append('target="_blank" rel="noopener noreferrer nofollow"')
        elif tag in {"td", "th"}:
            for k, v in attrs:
                if k.lower() in {"colspan", "rowspan"} and v and v.isdigit() and int(v) < 100:
                    rendered.append(f'{k.lower()}="{v}"')
        self.out.append("<" + " ".join(rendered) + ">")
        if tag not in VOID:
            self.stack.append(tag)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        tag = tag.lower()
        if tag in ALLOWED and tag not in VOID and self.stack and self.stack[-1] == tag:
            self.stack.pop()
            self.out.append(f"</{tag}>")

    def handle_endtag(self, tag):
        tag = tag.lower()
        if self.skip:
            if tag in DROP_CONTENT:
                self.skip -= 1
            return
        if tag not in ALLOWED or tag in VOID or tag not in self.stack:
            return
        while self.stack:
            open_tag = self.stack.pop()
            self.out.append(f"</{open_tag}>")
            if open_tag == tag:
                break

    def handle_data(self, data):
        if not self.skip:
            self.out.append(html.escape(data, quote=False))

    def close(self):
        super().close()
        while self.stack:
            self.out.append(f"</{self.stack.pop()}>")


def sanitize_html(raw: str, *, max_length: int = 500_000) -> tuple[str, int]:
    """Returns (safe HTML, number of images removed)."""
    parser = _Sanitizer()
    parser.feed((raw or "")[:max_length])
    parser.close()
    return "".join(parser.out), parser.images_blocked


class _Text(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.skip = 0
        self.href: str | None = None

    def handle_starttag(self, tag, attrs):
        tag = tag.lower()
        if tag in DROP_CONTENT:
            self.skip += 1
        elif tag in BLOCK:
            self.parts.append("\n")
        if tag == "li" and not self.skip:
            self.parts.append("• ")
        if tag == "a":
            self.href = next((v for k, v in attrs if k.lower() == "href"), None)

    def handle_endtag(self, tag):
        tag = tag.lower()
        if tag in DROP_CONTENT and self.skip:
            self.skip -= 1
        elif tag in BLOCK:
            self.parts.append("\n")
        if tag == "a" and self.href and not self.skip:
            safe = _safe_href(self.href)
            if safe and safe.startswith(("http://", "https://")):
                self.parts.append(f" ({safe})")
            self.href = None

    def handle_data(self, data):
        if not self.skip:
            self.parts.append(data)


def html_to_text(raw: str, *, max_length: int = 500_000) -> str:
    parser = _Text()
    parser.feed((raw or "")[:max_length])
    parser.close()
    return normalize_text("".join(parser.parts))


def normalize_text(text: str) -> str:
    text = (text or "").replace("\r\n", "\n").replace("\r", "\n").replace("\x00", "")
    lines = [_WS.sub(" ", line).strip() for line in text.split("\n")]
    return _NL.sub("\n\n", "\n".join(lines)).strip()
