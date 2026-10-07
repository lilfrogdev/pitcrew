import { useEffect, useRef, useState } from "react";
import { mentionTokens, type Message } from "@pitcrew/protocol";
import type { Member } from "../api";
import { Avatar } from "../Avatar";
import styles from "./mentions.module.css";

function Mention({ member, label }: { member: Member; label: string }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);
  return (
    <span
      ref={root}
      className={styles.identity}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          setOpen(false);
          event.stopPropagation();
        }
      }}
    >
      <button
        type="button"
        className={styles.mention}
        aria-label={`View @${member.username}`}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {label}
      </button>
      {open && (
        <span role="dialog" aria-label={`@${member.username}`} className={styles.card}>
          <Avatar className={styles.avatar} name={member.username!} image={member.avatar} />
          <strong>@{member.username}</strong>
          <span>{member.role === "owner" ? "Owner" : "Member"}</span>
        </span>
      )}
    </span>
  );
}
export function Mentioned({ message, recipient }: { message: Message; recipient?: string }) {
  return recipient && message.mentions?.some((mention) => mention.actor === recipient) ? (
    <span className={styles.addressed}>Mentioned you</span>
  ) : null;
}
export function MessageContent({ message, members }: { message: Message; members: Member[] }) {
  const tokens = mentionTokens(message.content);
  let offset = 0;
  const parts: React.ReactNode[] = [];
  for (const mention of message.mentions ?? []) {
    const member = members.find((member) => member.actor === mention.actor);
    if (
      !member ||
      mention.start < offset ||
      !tokens.some(
        (token) =>
          token.start === mention.start &&
          token.end === mention.end &&
          token.username.toLowerCase() === mention.username.toLowerCase(),
      )
    )
      continue;
    parts.push(message.content.slice(offset, mention.start));
    parts.push(<Mention key={mention.start} member={member} label={`@${member.username}`} />);
    offset = mention.end;
  }
  parts.push(message.content.slice(offset));
  return <p>{parts}</p>;
}
