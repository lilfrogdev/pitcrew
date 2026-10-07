import styles from "./ComposerStatus.module.css";
export function typingText(usernames: string[]) {
  if (usernames.length >= 3) return "Several people are typing…";
  if (usernames.length === 2) return `${usernames[0]} and ${usernames[1]} are typing…`;
  return usernames.length ? `${usernames[0]} is typing…` : "";
}
export function ComposerStatus({
  usernames,
  reconnecting,
  approval,
  onReconnect,
}: {
  usernames: string[];
  reconnecting: boolean;
  approval?: { onOpen: () => void };
  onReconnect?: () => void;
}) {
  const text = approval
    ? "Agent needs your approval"
    : reconnecting
      ? "Reconnecting…"
      : typingText(usernames);
  return (
    <div className={styles.slot}>
      <div className={styles.status} data-visible={!!text}>
        <span className={styles.dot} aria-hidden="true" />
        <span role="status" aria-live="polite" aria-atomic="true" className={styles.text}>
          {text}
        </span>
        {approval && (
          <button type="button" onClick={approval.onOpen}>
            Review
          </button>
        )}
        {!approval && reconnecting && onReconnect && (
          <button type="button" onClick={onReconnect}>
            Retry connection
          </button>
        )}
      </div>
    </div>
  );
}
