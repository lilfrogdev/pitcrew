import { useEffect, useId, useRef, useState } from "react";
import { IconCheck, IconChevronDown } from "@tabler/icons-react";
import styles from "./Select.module.css";

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

/** A select-only combobox so selection never inherits the OS popup highlight. */
export function Select({
  label,
  value,
  options,
  onChange,
  disabled = false,
  placeholder = "Choose",
  describedBy,
  invalid,
  compact = false,
}: {
  label: string;
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  describedBy?: string;
  invalid?: boolean;
  compact?: boolean;
}) {
  const id = useId();
  const root = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const search = useRef({ text: "", time: 0 });
  const [open, setOpen] = useState(false);
  const [activeValue, setActiveValue] = useState(value);
  const enabled = options.filter((option) => !option.disabled);
  const selected = options.find((option) => option.value === value);
  const active = enabled.find((option) => option.value === activeValue) ?? enabled[0];
  const expanded = open && !disabled && enabled.length > 0;
  const activeIndex = options.findIndex((option) => option === active);
  useEffect(() => {
    if (disabled || !enabled.length) setOpen(false);
  }, [disabled, enabled.length]);
  useEffect(() => {
    if (!expanded) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [expanded]);
  useEffect(() => {
    if (expanded)
      document
        .getElementById(`${id}-option-${activeIndex}`)
        ?.scrollIntoView?.({ block: "nearest" });
  }, [expanded, activeIndex, id]);
  function show() {
    setActiveValue(
      enabled.find((option) => option.value === value)?.value ?? enabled[0]?.value ?? "",
    );
    search.current = { text: "", time: 0 };
    setOpen(true);
  }
  function choose(option: SelectOption) {
    if (disabled || option.disabled) return;
    setOpen(false);
    if (option.value !== value) onChange(option.value);
    trigger.current?.focus();
  }
  return (
    <span ref={root} className={`${styles.select} ${compact ? styles.compact : ""}`}>
      <button
        ref={trigger}
        type="button"
        role="combobox"
        className={styles.trigger}
        value={value}
        aria-label={label}
        aria-expanded={expanded}
        aria-haspopup="listbox"
        aria-controls={expanded ? `${id}-listbox` : undefined}
        aria-activedescendant={expanded && active ? `${id}-option-${activeIndex}` : undefined}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        disabled={disabled || !enabled.length}
        onClick={() => (expanded ? setOpen(false) : show())}
        onBlur={(event) => {
          if (!root.current?.contains(event.relatedTarget as Node | null)) setOpen(false);
        }}
        onKeyDown={(event) => {
          if (event.key === "Tab" || event.key === "Escape") {
            setOpen(false);
            if (event.key === "Escape" && expanded) {
              event.preventDefault();
              event.stopPropagation();
            }
            return;
          }
          if (["Enter", " "].includes(event.key)) {
            event.preventDefault();
            if (expanded && active) choose(active);
            else show();
            return;
          }
          if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
            event.preventDefault();
            if (!expanded) {
              show();
              if (event.key === "Home") setActiveValue(enabled[0]?.value ?? "");
              if (event.key === "End") setActiveValue(enabled.at(-1)?.value ?? "");
            } else {
              const index = enabled.findIndex((option) => option === active);
              const next =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? enabled.length - 1
                    : (index + (event.key === "ArrowDown" ? 1 : -1) + enabled.length) %
                      enabled.length;
              setActiveValue(enabled[next]?.value ?? "");
            }
            return;
          }
          if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
            event.preventDefault();
            const now = Date.now();
            const text =
              (now - search.current.time < 700 ? search.current.text : "") +
              event.key.toLowerCase();
            search.current = { text, time: now };
            const query = [...text].every((character) => character === text[0]) ? text[0] : text;
            const index = enabled.findIndex(
              (option) => option.value === (expanded ? active?.value : value),
            );
            const ordered = [...enabled.slice(index + 1), ...enabled.slice(0, index + 1)];
            const match = ordered.find((option) => option.label.toLowerCase().startsWith(query));
            if (match) {
              if (expanded) setActiveValue(match.value);
              else onChange(match.value);
            }
          }
        }}
      >
        <span className={styles.value}>{selected?.label ?? placeholder}</span>
        <IconChevronDown size={14} stroke={1.5} aria-hidden="true" />
      </button>
      {expanded && (
        <span id={`${id}-listbox`} role="listbox" aria-label={label} className={styles.options}>
          {options.map((option, index) => (
            <span
              key={option.value}
              id={`${id}-option-${index}`}
              role="option"
              aria-selected={option.value === value}
              aria-disabled={option.disabled || undefined}
              data-active={option === active}
              className={styles.option}
              onPointerMove={() => {
                if (!option.disabled) setActiveValue(option.value);
              }}
              onMouseDown={(event) => event.preventDefault()}
              onClick={(event) => {
                // An enclosing label must not forward this click back to the trigger.
                event.preventDefault();
                choose(option);
              }}
            >
              <span>{option.label}</span>
              {option.value === value && <IconCheck size={14} stroke={1.5} aria-hidden="true" />}
            </span>
          ))}
        </span>
      )}
    </span>
  );
}
