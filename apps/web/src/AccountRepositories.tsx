import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  type ApprovedProjectAdoption,
  type CollaborationApi,
  type RepositoryCreation,
  type RepositoryCreations,
  type SharedRepository,
} from "./api";
import styles from "./Repositories.module.css";
import { RepositoryManagement } from "./RepositoryManagement";

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
  const [creations, setCreations] = useState<RepositoryCreations>({
    approval: null,
    creations: [],
  });
  const [newName, setNewName] = useState("");
  const [newDisplayName, setNewDisplayName] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [creationConsent, setCreationConsent] = useState<Record<string, boolean>>({});
  const [creationError, setCreationError] = useState("");
  const [creationReadError, setCreationReadError] = useState("");
  const [unknownCreation, setUnknownCreation] = useState<string | null>(null);
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
  const readyCreations = useRef(new Set<string>());
  const onReady = useRef(onAdopted);
  onReady.current = onAdopted;
  const currentApi = useRef(api);
  currentApi.current = api;
  const load = useCallback(async () => {
    const current = ++generation.current;
    setLoading(true);
    setConfirmed({});
    setCreationConsent({});
    const [repositories, candidates, managed] = await Promise.allSettled([
      api.repositories(),
      api.approvedProjectAdoptions?.() ?? Promise.resolve([]),
      api.repositoryCreations?.() ?? Promise.resolve({ approval: null, creations: [] }),
    ]);
    if (current !== generation.current || currentApi.current !== api) return;
    setItems(repositories.status === "fulfilled" ? repositories.value : []);
    setError(
      repositories.status === "fulfilled"
        ? ""
        : "Could not load repositories. Refresh to try again.",
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
    setCreations(
      managed.status === "fulfilled" ? managed.value : { approval: null, creations: [] },
    );
    setCreationReadError(
      managed.status === "fulfilled"
        ? ""
        : "Could not check repository creation status. Refresh to try again.",
    );
    if (managed.status === "fulfilled") {
      setUnknownCreation((name) =>
        managed.value.creations.some((item) => item.name === name) ? null : name,
      );
      const newlyReady = managed.value.creations.filter(
        (item) =>
          item.status === "ready" &&
          item.projectId &&
          item.repositoryId &&
          !readyCreations.current.has(item.projectId),
      );
      for (const item of newlyReady) readyCreations.current.add(item.projectId!);
      if (newlyReady.length) onReady.current?.();
    }
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
      if (currentApi.current !== api) return;
      // Existing adoption refreshes Work even when navigation closes this directory.
      onAdopted?.();
      if (pending.current !== operation) return;
      adopted.current.add(adoptionKey(item));
      setApprovals((items) =>
        items.filter((candidate) => adoptionKey(candidate) !== adoptionKey(item)),
      );
      setAnnouncement(`${item.name} was added to your repositories.`);
      await load();
    } catch (cause) {
      if (pending.current !== operation || currentApi.current !== api) return;
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
  const create = async (name: string, recovery?: RepositoryCreation) => {
    if (
      pending.current ||
      loading ||
      creationError ||
      !creationConsent[name] ||
      !api.createRepository
    )
      return;
    if (recovery) {
      if (!["cleanup_required", "registration_required"].includes(recovery.status)) return;
    } else if (
      (!creations.capabilities?.create && creations.approval?.name !== name) ||
      (creations.capabilities?.create && !/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) ||
      !!unknownCreation ||
      creations.creations.some((item) => item.name === name)
    )
      return;
    const operation = {};
    pending.current = operation;
    setBusy(true);
    setCreationError("");
    setAnnouncement("");
    try {
      const result = await (creations.capabilities?.create && !recovery
        ? api.createRepository(name, true, {
            displayName: newDisplayName.trim() || name,
            description: newDescription.trim(),
          })
        : api.createRepository(name, true));
      if (pending.current !== operation || currentApi.current !== api) return;
      if (
        result.name !== name ||
        (recovery?.repositoryId && result.repositoryId !== recovery.repositoryId) ||
        (result.status === "ready" && (!result.projectId || !result.repositoryId))
      )
        throw new ApiError(0);
      setUnknownCreation(null);
      setNewName("");
      setNewDisplayName("");
      setNewDescription("");
      setCreationConsent({});
      setCreations((value) => ({
        ...value,
        creations: [...value.creations.filter((item) => item.name !== name), result],
      }));
      if (result.status === "ready") {
        readyCreations.current.add(result.projectId!);
        onReady.current?.();
        setAnnouncement(`${name} is ready in your repositories.`);
        await load();
      }
    } catch (cause) {
      if (pending.current !== operation || currentApi.current !== api) return;
      setCreationConsent({});
      if (cause instanceof ApiError && [400, 401, 403, 404, 409].includes(cause.status)) {
        setCreationError(
          creations.capabilities?.create
            ? "Could not create this repository. Check the name and refresh repositories before trying again."
            : "Repository creation approval is unavailable or changed. Refresh, or ask the operator to check this account's approval.",
        );
      } else {
        setUnknownCreation(name);
        setCreationError(
          "The creation result is unknown. Refresh to check its status, or ask the operator to investigate before retrying.",
        );
      }
    } finally {
      if (pending.current === operation) {
        pending.current = null;
        setBusy(false);
      }
    }
  };
  useEffect(() => {
    adopted.current.clear();
    readyCreations.current.clear();
    setBusy(false);
    setAdoptionError("");
    setCreationError("");
    setUnknownCreation(null);
    setAnnouncement("");
    setNewName("");
    setNewDisplayName("");
    setNewDescription("");
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
            setCreationError("");
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
                  {item.repositoryName && <span>Permanent name: {item.repositoryName}</span>}
                  {item.description && <p>{item.description}</p>}
                  {item.status === "deleting" && <span>Deletion pending</span>}
                </div>
                {creations.capabilities?.manage && item.role === "owner" && (
                  <RepositoryManagement
                    api={api}
                    item={item}
                    deletionEnabled={creations.capabilities.delete === true}
                    onChanged={() => {
                      onReady.current?.();
                      void load();
                    }}
                  />
                )}
              </li>
            ))}
          </ul>
        ) : (
          <>
            <p>No repositories belong to this account yet.</p>
            {!approvals.length &&
              !approvalError &&
              !creations.approval &&
              !creations.creations.length &&
              !creationReadError && (
                <p>
                  {creations.capabilities?.create
                    ? "Create your first repository below, or ask a repository owner for an invitation."
                    : "Ask a project owner for an invitation, or ask the operator to approve an existing repository for this account."}
                </p>
              )}
          </>
        )}
        {!loading && approvalError && <p role="alert">{approvalError}</p>}
        {!loading && creationReadError && <p role="alert">{creationReadError}</p>}
        {creationError && <p role="alert">{creationError}</p>}
        {adoptionError && <p role="alert">{adoptionError}</p>}
        {announcement && <p role="status">{announcement}</p>}
        {!loading && unknownCreation && !creationError && (
          <p role="status">
            The creation result for {unknownCreation} is unknown. Refresh to check its status, or
            ask the operator to investigate.
          </p>
        )}
        {!loading && !creationReadError && !!api.createRepository && (
          <>
            {creations.capabilities?.create && (
              <form
                className={styles.form}
                aria-label="Create repository"
                onSubmit={(event) => {
                  event.preventDefault();
                  void create(newName);
                }}
              >
                <h2>Create empty repository</h2>
                <label>
                  Permanent repository name
                  <input
                    value={newName}
                    required
                    pattern={"[a-z0-9][a-z0-9\\-]{0,62}"}
                    maxLength={63}
                    autoCapitalize="none"
                    autoComplete="off"
                    spellCheck={false}
                    disabled={busy || !!error || !!creationError}
                    onChange={(event) => {
                      setNewName(event.target.value);
                      setCreationConsent({});
                    }}
                  />
                </label>
                <p className={styles.note}>
                  Use 1–63 lowercase letters, numbers or hyphens, starting with a letter or number.
                  This name is permanent.
                </p>
                <label>
                  Display name (optional)
                  <input
                    value={newDisplayName}
                    maxLength={80}
                    disabled={busy || !!error || !!creationError}
                    onChange={(event) => setNewDisplayName(event.target.value)}
                  />
                </label>
                <label>
                  Description (optional)
                  <textarea
                    value={newDescription}
                    maxLength={1000}
                    disabled={busy || !!error || !!creationError}
                    onChange={(event) => setNewDescription(event.target.value)}
                  />
                </label>
                <p>
                  This creates no code, threads, or invitations. Your account owns the repository.
                </p>
                <p>
                  Cloudflare repository storage and operations can incur charges under the account's
                  plan.
                </p>
                <label className={styles.consent}>
                  <input
                    type="checkbox"
                    checked={creationConsent[newName] ?? false}
                    disabled={busy || !!error || !!creationError}
                    onChange={(event) => setCreationConsent({ [newName]: event.target.checked })}
                  />
                  I consent to storing this empty repository in Cloudflare and to Cloudflare issuing
                  a temporary Git token that is discarded and revoked before repository access is
                  enabled.
                </label>
                <button
                  type="submit"
                  disabled={
                    busy ||
                    !!error ||
                    !!creationError ||
                    !creationConsent[newName] ||
                    !/^[a-z0-9][a-z0-9-]{0,62}$/.test(newName) ||
                    !!unknownCreation ||
                    creations.creations.some((item) => item.name === newName)
                  }
                >
                  {busy ? "Creating repository…" : "Create empty repository"}
                </button>
              </form>
            )}
            {!creations.capabilities?.create &&
              creations.approval &&
              !creations.creations.some((item) => item.name === creations.approval?.name) &&
              unknownCreation !== creations.approval.name && (
                <section
                  className={styles.form}
                  aria-label={`Approved empty repository ${creations.approval.name}`}
                >
                  <h2>Create approved empty repository</h2>
                  <p>
                    The operator approved {creations.approval.name} for this account. Your account
                    will own this empty repository.
                  </p>
                  <p>This creates no code, threads, or invitations.</p>
                  <p>
                    Cloudflare repository storage and operations can incur charges under the
                    account's plan.
                  </p>
                  <label className={styles.consent}>
                    <input
                      type="checkbox"
                      checked={creationConsent[creations.approval.name] ?? false}
                      disabled={busy || !!error || !!creationError}
                      onChange={(event) =>
                        setCreationConsent({ [creations.approval!.name]: event.target.checked })
                      }
                    />
                    I consent to storing this empty repository in Cloudflare and to Cloudflare
                    issuing a temporary Git token that is discarded and revoked before repository
                    access is enabled.
                  </label>
                  <button
                    type="button"
                    disabled={
                      busy ||
                      !!error ||
                      !!creationError ||
                      !creationConsent[creations.approval.name]
                    }
                    onClick={() => void create(creations.approval!.name)}
                  >
                    {busy ? "Creating repository…" : "Create empty repository"}
                  </button>
                </section>
              )}
            {creations.creations
              .filter((item) => !creations.capabilities?.create || item.status !== "ready")
              .map((item) => (
                <section
                  className={styles.form}
                  key={item.name}
                  aria-label={`Repository creation ${item.name}`}
                >
                  <h2>{item.name}</h2>
                  <p>
                    {item.status === "ready"
                      ? "This repository is ready and registered to this account."
                      : item.status === "pending"
                        ? "Creation is pending or its result is unknown. Refresh to check its status, or ask the operator to investigate."
                        : item.status === "deleting"
                          ? "This repository is being deleted. Use its management controls to refresh deletion status. Its permanent name cannot be reused."
                          : item.status === "deleted"
                            ? "This repository was deleted. Its permanent name is retired and cannot be reused."
                            : item.status === "cleanup_required"
                              ? "The repository needs temporary credential cleanup before access is enabled."
                              : "The repository needs registration to this account before access is enabled."}
                  </p>
                  {["cleanup_required", "registration_required"].includes(item.status) && (
                    <>
                      <label className={styles.consent}>
                        <input
                          type="checkbox"
                          checked={creationConsent[item.name] ?? false}
                          disabled={
                            busy || !!error || !!creationError || unknownCreation === item.name
                          }
                          onChange={(event) =>
                            setCreationConsent((values) => ({
                              ...values,
                              [item.name]: event.target.checked,
                            }))
                          }
                        />
                        I consent to completing credential cleanup and account registration for this
                        same empty repository. Any Cloudflare-issued temporary Git token must be
                        discarded and revoked before access is enabled.
                      </label>
                      <button
                        type="button"
                        disabled={
                          busy ||
                          !!error ||
                          !!creationError ||
                          unknownCreation === item.name ||
                          !creationConsent[item.name]
                        }
                        onClick={() => void create(item.name, item)}
                      >
                        {busy ? "Recovering repository…" : "Recover repository creation"}
                      </button>
                    </>
                  )}
                </section>
              ))}
          </>
        )}
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
