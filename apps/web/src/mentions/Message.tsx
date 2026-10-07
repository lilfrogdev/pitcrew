import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { mentionTokens, type Message } from "@pitcrew/protocol";
import type { Member } from "../api";
import { Avatar } from "../Avatar";
import styles from "./mentions.module.css";

function Mention({ member, label }: { member: Member; label: string }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 8, top: 8 });
  const id = useId();
  const root = useRef<HTMLSpanElement>(null);
  const card = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (
        !root.current?.contains(event.target as Node) &&
        !card.current?.contains(event.target as Node)
      )
        setOpen(false);
    };
    const moved = () => setOpen(false);
    document.addEventListener("pointerdown", close);
    window.addEventListener("resize", moved);
    document.addEventListener("scroll", moved, true);
    return () => {
      document.removeEventListener("pointerdown", close);
      window.removeEventListener("resize", moved);
      document.removeEventListener("scroll", moved, true);
    };
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
        aria-haspopup="dialog"
        aria-controls={open ? id : undefined}
        onClick={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          setPosition({
            left: Math.max(
              8,
              Math.min(box.left, (document.documentElement.clientWidth || window.innerWidth) - 208),
            ),
            top:
              box.bottom + 146 < window.innerHeight ? box.bottom + 6 : Math.max(8, box.top - 146),
          });
          setOpen(!open);
        }}
      >
        {label}
      </button>
      {open &&
        createPortal(
          <span
            ref={card}
            id={id}
            role="dialog"
            aria-label={`@${member.username}`}
            className={styles.card}
            style={position}
          >
            <Avatar className={styles.avatar} name={member.username!} image={member.avatar} />
            <strong>@{member.username}</strong>
            <span>{member.role === "owner" ? "Owner" : "Member"}</span>
          </span>,
          document.body,
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
