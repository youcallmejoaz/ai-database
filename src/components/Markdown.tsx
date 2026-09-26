import { Fragment, type ReactNode } from "react";

/**
 * A deliberately small Markdown renderer for chat replies: paragraphs, bullet
 * and numbered lists, headings, **bold**, `code` and fenced code blocks. It
 * builds React elements (never HTML strings), so model output cannot inject markup.
 */

function inline(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > last) parts.push(text.slice(last, index));
    const token = match[0];
    parts.push(
      token.startsWith("`") ? <code key={index}>{token.slice(1, -1)}</code> : <strong key={index}>{token.slice(2, -2)}</strong>,
    );
    last = index + token.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

export function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("```")) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) code.push(lines[i++]);
      i++;
      blocks.push(<pre key={blocks.length}><code>{code.join("\n")}</code></pre>);
      continue;
    }
    const heading = /^#{1,4}\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push(<p key={blocks.length} className="md-heading">{inline(heading[1])}</p>);
      i++;
      continue;
    }
    const listItem = /^\s*(?:[-*]|\d+\.)\s+/;
    if (listItem.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: string[] = [];
      while (i < lines.length && listItem.test(lines[i])) items.push(lines[i++].replace(listItem, ""));
      const List = ordered ? "ol" : "ul";
      blocks.push(
        <List key={blocks.length}>
          {items.map((item, n) => (
            <li key={n}>{inline(item)}</li>
          ))}
        </List>,
      );
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const paragraph: string[] = [];
    while (i < lines.length && lines[i].trim() && !lines[i].startsWith("```") && !listItem.test(lines[i]) && !/^#{1,4}\s/.test(lines[i])) {
      paragraph.push(lines[i++]);
    }
    blocks.push(
      <p key={blocks.length}>
        {paragraph.map((p, n) => (
          <Fragment key={n}>
            {n > 0 && <br />}
            {inline(p)}
          </Fragment>
        ))}
      </p>,
    );
  }
  return <div className="md">{blocks}</div>;
}
