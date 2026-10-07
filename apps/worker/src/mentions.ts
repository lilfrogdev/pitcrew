import {
  MENTION_LIMIT,
  mentionTokens,
  validMentionUsername,
  type MessageMention,
} from "@pitcrew/protocol";
import type { CollaborationState } from "./collaboration";
import { AdmissionError } from "./coordinator";

export function validateMentions(
  content: string,
  value: unknown,
  threadId: string,
  state: CollaborationState | undefined,
): MessageMention[] {
  if (value === undefined) return [];
  if (typeof content !== "string" || !Array.isArray(value) || value.length > MENTION_LIMIT)
    throw new AdmissionError("invalid_mentions");
  const tokens = mentionTokens(content);
  const shift = content.length - content.trimStart().length;
  let lastEnd = -1;
  return value.map((item) => {
    if (
      !item ||
      typeof item !== "object" ||
      Object.keys(item).sort().join(",") !== "actor,end,start" ||
      typeof item.actor !== "string" ||
      item.actor.length > 256 ||
      !Number.isSafeInteger(item.start) ||
      !Number.isSafeInteger(item.end) ||
      item.start < lastEnd ||
      item.start < 0 ||
      item.end <= item.start ||
      item.end > content.length
    )
      throw new AdmissionError("invalid_mentions");
    const member = state?.threadMembers[threadId]?.[item.actor];
    const token = tokens.find((token) => token.start === item.start && token.end === item.end);
    if (
      !member ||
      !state?.projectMembers[item.actor] ||
      !validMentionUsername(member.username) ||
      !token ||
      token.username.toLowerCase() !== member.username.toLowerCase()
    )
      throw new AdmissionError("invalid_mentions");
    lastEnd = item.end;
    return {
      actor: member.actor,
      username: member.username,
      start: item.start - shift,
      end: item.end - shift,
    };
  });
}
