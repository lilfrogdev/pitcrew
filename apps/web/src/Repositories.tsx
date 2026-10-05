import { useEffect, useRef, useState } from "react";
import type { RepositoryApi, RepositoryEntry } from "./repository-api";
import { repositoryError, repositoryIssues } from "./repository-api";
import shell from "./NavigationRail.module.css";
import styles from "./Repositories.module.css";
export function Repositories({ api }: { api?: RepositoryApi }) {
  const [items, setItems] = useState<RepositoryEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [mode, setMode] = useState<"create" | "import" | undefined>();
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [consent, setConsent] = useState(false);
  const [target, setTarget] = useState<RepositoryEntry>();
  const [confirmation, setConfirmation] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const [connected, setConnected] = useState(false);
  const available = !!api && connected;
  async function refresh(next?: string) {
    if (!api) return;
    const page = await api.list(next);
    setItems((old) =>
      next
        ? [...new Map([...old, ...page.repositories].map((item) => [item.name, item])).values()]
        : page.repositories,
    );
    setCursor(page.cursor);
    setConnected(true);
  }
  async function perform(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (cause) {
      setError(repositoryError(cause));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    let alive = true;
    if (!api) {
      setError("Repository management is unavailable. Connect the protected cloud backend first.");
      return;
    }
    setBusy(true);
    api
      .list()
      .then((page) => {
        if (alive) {
          setConnected(true);
          setItems(page.repositories);
          setCursor(page.cursor);
          setConnected(true);
        }
      })
      .catch((cause) => {
        if (alive) setError(repositoryError(cause));
      })
      .finally(() => {
        if (alive) setBusy(false);
      });
    return () => {
      alive = false;
    };
  }, [api]);
  useEffect(() => {
    if (target) dialog.current?.showModal();
    else if (dialog.current?.open) dialog.current.close();
  }, [target]);
  function closeDelete() {
    setTarget(undefined);
    setConfirmation("");
    opener.current?.focus();
  }
  return (
    <div className={shell.placeholder}>
      <aside className={shell.context} aria-label="Repositories sidebar">
        <h2>Repositories</h2>
        <div className={styles.actions}>
          <button
            disabled={!available || busy}
            onClick={() => {
              setMode("create");
              setConsent(false);
            }}
          >
            Create
          </button>
          <button
            disabled={!available || busy}
            onClick={() => {
              setMode("import");
              setConsent(false);
            }}
          >
            Import
          </button>
          <button
            aria-label="Refresh repositories"
            title="Refresh repositories"
            disabled={!api || busy}
            onClick={() => void perform(() => refresh())}
          >
            Refresh
          </button>
        </div>
      </aside>
      <main id="workspace-content" className={shell.placeholderMain} tabIndex={-1}>
        <header>
          <h1>Repositories</h1>
        </header>
        <div className={styles.body}>
          {error && !target && <p role="alert">{error}</p>}
          {status && <p role="status">{status}</p>}
          {busy && <p role="status">Working…</p>}
          {mode && (
            <form
              className={styles.form}
              onSubmit={(event) => {
                event.preventDefault();
                void perform(async () => {
                  const result = await api!
                    .provision({
                      name,
                      operation: mode,
                      ...(mode === "import" ? { url } : {}),
                      credentialConsent: true,
                    })
                    .catch(async (cause) => {
                      await refresh().catch(() => {});
                      throw cause;
                    });
                  setStatus(`${result.name}: ${result.status.replaceAll("_", " ")}.`);
                  setMode(undefined);
                  setName("");
                  setUrl("");
                  setConsent(false);
                  await refresh();
                });
              }}
            >
              <h2>{mode === "create" ? "Create repository" : "Import public repository"}</h2>
              <label>
                Repository name
                <input
                  required
                  maxLength={63}
                  pattern="[a-z0-9][a-z0-9-]{0,62}"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  disabled={busy}
                />
              </label>
              {mode === "import" && (
                <label>
                  Public GitHub HTTPS URL
                  <input
                    required
                    type="url"
                    maxLength={512}
                    value={url}
                    placeholder="https://github.com/owner/repository"
                    onChange={(event) => setUrl(event.target.value)}
                    disabled={busy}
                  />
                </label>
              )}
              <p className={styles.note}>
                {mode === "import"
                  ? "Imports the default branch at depth 1 as read-only. Private repositories are unsupported. "
                  : "Creates an empty, read-only repository. "}
                Cloudflare automatically creates a Git credential with platform-defined scope and
                expiry. Pitcrew revokes it before marking the repository ready; delayed cleanup
                requires reconciliation. No credential is shown or stored by Pitcrew. Cloudflare
                storage usage may apply.
              </p>
              <label className={styles.consent}>
                <input
                  type="checkbox"
                  checked={consent}
                  onChange={(event) => setConsent(event.target.checked)}
                  disabled={busy}
                />
                I authorize this repository and its temporary Git credential.
              </label>
              <div className={styles.actions}>
                <button type="submit" disabled={!consent || busy}>
                  {mode === "create" ? "Create repository" : "Import repository"}
                </button>
                <button type="button" disabled={busy} onClick={() => setMode(undefined)}>
                  Cancel
                </button>
              </div>
            </form>
          )}
          {!busy && !error && items.length === 0 && <p>No cloud repositories found.</p>}
          <ul className={styles.list}>
            {items.map((item) => (
              <li key={item.name}>
                <div>
                  <strong>{item.name}</strong>
                  <span>{item.lifecycle.replaceAll("_", " ")}</span>
                </div>
                {item.issue && (
                  <p>{repositoryIssues[item.issue] ?? "Owner investigation required."}</p>
                )}
                {item.lifecycle === "pending" && (
                  <p>
                    Outcome pending. Refresh status; owner investigation may be required. Do not
                    create again.
                  </p>
                )}
                {["cleanup_required", "deleting"].includes(item.lifecycle) && (
                  <button
                    disabled={busy}
                    onClick={() =>
                      void perform(async () => {
                        await api!.reconcile(item.name);
                        await refresh();
                      })
                    }
                  >
                    Reconcile {item.name}
                  </button>
                )}
                <button
                  disabled={busy || !item.deletable}
                  title={
                    item.deletable
                      ? `Delete ${item.name}`
                      : "Existing, referenced or unreconciled repositories are protected"
                  }
                  aria-label={`Delete ${item.name}`}
                  onClick={(event) => {
                    opener.current = event.currentTarget;
                    setTarget(item);
                    setConfirmation("");
                  }}
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
          {cursor && (
            <button disabled={busy} onClick={() => void perform(() => refresh(cursor))}>
              Load more repositories
            </button>
          )}
        </div>
      </main>
      <dialog
        ref={dialog}
        className={styles.dialog}
        aria-labelledby="delete-repository-title"
        onCancel={(event) => {
          if (busy) event.preventDefault();
          else closeDelete();
        }}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!target || confirmation !== target.name) return;
            void perform(async () => {
              await api!.remove(target.name, confirmation);
              setStatus(`${target.name} deleted.`);
              closeDelete();
              await refresh();
            });
          }}
        >
          {error && target && <p role="alert">{error}</p>}
          <h2 id="delete-repository-title">Delete {target?.name}?</h2>
          <p>
            This permanently deletes this Cloudflare repository, its Git contents and its access
            tokens. The public source repository is unaffected. This cannot be undone.
          </p>
          <label>
            Type {target?.name} to confirm
            <input
              autoFocus
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              disabled={busy}
            />
          </label>
          <div className={styles.actions}>
            <button type="button" disabled={busy} onClick={closeDelete}>
              Cancel
            </button>
            <button type="submit" disabled={busy || !target || confirmation !== target.name}>
              Delete repository
            </button>
          </div>
        </form>
      </dialog>
    </div>
  );
}
