import { expect, it } from "vite-plus/test";
import { mentionTokens, mentionQuery, rebaseMentions } from "./mentions";

it("excludes fenced, inline, indented, escaped, email and URL text while preserving offsets", () => {
  const text =
    "😀 @JohnCENA, (@alice) \\@escaped name@domain https://x/@path\n```ts\n@code\n```\n`@inline`\n~~~\n@tilde\n~~~\n    @indent\n@last";
  expect(mentionTokens(text).map((token) => text.slice(token.start, token.end))).toEqual([
    "@JohnCENA",
    "@alice",
    "@last",
  ]);
  expect(mentionQuery("before @john tail", 10)).toEqual({ start: 7, end: 12, username: "john" });
  expect(mentionQuery("\\@john", 4)).toBeUndefined();
  expect(mentionQuery("`@john", 5)).toBeUndefined();
  expect(mentionQuery("@", 1)?.username).toBe("");
});
it("rebases unchanged tokens across edits and drops edited or newly escaped/code tokens", () => {
  const reference = { actor: "account:john", start: 4, end: 9 };
  expect(rebaseMentions("hey @john", "😀 hey @john", [reference])).toEqual([
    { ...reference, start: 7, end: 12 },
  ]);
  expect(rebaseMentions("hey @john", "hey @joan", [reference])).toEqual([]);
  expect(rebaseMentions("hey @john", "hey @johncena", [reference])).toEqual([]);
  expect(rebaseMentions("hey @john", "hey \\@john", [reference])).toEqual([]);
  expect(rebaseMentions("hey @john", "`hey @john`", [reference])).toEqual([]);
});
