import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  type ApprovedProjectAdoption,
  type CollaborationApi,
  type SharedRepository,
} from "./api";
import styles from "./Repositories.module.css";

const adoptionKey = (item: ApprovedProjectAdoption) =>
  JSON.stringify([item.name, item.repositoryId]);

export function AccountRepositories({
  api,
  onAdopted,
}: {
  api: CollaborationApi;
  onAdopted?: () => void;
}) {
  const [items, setItems] = useState<SharedRepository[]>([]);
  const [approvals, setApprovals] = useState<ApprovedProjectAdoption[]>([]);
  const [confirmed, setConfirmed] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [approvalError, setApprovalError] = useState("");
  const [adoptionError, setAdoptionError] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const pending = useRef<object | null>(null);
  const adopted = useRef(new Set<string>());
  const load = useCallback(async () => {
    const current = ++generation.current;
    setLoading(true);
    setConfirmed({});
    const [repositories, candidates] = await Promise.allSettled([
      api.repositories(),
      api.approvedProjectAdoptions?.() ?? Promise.resolve([]),
    ]);
    if (current !== generation.current) return;
    setItems(repositories.status === "fulfilled" ? repositories.value : []);
    setError(
      repositories.status === "fulfilled"
        ? ""
        : repositories.reason instanceof Error
          ? repositories.reason.message
          : "Could not load repositories.",
    );
    setApprovals(
      candidates.status === "fulfilled"
        ? candidates.value.filter((item) => !adopted.current.has(adoptionKey(item)))
        : [],
    );
    setApprovalError(
      candidates.status === "fulfilled"
        ? ""
        : "Could not check repository approvals. Refresh to try again.",
    );
    setLoading(false);
  }, [api]);
  const adopt = async (item: ApprovedProjectAdoption) => {
    if (pending.current || loading || !confirmed[adoptionKey(item)] || !api.adoptProject) return;
    const operation = {};
    pending.current = operation;
    setBusy(true);
    setAdoptionError("");
    setAnnouncement("");
    try {
      await api.adoptProject(item.name, item.repositoryId);
      // Work stays mounted when this directory closes, so its project list still needs refreshing.
      onAdopted?.();
      if (pending.current !== operation) return;
      adopted.current.add(adoptionKey(item));
      setApprovals((items) =>
        items.filter((candidate) => adoptionKey(candidate) !== adoptionKey(item)),
      );
      setAnnouncement(`${item.name} was added to your repositories.`);
      await load();
    } catch (cause) {
      if (pending.current !== operation) return;
      setAdoptionError(
        cause instanceof ApiError && [401, 403].includes(cause.status)
          ? "Repository approval is unavailable for this account. Ask the operator to check your approval, then refresh."
          : cause instanceof ApiError && [404, 409].includes(cause.status)
            ? "This repository approval changed. Refresh before trying again."
            : "Could not add this repository. Try again or refresh to check your approval.",
      );
      setConfirmed({});
    } finally {
      if (pending.current === operation) {
        pending.current = null;
        setBusy(false);
      }
    }
  };
  useEffect(() => {
    adopted.current.clear();
    setBusy(false);
    setAdoptionError("");
    setAnnouncement("");
    void load();
    const online = () => {
      if (!pending.current) void load();
    };
    window.addEventListener("online", online);
    return () => {
      generation.current++;
      pending.current = null;
      window.removeEventListener("online", online);
    };
  }, [load]);
  return (
    <main id="workspace-content" className={styles.accountRepositories} tabIndex={-1}>
      <header>
        <h1>Repositories</h1>
      </header>
      <div className={styles.body}>
        <button
          type="button"
          onClick={() => {
            setAdoptionError("");
            void load();
          }}
          disabled={loading || busy}
        >
          Refresh
        </button>
        {loading ? (
          <p role="status">Loading repositories…</p>
        ) : error ? (
          <p role="alert">{error}</p>
        ) : items.length ? (
          <ul className={styles.list}>
            {items.map((item) => (
              <li key={item.projectId}>
                <div>
                  <strong>{item.name}</strong>
                  <span>{item.role}</span>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <>
            <p>No repositories belong to this account yet.</p>
            {!approvals.length && !approvalError && (
              <p>
                Ask a project owner for an invitation, or ask the operator to approve an existing
                repository for this account.
              </p>
            )}
          </>
        )}
        {!loading && approvalError && <p role="alert">{approvalError}</p>}
        {adoptionError && <p role="alert">{adoptionError}</p>}
        {announcement && <p role="status">{announcement}</p>}
        {!loading &&
          !error &&
          !!api.adoptProject &&
          approvals.map((item) => {
            const key = adoptionKey(item);
            return (
              <section
                className={styles.form}
                key={key}
                aria-label={`Approved repository ${item.name}`}
              >
                <h2>Approved repository</h2>
                <p>The operator approved this existing repository for your account.</p>
                <dl className={styles.approvalTarget}>
                  <dt>Name</dt>
                  <dd>{item.name}</dd>
                  <dt>Repository ID</dt>
                  <dd>{item.repositoryId}</dd>
                </dl>
                <label className={styles.consent}>
                  <input
                    type="checkbox"
                    checked={confirmed[key] ?? false}
                    disabled={busy}
                    onChange={(event) =>
                      setConfirmed((values) => ({ ...values, [key]: event.target.checked }))
                    }
                  />
                  I confirm adding {item.name} to this account as its owner.
                </label>
                <button
                  type="button"
                  disabled={busy || !confirmed[key]}
                  onClick={() => void adopt(item)}
                >
                  {busy ? "Adding repository…" : "Add approved repository"}
                </button>
              </section>
            );
          })}
      </div>
    </main>
  );
}
