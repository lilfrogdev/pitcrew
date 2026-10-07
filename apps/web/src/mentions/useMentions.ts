import { useEffect, useRef, useState } from "react";
import { rebaseMentions, validMentionUsername, type SubmittedMention } from "@pitcrew/protocol";
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

export function useMentionDrafts(scope: string, text: string) {
  const drafts = useRef(new Map<string, { text: string; mentions: SubmittedMention[] }>());
  function get() {
    const prior = drafts.current.get(scope);
    const current = {
      text,
      mentions: prior ? rebaseMentions(prior.text, text, prior.mentions) : [],
    };
    drafts.current.set(scope, current);
    return current;
  }
  return {
    submitted() {
      const shift = text.length - text.trimStart().length;
      return get().mentions.map((mention) => ({
        ...mention,
        start: mention.start - shift,
        end: mention.end - shift,
      }));
    },
    change(next: string, selected?: SubmittedMention) {
      const current = get();
      const mentions = rebaseMentions(current.text, next, current.mentions).filter(
        (mention) => !selected || mention.end <= selected.start || mention.start >= selected.end,
      );
      if (selected) mentions.push(selected);
      mentions.sort((a, b) => a.start - b.start);
      drafts.current.set(scope, { text: next, mentions });
    },
    clear() {
      drafts.current.delete(scope);
    },
  };
}
