/** UTF-16 offsets into the message text, matching textarea selection offsets. */
export interface SubmittedMention {
  actor: string;
  start: number;
  end: number;
}
export interface MessageMention extends SubmittedMention {
  /** Verified username snapshot; actor remains the identity after a rename. */
  username: string;
}
export const MENTION_LIMIT = 32;
export const validMentionUsername = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9_]{3,32}$/.test(value);

/** Conservative plain-text tokens: code, escapes, emails and URL segments stay literal. */
export function mentionTokens(text: string) {
  const blocked = new Uint8Array(text.length);
  let fence: { char: string; length: number } | undefined;
  let offset = 0;
  for (const line of text.split(/(?<=\n)/)) {
    const marker = /^ {0,3}(?:(?:[-+*]|\d+[.)])\s+)?(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence || marker || /^( {4}|\t)/.test(line)) {
      blocked.fill(1, offset, offset + line.length);
      if (fence) {
        if (
          marker?.[0] === fence.char &&
          marker.length >= fence.length &&
          /^ {0,3}(`+|~+)\s*$/.test(line)
        )
          fence = undefined;
      } else if (marker) fence = { char: marker[0], length: marker.length };
    }
    offset += line.length;
  }
  for (let i = 0; i < text.length; i++) {
    if (blocked[i] || text[i] !== "`") continue;
    let end = i + 1;
    while (text[end] === "`") end++;
    const marker = text.slice(i, end);
    let close = text.indexOf(marker, end);
    while (close >= 0 && (text[close - 1] === "`" || text[close + marker.length] === "`"))
      close = text.indexOf(marker, close + marker.length);
    const limit = close < 0 ? text.length : close + marker.length;
    blocked.fill(1, i, limit);
    i = limit - 1;
  }
  const tokens: { start: number; end: number; username: string }[] = [];
  for (const match of text.matchAll(/@[a-zA-Z0-9_]*/g)) {
    const start = match.index;
    const end = start + match[0].length;
    if (
      blocked.subarray(start, end).some(Boolean) ||
      (start > 0 && !/[\s([{]/.test(text[start - 1])) ||
      match[0].length > 33
    )
      continue;
    tokens.push({ start, end, username: match[0].slice(1) });
  }
  return tokens;
}

export function mentionQuery(text: string, caret: number) {
  return mentionTokens(text).find((token) => token.start < caret && token.end >= caret);
}

/** Retain only untouched selected tokens; arbitrary edits cannot silently retarget a ping. */
export function rebaseMentions<T extends { start: number; end: number }>(
  before: string,
  after: string,
  mentions: T[],
) {
  if (before === after) return mentions;
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let oldEnd = before.length,
    newEnd = after.length;
  while (oldEnd > start && newEnd > start && before[oldEnd - 1] === after[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }
  const delta = newEnd - oldEnd;
  const tokens = mentionTokens(after);
  return mentions.flatMap((mention) => {
    const next =
      mention.end <= start
        ? mention
        : mention.start >= oldEnd
          ? { ...mention, start: mention.start + delta, end: mention.end + delta }
          : undefined;
    return next &&
      tokens.some(
        (token) =>
          token.start === next.start &&
          token.end === next.end &&
          after.slice(next.start, next.end) === before.slice(mention.start, mention.end),
      )
      ? [next]
      : [];
  });
}

/** Reserved invocation tokens exclude quotations as well as code and escapes. */
export function agentMentionTokens(text: string) {
  const quoted = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const closeCharacter = ({ '"': '"', "'": "'", "“": "”", "‘": "’" } as Record<string, string>)[
      text[i]
    ];
    if (!closeCharacter || (text[i] === "'" && i > 0 && /[a-zA-Z0-9]/.test(text[i - 1]))) continue;
    const close = text.indexOf(closeCharacter, i + 1);
    const limit = close < 0 ? text.length : close + 1;
    quoted.fill(1, i, limit);
    i = limit - 1;
  }
  let offset = 0,
    blockquote = false;
  for (const line of text.split(/(?<=\n)/)) {
    if (!line.trim()) blockquote = false;
    if (/^(?:\s*(?:[-+*]|\d+[.)])\s+)?\s*>/.test(line)) blockquote = true;
    // Markdown allows lazy continuation lines until the paragraph ends.
    if (blockquote) quoted.fill(1, offset, offset + line.length);
    offset += line.length;
  }
  return mentionTokens(text).filter(
    (token) =>
      text.slice(token.start, token.end) === "@agent" &&
      !quoted.subarray(token.start, token.end).some(Boolean),
  );
}
export function validAgentMentions(
  text: string,
  value: unknown,
): value is import("./index.ts").AgentMention[] {
  if (!Array.isArray(value) || value.length > MENTION_LIMIT) return false;
  const tokens = agentMentionTokens(text);
  let lastEnd = -1;
  return value.every((item) => {
    if (
      !item ||
      typeof item !== "object" ||
      Object.keys(item).sort().join(",") !== "end,start" ||
      !Number.isSafeInteger(item.start) ||
      !Number.isSafeInteger(item.end) ||
      item.start < lastEnd ||
      !tokens.some((token) => token.start === item.start && token.end === item.end)
    )
      return false;
    lastEnd = item.end;
    return true;
  });
}
