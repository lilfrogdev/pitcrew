import { useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IconChevronDown, IconLock } from "@tabler/icons-react";
import { useUpwardPopup } from "./useUpwardPopup";
import styles from "./PermissionsMenu.module.css";

/** Status only: Pitcrew has no per-thread permission mode contract. */
export function PermissionsMenu({ executionEnabled }: { executionEnabled: boolean | null }) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const position = useUpwardPopup(open, trigger, popup, setOpen, 300);
  const label =
    executionEnabled === null
      ? "Agent status unavailable"
      : executionEnabled
        ? "Agent available"
        : "Agent unavailable";
  return (
    <>
      <button
        type="button"
        ref={trigger}
        className={styles.trigger}
        aria-label={`Permissions, ${label}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen(!open)}
      >
        <IconLock size={16} stroke={1.5} aria-hidden="true" />
        <span>{label}</span>
        <IconChevronDown size={13} stroke={1.5} aria-hidden="true" />
      </button>
      {open &&
        createPortal(
          <div
            ref={popup}
            style={position}
            className={styles.popup}
            id={id}
            role="dialog"
            aria-label="Agent availability"
          >
            <div className={styles.heading}>Agent availability</div>
            <div className={styles.status} role="status">
              <div>
                <IconLock size={15} stroke={1.5} aria-hidden="true" />
                {label}
              </div>
              <p>{executionEnabled === null ? "Status unavailable." : "Managed by the server."}</p>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
