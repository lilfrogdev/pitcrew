import { useId, useEffect, useLayoutEffect, useState, type RefObject } from "react";
import { mentionQuery, type AgentMention, type SubmittedMention } from "@pitcrew/protocol";
import type { Member } from "../api";
import { agentTokens } from "./useMentions";
import { Avatar } from "../Avatar";
import styles from "./mentions.module.css";

export function useMentionPicker(
  text: string,
  members: Member[],
  scope: string,
  field: RefObject<HTMLTextAreaElement | null>,
  onDraft: (text: string, typed?: boolean, replaced?: AgentMention) => void,
  onMention?: (text: string, mention: SubmittedMention) => void,
  onAgentMention?: (text: string, mention: AgentMention) => void,
) {
  const id = useId();
  const [cursor, setCursor] = useState({ scope, caret: 0, focused: false });
  const [composing, setComposing] = useState(false);
  const [choice, setChoice] = useState({ query: "", index: 0 });
  const [dismissed, setDismissed] = useState<string>();
  const [literalText, setLiteralText] = useState<string>();
  const [pendingCaret, setPendingCaret] = useState<number>();
  useEffect(() => {
    setComposing(false);
    setDismissed(undefined);
  }, [scope]);
  const token =
    cursor.scope === scope && cursor.focused && !composing && (onMention || onAgentMention)
      ? mentionQuery(text, cursor.caret)
      : undefined;
  const queryKey = token ? `${scope}:${token.start}:${cursor.caret}:${text}` : "";
  const query = token ? text.slice(token.start + 1, cursor.caret).toLowerCase() : "";
  type Target = { kind: "agent" } | { kind: "member"; member: Member };
  const options: Target[] =
    token && dismissed !== queryKey && literalText !== text
      ? [
          ...(onAgentMention &&
          "agent".includes(query) &&
          agentTokens(text.slice(0, token.start) + "@agent" + text.slice(token.end)).some(
            (item) => item.start === token.start,
          )
            ? [{ kind: "agent" as const }]
            : []),
          ...members
            .filter((member) => member.username?.toLowerCase().includes(query))
            .sort((a, b) => a.username!.localeCompare(b.username!))
            .slice(0, 8)
            .map((member) => ({ kind: "member" as const, member })),
        ].slice(0, 8)
      : [];
  const index = choice.query === queryKey ? Math.min(choice.index, options.length - 1) : 0;
  useLayoutEffect(() => {
    if (pendingCaret === undefined) return;
    field.current?.focus();
    field.current?.setSelectionRange(pendingCaret, pendingCaret);
    setPendingCaret(undefined);
  }, [text, pendingCaret, field]);
  function select(target: Target) {
    if (!token) return;
    const label = target.kind === "agent" ? "@agent" : `@${target.member.username}`;
    const separator = !text[token.end] || !/\s/.test(text[token.end]) ? " " : "";
    const next = text.slice(0, token.start) + label + separator + text.slice(token.end);
    // Server applies the actual count bound; leave the current text intact on overflow.
    if (next.length > 8000) return;
    const range = { start: token.start, end: token.start + label.length };
    if (target.kind === "agent") {
      if (!agentTokens(next).some((item) => item.start === range.start && item.end === range.end))
        return;
      onAgentMention?.(next, range);
    } else onMention?.(next, { actor: target.member.actor, ...range });
    const nextCaret =
      token.start + label.length + (separator.length || (/\s/.test(text[token.end] ?? "") ? 1 : 0));
    setCursor({ scope, caret: nextCaret, focused: true });
    setPendingCaret(nextCaret);
    setDismissed(undefined);
  }
  const selection = (element: HTMLTextAreaElement) => {
    setCursor({
      scope,
      caret: element.selectionStart,
      focused:
        document.activeElement === element && element.selectionStart === element.selectionEnd,
    });
  };
  return {
    selection,
    composing,
    setComposing,
    blur: () => setCursor({ scope, caret: 0, focused: false }),
    change(element: HTMLTextAreaElement, typed = false, replaced?: AgentMention) {
      setLiteralText(typed ? undefined : element.value);
      onDraft(element.value, typed, replaced);
      selection(element);
    },
    key(event: React.KeyboardEvent<HTMLTextAreaElement>) {
      if (!options.length || composing || event.nativeEvent.isComposing || event.keyCode === 229)
        return false;
      if (["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(event.key)) {
        if (event.shiftKey && ["Enter", "Tab"].includes(event.key)) return false;
        event.preventDefault();
        if (event.key === "Escape") setDismissed(queryKey);
        else if (event.key === "Enter" || event.key === "Tab") select(options[index]);
        else
          setChoice({
            query: queryKey,
            index: (index + (event.key === "ArrowDown" ? 1 : options.length - 1)) % options.length,
          });
        return true;
      }
      return false;
    },
    aria: {
      "aria-autocomplete": "list" as const,
      "aria-expanded": options.length > 0,
      "aria-controls": options.length ? id : undefined,
      "aria-activedescendant": options.length ? `${id}-${index}` : undefined,
    },
    picker: options.length > 0 && (
      <ul id={id} role="listbox" aria-label="Mention a member" className={styles.picker}>
        {options.map((target, i) => (
          <li
            key={target.kind === "agent" ? "agent" : target.member.actor}
            role="option"
            id={`${id}-${i}`}
            aria-selected={i === index}
          >
            <button
              type="button"
              tabIndex={-1}
              onPointerDown={(event) => event.preventDefault()}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => select(target)}
            >
              <Avatar
                className={styles.avatar}
                name={target.kind === "agent" ? "Agent" : target.member.username!}
                image={target.kind === "member" ? target.member.avatar : undefined}
              />
              <span>
                {target.kind === "agent"
                  ? "@agent · Agent"
                  : `@${target.member.username}${target.member.username === "agent" ? " · Member" : ""}`}
              </span>
            </button>
          </li>
        ))}
      </ul>
    ),
  };
}
