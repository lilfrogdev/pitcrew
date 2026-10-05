import { useCallback, useEffect, useRef, useState } from "react";
import styles from "./OpenRouterConnection.module.css";

import type { OpenRouterStatus, OpenRouterConnectionApi } from "./openrouter-types";
const unavailable: OpenRouterStatus = {
  available: false,
  configured: false,
  executionEnabled: false,
};

/** The key stays in this uncontrolled field only until the explicit save action. */
export function OpenRouterConnection({ api }: { api: OpenRouterConnectionApi }) {
  const [status, setStatus] = useState(unavailable);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [approved, setApproved] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const setInput = useCallback((node: HTMLInputElement | null) => {
    if (!node && input.current) input.current.value = "";
    input.current = node;
  }, []);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    void api
      .status()
      .then((value) => {
        if (mounted.current) setStatus(value);
      })
      .catch(() => {});
    return () => {
      mounted.current = false;
      if (input.current) input.current.value = "";
    };
  }, [api]);
  function close() {
    if (input.current) input.current.value = "";
    setApproved(false);
    setError("");
    setOpen(false);
  }
  async function save() {
    if (!status.available || busy || !approved || !input.current?.value) return;
    setBusy(true);
    setError("");
    // Clear immediately, including on failure. Never copy the key into React state.
    const key = input.current.value;
    input.current.value = "";
    setApproved(false);
    try {
      const next = await api.store(key);
      if (mounted.current) {
        setStatus(next);
        setOpen(false);
      }
    } catch {
      if (mounted.current) setError("Could not store the key. Enter it again to retry.");
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <div className={styles.connection}>
      <button type="button" onClick={() => (open ? close() : setOpen(true))} disabled={busy}>
        OpenRouter · {status.configured ? "Key stored" : "Connect"}
      </button>
      {open && (
        <form
          className={styles.panel}
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          {!status.available ? (
            <p role="status">
              Secure local setup is unavailable. Start the reviewed local connection controller.
            </p>
          ) : (
            <>
              <p>
                Save your existing OpenRouter key as an encrypted secret in your Pitcrew Cloudflare
                account, Worker <strong>pitcrew-backend</strong>. It persists until you replace or
                remove it in Cloudflare. Cloud agents use it to call OpenRouter with the selected
                model. Saving makes no model request.
              </p>
              <p>Model usage is billed by OpenRouter separately from your Cloudflare budget.</p>
              <p>
                After a local controller restart, this screen cannot verify a previously stored key.
                Cloudflare remains the source of truth.
              </p>
              <label>
                OpenRouter API key
                <input
                  ref={setInput}
                  type="password"
                  name="openrouter-key"
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={4096}
                  disabled={busy}
                  required
                />
              </label>
              <label className={styles.approval}>
                <input
                  type="checkbox"
                  checked={approved}
                  onChange={(event) => setApproved(event.target.checked)}
                  disabled={busy}
                />
                I approve storing this key in my Pitcrew Cloudflare Worker.
              </label>
              <button type="submit" disabled={!approved || busy}>
                {busy ? "Saving…" : "Store in Cloudflare"}
              </button>
            </>
          )}
          {error && <p role="alert">{error}</p>}
          <button type="button" onClick={close} disabled={busy}>
            Close
          </button>
        </form>
      )}
      {status.configured && !status.executionEnabled && (
        <p className={styles.status} role="status">
          Key stored. Cloud execution is awaiting backend setup.
        </p>
      )}
    </div>
  );
}
