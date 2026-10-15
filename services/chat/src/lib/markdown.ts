/**
 * A deliberately tiny, safe message-formatting subset:
 *   **bold** / __bold__, *italic* / _italic_, `inline code`, ``` code blocks ```,
 *   and linkified http(s) URLs.
 *
 * The parser produces a plain data structure (never HTML). The UI turns it into
 * React elements (text is always escaped by React), and `toHtml` produces the
 * optional `formatted_body` for other Matrix clients with every piece of text
 * HTML-escaped. Nothing here ever interprets HTML coming from other users.
 */

export type Inline =
  | { t: "text"; v: string }
  | { t: "code"; v: string }
  | { t: "strong"; c: Inline[] }
  | { t: "em"; c: Inline[] }
  | { t: "link"; href: string; v: string }
  | { t: "br" };

export type Block = { t: "para"; c: Inline[] } | { t: "codeblock"; lang: string | null; v: string };

const MAX_DEPTH = 3;
const MAX_INPUT = 64 * 1024;

// ---------------------------------------------------------------------------
// Links

const URL_START = /(https?:\/\/|www\.)/iy;
const URL_BODY = /[^\s<>"`]+/y;
const TRAILING_PUNCT = /[.,:;!?'"*_~]+$/;

/** Returns a safe absolute http(s) URL for `raw`, or null. */
export function safeHref(raw: string): string | null {
  const candidate = /^www\./i.test(raw) ? `https://${raw}` : raw;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!url.hostname) return null;
  return url.href;
}

function trimUrl(raw: string): string {
  let s = raw.replace(TRAILING_PUNCT, "");
  // Drop unbalanced closing parentheses: "(see https://x.org/a)" -> "https://x.org/a"
  while (s.endsWith(")")) {
    const opens = (s.match(/\(/g) || []).length;
    const closes = (s.match(/\)/g) || []).length;
    if (closes <= opens) break;
    s = s.slice(0, -1).replace(TRAILING_PUNCT, "");
  }
  return s;
}

/** If a URL starts at `i`, returns its text and safe href. */
export function matchUrlAt(s: string, i: number): { text: string; href: string } | null {
  if (i > 0 && /[\p{L}\p{N}_@/.:-]/u.test(s[i - 1])) return null; // must start at a word boundary
  URL_START.lastIndex = i;
  const start = URL_START.exec(s);
  if (!start) return null;
  URL_BODY.lastIndex = i;
  const body = URL_BODY.exec(s);
  if (!body) return null;
  const text = trimUrl(body[0]);
  if (text.length <= start[0].length) return null;
  const href = safeHref(text);
  return href ? { text, href } : null;
}

// ---------------------------------------------------------------------------
// Inline parsing

const isSpace = (c: string | undefined) => c === undefined || /\s/.test(c);
const isWordChar = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}]/u.test(c);

function canOpen(s: string, i: number, delim: string): boolean {
  const after = s[i + delim.length];
  if (isSpace(after)) return false;
  if (delim[0] === "_" && isWordChar(s[i - 1])) return false; // snake_case is not emphasis
  return true;
}

function findClose(s: string, from: number, delim: string): number {
  for (let j = from; j <= s.length - delim.length; j++) {
    const c = s[j];
    if (c === "\n") return -1; // emphasis never spans lines
    if (c === "`") {
      // skip over code spans: their content is literal
      const end = s.indexOf("`", j + 1);
      if (end > j) {
        j = end;
        continue;
      }
    }
    if (s.startsWith(delim, j)) {
      if (j === from) continue; // empty emphasis
      if (isSpace(s[j - 1])) continue;
      if (delim.length === 1 && s[j + 1] === delim) {
        j++; // part of a double delimiter: skip both
        continue;
      }
      if (delim[0] === "_" && isWordChar(s[j + delim.length])) continue;
      return j;
    }
  }
  return -1;
}

export function parseInline(s: string, depth = 0): Inline[] {
  const out: Inline[] = [];
  let text = "";
  const flush = () => {
    if (text) out.push({ t: "text", v: text });
    text = "";
  };
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "\n") {
      flush();
      out.push({ t: "br" });
      i++;
      continue;
    }
    if (c === "`") {
      const end = s.indexOf("`", i + 1);
      if (end > i + 1 && !s.slice(i + 1, end).includes("\n")) {
        flush();
        out.push({ t: "code", v: s.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if (c === "h" || c === "H" || c === "w" || c === "W") {
      const m = matchUrlAt(s, i);
      if (m) {
        flush();
        out.push({ t: "link", href: m.href, v: m.text });
        i += m.text.length;
        continue;
      }
    }
    if ((c === "*" || c === "_") && depth < MAX_DEPTH) {
      const delim = s[i + 1] === c ? c + c : c;
      if (canOpen(s, i, delim)) {
        const close = findClose(s, i + delim.length, delim);
        if (close > 0) {
          flush();
          const inner = parseInline(s.slice(i + delim.length, close), depth + 1);
          out.push(delim.length === 2 ? { t: "strong", c: inner } : { t: "em", c: inner });
          i = close + delim.length;
          continue;
        }
      }
      // Not emphasis: consume the whole delimiter run literally.
      text += delim;
      i += delim.length;
      continue;
    }
    text += c;
    i++;
  }
  flush();
  return out;
}

// ---------------------------------------------------------------------------
// Blocks

const FENCE = /^```([A-Za-z0-9_+.#-]{0,32})[ \t]*$/;

export function parseMessage(input: string): Block[] {
  const src = input.length > MAX_INPUT ? input.slice(0, MAX_INPUT) : input;
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];
  const flushPara = () => {
    // Trim blank lines at the edges of a paragraph, keep the inner ones.
    while (para.length && para[0].trim() === "") para.shift();
    while (para.length && para[para.length - 1].trim() === "") para.pop();
    if (para.length) blocks.push({ t: "para", c: parseInline(para.join("\n")) });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const fence = FENCE.exec(lines[i]);
    if (fence) {
      // Find the closing fence; an unterminated fence runs to the end of the message.
      let j = i + 1;
      while (j < lines.length && lines[j].trim() !== "```") j++;
      flushPara();
      blocks.push({ t: "codeblock", lang: fence[1] ? fence[1].toLowerCase() : null, v: lines.slice(i + 1, j).join("\n") });
      i = j;
      continue;
    }
    para.push(lines[i]);
  }
  flushPara();
  return blocks;
}

/** True if the message uses formatting beyond plain text and links. */
export function hasFormatting(blocks: Block[]): boolean {
  const inlineHas = (xs: Inline[]): boolean => xs.some((x) => x.t === "code" || x.t === "strong" || x.t === "em");
  return blocks.some((b) => b.t === "codeblock" || inlineHas(b.c));
}

// ---------------------------------------------------------------------------
// HTML serialisation for `formatted_body` (outgoing only)

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

function inlineToHtml(xs: Inline[]): string {
  return xs
    .map((x) => {
      switch (x.t) {
        case "text":
          return escapeHtml(x.v);
        case "br":
          return "<br>";
        case "code":
          return `<code>${escapeHtml(x.v)}</code>`;
        case "strong":
          return `<strong>${inlineToHtml(x.c)}</strong>`;
        case "em":
          return `<em>${inlineToHtml(x.c)}</em>`;
        case "link":
          return `<a href="${escapeHtml(x.href)}">${escapeHtml(x.v)}</a>`;
      }
    })
    .join("");
}

export function toHtml(blocks: Block[]): string {
  return blocks
    .map((b) => {
      if (b.t === "codeblock") {
        const cls = b.lang && /^[a-z0-9_+-]+$/.test(b.lang) ? ` class="language-${b.lang}"` : "";
        return `<pre><code${cls}>${escapeHtml(b.v)}\n</code></pre>`;
      }
      return `<p>${inlineToHtml(b.c)}</p>`;
    })
    .join("");
}

/** Plain-text rendering of the parsed message (used for previews and notifications). */
export function toPlainText(blocks: Block[]): string {
  const inline = (xs: Inline[]): string =>
    xs.map((x) => (x.t === "br" ? "\n" : x.t === "strong" || x.t === "em" ? inline(x.c) : x.v)).join("");
  return blocks.map((b) => (b.t === "codeblock" ? b.v : inline(b.c))).join("\n");
}

/**
 * Removes a legacy reply fallback ("> <@alice:x> quoted text" lines followed by
 * a blank line) from the start of a reply's body. Only call this for events
 * that really are replies (have m.in_reply_to).
 */
export function stripReplyFallback(body: string): string {
  const lines = body.split("\n");
  if (!lines.length || !lines[0].startsWith(">")) return body;
  let i = 0;
  while (i < lines.length && lines[i].startsWith(">")) i++;
  if (i < lines.length && lines[i] === "") i++;
  return lines.slice(i).join("\n");
}
