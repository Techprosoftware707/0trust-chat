import { Fragment, useMemo, type ReactNode } from "react";
import { parseMessage, type Block, type Inline } from "../../lib/markdown";

function renderInline(xs: Inline[], keyPrefix: string): ReactNode[] {
  return xs.map((x, i) => {
    const key = `${keyPrefix}${i}`;
    switch (x.t) {
      case "text":
        return <Fragment key={key}>{x.v}</Fragment>;
      case "br":
        return <br key={key} />;
      case "code":
        return <code key={key}>{x.v}</code>;
      case "strong":
        return <strong key={key}>{renderInline(x.c, `${key}.`)}</strong>;
      case "em":
        return <em key={key}>{renderInline(x.c, `${key}.`)}</em>;
      case "link":
        return (
          <a key={key} href={x.href} target="_blank" rel="noopener noreferrer nofollow">
            {x.v}
          </a>
        );
    }
  });
}

export function renderBlocks(blocks: Block[]): ReactNode {
  return blocks.map((b, i) =>
    b.t === "codeblock" ? (
      <pre key={i} className="msg-code">
        <code data-lang={b.lang ?? undefined}>{b.v}</code>
      </pre>
    ) : (
      <p key={i}>{renderInline(b.c, `${i}:`)}</p>
    ),
  );
}

/**
 * Renders a message body as React elements. The input is untrusted text:
 * it is never interpreted as HTML (no dangerouslySetInnerHTML anywhere).
 */
export function MessageBody({ body, className = "msg-body" }: { body: string; className?: string }) {
  const blocks = useMemo(() => parseMessage(body), [body]);
  return <div className={className}>{renderBlocks(blocks)}</div>;
}
