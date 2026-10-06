import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { OpenRouterConnectionApi, OpenRouterStatus } from "./openrouter-types";
import type { CollaborationApi } from "./api";
import type { AuthUser } from "./auth-api";
import { AccountSummary } from "./Collaboration";
import styles from "./ProfileProviders.module.css";
const unavailable: OpenRouterStatus = {
  available: false,
  storageAvailable: false,
  configured: false,
  executionEnabled: false,
};

export function ProfileProviders({
  api,
  collaboration,
  viewer,
  invitation,
  onSignOut,
  onChange,
}: {
  api?: OpenRouterConnectionApi;
  collaboration?: CollaborationApi;
  viewer?: AuthUser;
  invitation?: ReactNode;
  onSignOut?: () => Promise<void>;
  onChange?: () => void;
}) {
  const [status, setStatus] = useState(unavailable);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const content = useRef<HTMLElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  const setField = useCallback((node: HTMLInputElement | null) => {
    if (!node && field.current) field.current.value = "";
    field.current = node;
  }, []);
  useEffect(() => {
    mounted.current = true;
    content.current?.focus();
    setStatus(unavailable);
    setLoading(true);
    void (api?.status() ?? Promise.resolve(unavailable))
      .then((value) => {
        if (mounted.current) setStatus(value);
      })
      .catch(() => {})
      .finally(() => {
        if (mounted.current) setLoading(false);
      });
    return () => {
      mounted.current = false;
      if (field.current) field.current.value = "";
    };
  }, [api]);
  const writable = !!api && status.available && status.storageAvailable && !loading && !busy;
  async function change(action: "store" | "remove") {
    if (!writable || !api) return;
    if (action === "store" && !field.current?.value) return;
    setBusy(true);
    setError("");
    setMessage("");
    const key = action === "store" ? field.current!.value : "";
    if (field.current) field.current.value = "";
    try {
      const result = action === "store" ? await api.store(key) : await api.remove();
      if (mounted.current) {
        setStatus(result);
        setMessage(action === "store" ? "Saved" : "Removed");
      }
      onChange?.();
    } catch {
      if (mounted.current)
        setError(
          action === "store"
            ? "Could not save API key. Try again."
            : "Could not remove API key. Try again.",
        );
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <div className={styles.profile}>
      <aside className={styles.sidebar} aria-label="Profile settings">
        <h2>Profile</h2>
        <nav aria-label="Profile">
          <button type="button" aria-current="page">
            Providers
          </button>
        </nav>
      </aside>
      <main ref={content} id="workspace-content" className={styles.content} tabIndex={-1}>
        <header>
          <p>Profile</p>
          <h1>Providers</h1>
        </header>
        <AccountSummary api={collaboration} viewer={viewer} onSignOut={onSignOut} />
        {invitation}
        <section className={styles.provider} aria-labelledby="openrouter-heading">
          <h2 id="openrouter-heading">OpenRouter</h2>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void change("store");
            }}
          >
            <label htmlFor="openrouter-api-key">API key</label>
            <input
              id="openrouter-api-key"
              ref={setField}
              type="password"
              autoComplete="off"
              spellCheck={false}
              maxLength={4096}
              required
              disabled={!writable}
              placeholder={status.configured ? "Replace API key" : "Enter API key"}
            />
            <div className={styles.actions}>
              <button type="submit" disabled={!writable}>
                Save
              </button>
              <button type="button" onClick={() => void change("remove")} disabled={!writable}>
                Remove
              </button>
            </div>
          </form>
          {message && <p role="status">{message}</p>}
          {error && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}
        </section>
      </main>
    </div>
  );
}
