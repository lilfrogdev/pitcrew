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
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
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
export function rebaseMentions(before: string, after: string, mentions: SubmittedMention[]) {
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
