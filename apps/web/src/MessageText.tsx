import { type ReactNode } from "react";

function inline(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let key = 0;
  for (const match of text.matchAll(pattern)) {
    const token = match[0];
    const index = match.index ?? 0;
    if (index > last) parts.push(text.slice(last, index));
    if (token.startsWith("**"))
      parts.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    else parts.push(<code key={key}>{token.slice(1, -1)}</code>);
    key += 1;
    last = index + token.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

function blocks(content: string): ReactNode[] {
  const chunks: ReactNode[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];
  let key = 0;
  const flushParagraph = () => {
    if (!paragraph.length) return;
    chunks.push(<p key={`p-${key}`}>{inline(paragraph.join("\n"))}</p>);
    key += 1;
    paragraph = [];
  };
  const flushList = () => {
    if (!list.length) return;
    chunks.push(
      <ul key={`l-${key}`}>
        {list.map((line, item) => (
          <li key={item}>{inline(line.replace(/^[-*] /, ""))}</li>
        ))}
      </ul>,
    );
    key += 1;
    list = [];
  };
  for (const line of content.replace(/\r\n/g, "\n").split("\n")) {
    if (/^[-*] /.test(line.trim())) {
      flushParagraph();
      list.push(line.trim());
    } else if (!line.trim()) {
      flushParagraph();
      flushList();
    } else {
      flushList();
      paragraph.push(line);
    }
  }
  flushParagraph();
  flushList();
  return chunks;
}

export function MessageText({ content }: { content: string }) {
  return <div className="message-copy">{blocks(content)}</div>;
}
