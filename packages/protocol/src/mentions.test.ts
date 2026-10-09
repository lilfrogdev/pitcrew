import { expect, it } from "vite-plus/test";
import {
  mentionTokens,
  mentionQuery,
  rebaseMentions,
  agentMentionTokens,
  validAgentMentions,
} from "./mentions";

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

it("reserved agent selections reject quotes, lazy markdown quote continuations and literal tokens", () => {
  for (const text of [
    "\\@agent",
    "`@agent`",
    "```\n@agent\n```",
    "    @agent",
    "- ~~~\n  @agent\n  ~~~",
    "1. ~~~\n   @agent\n   ~~~",
    "> quoted\n@agent",
    "- > @agent",
    '"quoted @agent"',
    "'quoted @agent'",
    "“quoted @agent”",
    '"multiline\n@agent\nquote"',
    "@agentx",
    "@Agent",
    "name@agent",
    "https://x/@agent",
  ]) {
    const start = text.indexOf("@agent");
    expect(agentMentionTokens(text), text).toEqual([]);
    expect(validAgentMentions(text, [{ start, end: start + 6 }]), text).toBe(false);
  }
  const text = "> quoted\n@agent\n\nhello @agent and @agent";
  const tokens = agentMentionTokens(text);
  expect(tokens.map((token) => text.slice(token.start, token.end))).toEqual(["@agent", "@agent"]);
  const refs = tokens.map(({ start, end }) => ({ start, end }));
  expect(validAgentMentions(text, refs)).toBe(true);
  expect(validAgentMentions(text, [refs[0], refs[0]])).toBe(false);
  expect(validAgentMentions(text, [{ ...refs[0], actor: "agent" }])).toBe(false);
  expect(rebaseMentions("@agent", "hello @agent", [{ start: 0, end: 6 }])).toEqual([
    { start: 6, end: 12 },
  ]);
});
