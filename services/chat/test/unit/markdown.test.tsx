import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { escapeHtml, hasFormatting, parseInline, parseMessage, safeHref, stripReplyFallback, toHtml, toPlainText } from "../../src/lib/markdown";
import { MessageBody } from "../../src/components/room/MessageBody";

const html = (body: string) => renderToStaticMarkup(<MessageBody body={body} />);

describe("markdown parser", () => {
  it("parses plain text as a paragraph", () => {
    expect(parseMessage("hello world")).toEqual([{ t: "para", c: [{ t: "text", v: "hello world" }] }]);
  });

  it("parses bold, italic and inline code", () => {
    expect(parseInline("a **b** _c_ *d* `e*f*`")).toEqual([
      { t: "text", v: "a " },
      { t: "strong", c: [{ t: "text", v: "b" }] },
      { t: "text", v: " " },
      { t: "em", c: [{ t: "text", v: "c" }] },
      { t: "text", v: " " },
      { t: "em", c: [{ t: "text", v: "d" }] },
      { t: "text", v: " " },
      { t: "code", v: "e*f*" },
    ]);
  });

  it("does not treat snake_case or lone asterisks as emphasis", () => {
    expect(parseInline("my_var_name and 2 * 3 * 4")).toEqual([{ t: "text", v: "my_var_name and 2 * 3 * 4" }]);
  });

  it("parses fenced code blocks (with and without closing fence)", () => {
    expect(parseMessage("before\n```js\nconst a = '<b>';\n```\nafter")).toEqual([
      { t: "para", c: [{ t: "text", v: "before" }] },
      { t: "codeblock", lang: "js", v: "const a = '<b>';" },
      { t: "para", c: [{ t: "text", v: "after" }] },
    ]);
    expect(parseMessage("```\nunterminated **not bold**")).toEqual([{ t: "codeblock", lang: null, v: "unterminated **not bold**" }]);
  });

  it("keeps line breaks inside a paragraph", () => {
    expect(parseInline("a\nb")).toEqual([{ t: "text", v: "a" }, { t: "br" }, { t: "text", v: "b" }]);
  });

  it("linkifies http(s) and www URLs, trimming trailing punctuation", () => {
    expect(parseInline("see https://example.org/a_b?x=1.")).toEqual([
      { t: "text", v: "see " },
      { t: "link", href: "https://example.org/a_b?x=1", v: "https://example.org/a_b?x=1" },
      { t: "text", v: "." },
    ]);
    expect(parseInline("(www.example.org)")).toEqual([
      { t: "text", v: "(" },
      { t: "link", href: "https://www.example.org/", v: "www.example.org" },
      { t: "text", v: ")" },
    ]);
  });

  it("only allows http(s) links", () => {
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("data:text/html,<script>alert(1)</script>")).toBeNull();
    expect(safeHref("https://ok.example/")).toBe("https://ok.example/");
    const nodes = parseInline("javascript:alert(1) vbscript:x data:text/html;base64,PHNjcmlwdD4=");
    expect(nodes.every((n) => n.t !== "link")).toBe(true);
  });

  it("detects formatting", () => {
    expect(hasFormatting(parseMessage("just text https://example.org"))).toBe(false);
    expect(hasFormatting(parseMessage("**bold**"))).toBe(true);
  });

  it("produces plain text for previews", () => {
    expect(toPlainText(parseMessage("Hello **Grace**, `code` _x_"))).toBe("Hello Grace, code x");
  });

  it("strips legacy reply fallbacks", () => {
    expect(stripReplyFallback("> <@a:x> quoted\n> more\n\nactual reply")).toBe("actual reply");
    expect(stripReplyFallback("no fallback")).toBe("no fallback");
  });

  it("caps pathological input without hanging", () => {
    const evil = "*".repeat(50_000) + "_".repeat(50_000) + "`".repeat(10_000);
    const t0 = Date.now();
    parseMessage(evil);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});

describe("safe rendering (XSS)", () => {
  it("renders HTML in message bodies as text", () => {
    const out = html('<script>alert(1)</script><img src=x onerror="alert(2)">');
    expect(out).not.toContain("<script");
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("never renders javascript: links", () => {
    const out = html("[click](javascript:alert(1)) javascript:alert(1)");
    expect(out).not.toMatch(/href="javascript/i);
    expect(out).not.toContain("<a ");
  });

  it("can't break out of href attributes", () => {
    const out = html('https://example.org/"onmouseover="alert(1)');
    expect(out).toContain('<a href="https://example.org/"');
    // The quote ends the URL; the rest stays (escaped) text, never an attribute.
    expect(out).not.toMatch(/<a[^>]*onmouseover/);
    expect(out).toContain("&quot;onmouseover=&quot;alert(1)");
  });

  it("adds safe rel/target to links", () => {
    expect(html("https://matrix.org")).toContain('target="_blank" rel="noopener noreferrer nofollow"');
  });

  it("escapes formatting content", () => {
    const out = html("**<b>x</b>** `<i>`\n```\n<svg onload=alert(1)>\n```");
    expect(out).toContain("<strong>&lt;b&gt;x&lt;/b&gt;</strong>");
    expect(out).toContain("<code>&lt;i&gt;</code>");
    expect(out).toContain("&lt;svg onload=alert(1)&gt;");
    expect(out).not.toContain("<svg");
  });
});

describe("formatted_body HTML (outgoing)", () => {
  it("escapes everything", () => {
    expect(toHtml(parseMessage('**<b>"x"</b>**'))).toBe("<p><strong>&lt;b&gt;&quot;x&quot;&lt;/b&gt;</strong></p>");
    expect(toHtml(parseMessage("https://e.org/?a=1&b=<2>"))).toBe('<p><a href="https://e.org/?a=1&amp;b=">https://e.org/?a=1&amp;b=</a>&lt;2&gt;</p>');
  });
  it("escapes code block languages it doesn't trust", () => {
    expect(toHtml([{ t: "codeblock", lang: 'x" onclick="y', v: "a" }])).toBe("<pre><code>a\n</code></pre>");
  });
  it("escapeHtml covers all special characters", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });
});
