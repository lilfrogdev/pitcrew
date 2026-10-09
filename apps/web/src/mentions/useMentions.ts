import { useEffect, useRef, useState } from "react";
import {
  agentMentionTokens,
  rebaseMentions,
  validMentionUsername,
  type SubmittedMention,
  type AgentMention,
} from "@pitcrew/protocol";
import type { CollaborationApi, Member } from "../api";

export function useMentionMembers(
  api: CollaborationApi | undefined,
  threadId: string,
  enabled: boolean,
  account?: string,
) {
  const [roster, setRoster] = useState<{
    api?: CollaborationApi;
    account?: string;
    threadId: string;
    members: Member[];
  }>();
  useEffect(() => {
    if (!api || !threadId || !enabled) return;
    let active = true,
      reading = false;
    const read = async () => {
      if (reading) return;
      reading = true;
      try {
        const members = await api.threadMembers(threadId);
        if (active)
          setRoster({
            api,
            account,
            threadId,
            members: members.filter((member) => validMentionUsername(member.username)),
          });
      } catch {
        if (active) setRoster({ api, account, threadId, members: [] });
      } finally {
        reading = false;
      }
    };
    void read();
    const timer = setInterval(() => void read(), 6000);
    const refresh = () => void read();
    window.addEventListener("focus", refresh);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [api, threadId, enabled, account]);
  return enabled &&
    roster &&
    roster.api === api &&
    roster.account === account &&
    roster.threadId === threadId
    ? roster.members
    : [];
}

/** Agent intent comes from typing or a picker selection, never scanning pasted text. */
export const agentTokens = agentMentionTokens;
export function useMentionDrafts(scope: string, text: string) {
  const drafts = useRef(
    new Map<
      string,
      {
        text: string;
        mentions: SubmittedMention[];
        agents: AgentMention[];
        typed?: { start: number; end: number };
      }
    >(),
  );
  function rebaseAgents(before: string, after: string, agents: AgentMention[]) {
    const tokens = agentTokens(after);
    return rebaseMentions(before, after, agents)
      .filter((agent) =>
        tokens.some((token) => token.start === agent.start && token.end === agent.end),
      )
      .map(({ start, end }) => ({ start, end }));
  }
  function get() {
    const prior = drafts.current.get(scope);
    const current = {
      text,
      mentions: prior ? rebaseMentions(prior.text, text, prior.mentions) : [],
      agents: prior ? rebaseAgents(prior.text, text, prior.agents) : [],
      typed: prior?.text === text ? prior.typed : undefined,
    };
    return current;
  }
  function shifted<T extends AgentMention>(mentions: T[]): T[] {
    const shift = text.length - text.trimStart().length;
    return mentions.map((mention) => ({
      ...mention,
      start: mention.start - shift,
      end: mention.end - shift,
    }));
  }
  return {
    submitted: () => shifted(get().mentions),
    submittedAgents: () => shifted(get().agents),
    change(
      next: string,
      selected?: SubmittedMention,
      agent?: AgentMention,
      typed = false,
      replaced?: AgentMention,
    ) {
      const current = get();
      const selection = selected ?? agent;
      const outside = (mention: AgentMention) =>
        !selection || mention.end <= selection.start || mention.start >= selection.end;
      const mentions = rebaseMentions(current.text, next, current.mentions).filter(outside);
      const untouched = current.agents.filter(
        (item) =>
          !replaced ||
          replaced.end <= replaced.start ||
          item.end <= replaced.start ||
          item.start >= replaced.end,
      );
      const agents = rebaseAgents(current.text, next, untouched).filter(outside);
      let run: { start: number; end: number } | undefined;
      if (typed) {
        let start = 0;
        while (
          start < current.text.length &&
          start < next.length &&
          current.text[start] === next[start]
        )
          start++;
        let oldEnd = current.text.length,
          end = next.length;
        while (oldEnd > start && end > start && current.text[oldEnd - 1] === next[end - 1]) {
          oldEnd--;
          end--;
        }
        if (oldEnd === start && end > start) {
          run = { start: current.typed?.end === start ? current.typed.start : start, end };
          for (const token of agentTokens(next)) {
            if (
              token.start >= run.start &&
              token.end <= run.end &&
              !agents.some((item) => item.start === token.start)
            )
              agents.push({ start: token.start, end: token.end });
          }
        }
      }
      if (selected) mentions.push(selected);
      if (
        agent &&
        agentTokens(next).some((token) => token.start === agent.start && token.end === agent.end)
      )
        agents.push(agent);
      mentions.sort((a, b) => a.start - b.start);
      agents.sort((a, b) => a.start - b.start);
      drafts.current.set(scope, { text: next, mentions, agents, typed: run });
    },
    clear() {
      drafts.current.delete(scope);
    },
  };
}
