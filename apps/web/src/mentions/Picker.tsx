import { useId, useLayoutEffect, useState, type RefObject } from "react";
import { mentionQuery, type SubmittedMention } from "@pitcrew/protocol";
import type { Member } from "../api";
import { Avatar } from "../Avatar";
import styles from "./mentions.module.css";

export function useMentionPicker(text: string, members: Member[], scope: string,
  field: RefObject<HTMLTextAreaElement | null>, onDraft: (text: string) => void,
  onMention?: (text: string, mention: SubmittedMention) => void) {
  const id = useId();
  const [cursor, setCursor] = useState({ scope, caret: 0, focused: false });
  const [composing, setComposing] = useState(false);
  const [choice, setChoice] = useState({ query: "", index: 0 });
  const [dismissed, setDismissed] = useState<string>();
  const [pendingCaret, setPendingCaret] = useState<number>();
  const token = cursor.scope === scope && cursor.focused && !composing && onMention
    ? mentionQuery(text, cursor.caret) : undefined;
  const queryKey = token ? `${scope}:${token.start}:${cursor.caret}:${text}` : "";
  const query = token ? text.slice(token.start + 1, cursor.caret).toLowerCase() : "";
  const options = token && dismissed !== queryKey ? members.filter((member) =>
    member.username?.toLowerCase().includes(query)).sort((a, b) =>
    a.username!.localeCompare(b.username!)).slice(0, 8) : [];
  const index = choice.query === queryKey ? Math.min(choice.index, options.length - 1) : 0;
  useLayoutEffect(() => {
    if (pendingCaret === undefined) return;
    field.current?.focus();
    field.current?.setSelectionRange(pendingCaret, pendingCaret);
    setPendingCaret(undefined);
  }, [text, pendingCaret, field]);
  function select(member: Member) {
    if (!token || !onMention) return;
    const label = `@${member.username}`;
    const separator = !text[token.end] || !/\s/.test(text[token.end]) ? " " : "";
    const next = text.slice(0, token.start) + label + separator + text.slice(token.end);
    // Server applies the actual count bound; leave the current text intact on overflow.
    if (next.length > 8000) return;
    onMention(next, { actor: member.actor, start: token.start, end: token.start + label.length });
    setCursor({ scope, caret: token.start + label.length + separator.length, focused: true });
    setPendingCaret(token.start + label.length + separator.length);
    setDismissed(`${scope}:${token.start}:${token.start + label.length}:${next}`);
  }
  const selection = (element: HTMLTextAreaElement) => {
    setCursor({ scope, caret: element.selectionStart, focused: document.activeElement === element && element.selectionStart === element.selectionEnd });
  };
  return {
    selection,
    composing,
    setComposing,
    blur: () => setCursor({ scope, caret: 0, focused: false }),
    change(element: HTMLTextAreaElement) { onDraft(element.value); selection(element); },
    key(event: React.KeyboardEvent<HTMLTextAreaElement>) {
      if (!options.length || composing || event.nativeEvent.isComposing || event.keyCode === 229) return false;
      if (["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(event.key)) {
        if (event.shiftKey && ["Enter", "Tab"].includes(event.key)) return false;
        event.preventDefault();
        if (event.key === "Escape") setDismissed(queryKey);
        else if (event.key === "Enter" || event.key === "Tab") select(options[index]);
        else setChoice({ query: queryKey, index: (index + (event.key === "ArrowDown" ? 1 : options.length - 1)) % options.length });
        return true;
      }
      return false;
    },
    aria: { "aria-autocomplete": "list" as const, "aria-expanded": options.length > 0,
      "aria-controls": options.length ? id : undefined,
      "aria-activedescendant": options.length ? `${id}-${index}` : undefined },
    picker: options.length > 0 && <ul id={id} role="listbox" aria-label="Mention a member" className={styles.picker}>
      {options.map((member, i) => <li key={member.actor} role="option" id={`${id}-${i}`} aria-selected={i === index}>
        <button type="button" tabIndex={-1} onPointerDown={(event) => event.preventDefault()}
          onMouseDown={(event) => event.preventDefault()} onClick={() => select(member)}>
          <Avatar className={styles.avatar} name={member.username!} image={member.avatar} /><span>@{member.username}</span>
        </button>
      </li>)}
    </ul>,
  };
}
