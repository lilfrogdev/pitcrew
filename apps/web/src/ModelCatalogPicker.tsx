import { useEffect, useLayoutEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IconCheck, IconChevronDown, IconSearch, IconStar } from "@tabler/icons-react";
import type { ModelChoice } from "@pitcrew/protocol";
import { ProviderIcon, providerName } from "./ProviderIcon";
import { ModelIcon } from "./ModelIcon";
import { useUpwardPopup } from "./useUpwardPopup";
import { favoriteKey, useModelFavorites } from "./model-favorites";
import styles from "./ModelCatalogPicker.module.css";

export function ModelCatalogPicker({
  models,
  value,
  label,
  onChange,
  disabled,
  describedBy,
  favoritesScope,
  status = "ready",
}: {
  models: ModelChoice[];
  value: string;
  label: string;
  onChange: (model: ModelChoice) => void;
  disabled: boolean;
  describedBy?: string;
  favoritesScope?: string;
  status?: "ready" | "loading" | "error" | "disconnected";
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [section, setSection] = useState("");
  const [activeId, setActiveId] = useState(value);
  const { favorites, toggle } = useModelFavorites(favoritesScope);
  const selected = models.find((model) => model.id === value);
  const providers = [...new Set(models.map((model) => model.provider))];
  const currentSection =
    section === "favorites" || providers.includes(section)
      ? section
      : (selected?.provider ?? providers[0]);
  const tokens = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const filtered = (status === "ready" ? models : []).filter((model) =>
    tokens.length
      ? tokens.every((token) =>
          `${model.label} ${model.model} ${providerName(model.provider)}`
            .toLowerCase()
            .includes(token),
        )
      : currentSection === "favorites"
        ? favorites.includes(favoriteKey(model))
        : model.provider === currentSection,
  );
  const available = filtered.filter((model) => model.efforts.length);
  const active = available.find((model) => model.id === activeId) ?? available[0];
  const expanded = open && !disabled;
  const position = useUpwardPopup(expanded, trigger, popup, setOpen, 362);
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  useLayoutEffect(() => {
    if (!expanded) return;
    search.current?.focus({ preventScroll: true });
    const frame = requestAnimationFrame(() => search.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [expanded]);
  useEffect(() => {
    if (expanded && active)
      document.getElementById(`${id}-${active.id}`)?.scrollIntoView?.({ block: "nearest" });
  }, [expanded, active?.id, id]);
  const show = () => {
    setQuery("");
    setSection(selected?.provider ?? providers[0] ?? "favorites");
    setActiveId(value);
    setOpen(true);
  };
  const choose = (model: ModelChoice) => {
    if (
      disabled ||
      status !== "ready" ||
      !model.efforts.length ||
      !models.some((item) => item.id === model.id)
    )
      return;
    setOpen(false);
    if (model.id !== value) onChange(model);
    trigger.current?.focus();
  };
  const empty =
    status === "loading"
      ? "Loading models…"
      : status === "error"
        ? "Models unavailable"
        : status === "disconnected"
          ? "Connect a provider to see models"
          : tokens.length
            ? "No models found"
            : currentSection === "favorites"
              ? "No favorites yet"
              : "No available models";
  return (
    <>
      <button
        ref={trigger}
        type="button"
        role="combobox"
        className={styles.trigger}
        value={selected ? value : ""}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={expanded}
        aria-controls={expanded ? `${id}-dialog` : undefined}
        aria-describedby={describedBy}
        aria-invalid={!selected || undefined}
        disabled={disabled}
        onClick={() => (expanded ? setOpen(false) : show())}
        onKeyDown={(event) => {
          if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) {
            event.preventDefault();
            show();
          }
        }}
      >
        <ModelIcon model={selected} size={16} />
        <span className={styles.triggerLabel}>{selected?.label ?? "Choose model"}</span>
        <IconChevronDown size={13} stroke={1.5} aria-hidden="true" />
      </button>
      {expanded &&
        createPortal(
          <div
            ref={popup}
            id={`${id}-dialog`}
            role="dialog"
            aria-label="Choose a model"
            className={styles.popup}
            style={position}
          >
            <div className={styles.rail} role="group" aria-label="Providers">
              <button
                type="button"
                aria-label="Favorites"
                title="Favorites"
                aria-pressed={currentSection === "favorites" && !tokens.length}
                className={styles.railButton}
                onClick={() => {
                  setSection("favorites");
                  setQuery("");
                  search.current?.focus();
                }}
              >
                <IconStar
                  size={20}
                  stroke={1.5}
                  fill="currentColor"
                  className={styles.favoritesIcon}
                  aria-hidden="true"
                />
              </button>
              <span className={styles.railDivider} />
              {providers.map((provider) => (
                <button
                  key={provider}
                  type="button"
                  aria-label={providerName(provider)}
                  title={providerName(provider)}
                  aria-pressed={currentSection === provider && !tokens.length}
                  className={styles.railButton}
                  onClick={() => {
                    setSection(provider);
                    setQuery("");
                    search.current?.focus();
                  }}
                >
                  <ProviderIcon provider={provider} size={20} />
                </button>
              ))}
            </div>
            <div className={styles.content}>
              <div className={styles.search}>
                <IconSearch size={16} stroke={1.5} aria-hidden="true" />
                <input
                  ref={search}
                  aria-label="Search models"
                  role="combobox"
                  aria-autocomplete="list"
                  aria-haspopup="grid"
                  aria-expanded="true"
                  aria-controls={`${id}-listbox`}
                  aria-activedescendant={active ? `${id}-${active.id}` : undefined}
                  placeholder="Search models…"
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setActiveId("");
                  }}
                  onKeyDown={(event) => {
                    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
                      if (["Home", "End"].includes(event.key) && !event.ctrlKey && !event.metaKey)
                        return;
                      event.preventDefault();
                      const index = available.findIndex((model) => model === active);
                      const next =
                        event.key === "Home"
                          ? 0
                          : event.key === "End"
                            ? available.length - 1
                            : (index + (event.key === "ArrowDown" ? 1 : -1) + available.length) %
                              available.length;
                      setActiveId(available[next]?.id ?? "");
                    }
                    if (event.key === "Enter") {
                      event.preventDefault();
                      if (active) choose(active);
                    }
                  }}
                />
              </div>
              {currentSection === "favorites" && !tokens.length && (
                <div className={styles.heading}>Favorites</div>
              )}
              <div id={`${id}-listbox`} role="grid" aria-label={label} className={styles.list}>
                {filtered.map((model) => (
                  <div
                    className={styles.row}
                    role="row"
                    aria-selected={model.id === value}
                    key={model.id}
                    data-active={model === active}
                    data-selected={model.id === value}
                  >
                    <div
                      id={`${id}-${model.id}`}
                      role="gridcell"
                      aria-label={model.label}
                      aria-disabled={!model.efforts.length || undefined}
                      className={styles.option}
                      onPointerMove={() => {
                        if (model.efforts.length) setActiveId(model.id);
                      }}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => choose(model)}
                    >
                      <span className={styles.modelName} title={model.label}>
                        {model.label}
                      </span>
                      <span className={styles.provider}>
                        <ProviderIcon provider={model.provider} size={12} />
                        {providerName(model.provider)}
                      </span>
                    </div>
                    {model.id === value && (
                      <IconCheck
                        size={13}
                        stroke={1.5}
                        className={styles.check}
                        aria-hidden="true"
                      />
                    )}
                    <span role="gridcell" className={styles.favoriteCell}>
                      <button
                        type="button"
                        className={styles.favorite}
                        aria-label={`${favorites.includes(favoriteKey(model)) ? "Remove" : "Add"} ${model.label} ${favorites.includes(favoriteKey(model)) ? "from" : "to"} favorites`}
                        aria-pressed={favorites.includes(favoriteKey(model))}
                        disabled={!model.efforts.length}
                        onClick={() => {
                          if (
                            currentSection === "favorites" &&
                            !tokens.length &&
                            favorites.includes(favoriteKey(model))
                          )
                            search.current?.focus();
                          toggle(model);
                        }}
                      >
                        <IconStar
                          size={14}
                          stroke={1.5}
                          fill={favorites.includes(favoriteKey(model)) ? "currentColor" : "none"}
                          aria-hidden="true"
                        />
                      </button>
                    </span>
                  </div>
                ))}
              </div>
              {!filtered.length && (
                <div className={styles.empty} role="status">
                  {empty}
                </div>
              )}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
