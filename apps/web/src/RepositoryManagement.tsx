import { useEffect, useRef, useState } from "react";
import {
  ApiError,
  invitationRecipient,
  type CollaborationApi,
  type Invitation,
  type Member,
  type SharedRepository,
} from "./api";
import { canonicalRepositoryName } from "./repository-names";
import styles from "./Repositories.module.css";

/** One resource owns its drafts, ephemeral invitation link, and mutation guard. */
export function RepositoryManagement({
  api,
  item,
  deletionEnabled = false,
  onChanged,
}: {
  api: CollaborationApi;
  item: SharedRepository;
  deletionEnabled?: boolean;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [logicalName, setLogicalName] = useState(item.logicalName ?? item.repositoryName ?? "");
  const canonicalName = canonicalRepositoryName(logicalName);
  const [description, setDescription] = useState(item.description ?? "");
  const [confirmation, setConfirmation] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [recipient, setRecipient] = useState("");
  const [link, setLink] = useState<{ url: string; invitationId: string } | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [loading, setLoading] = useState(false);
  const [readError, setReadError] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [deletionUnknown, setDeletionUnknown] = useState(false);
  const [recoveryConfirmed, setRecoveryConfirmed] = useState(false);
  const [invitationUncertain, setInvitationUncertain] = useState(false);
  const sharingGeneration = useRef(0);
  const [deleting, setDeleting] = useState(item.status === "deleting");
  const generation = useRef(0);
  const pending = useRef(false);
  const current = useRef({ api, id: item.projectId, repositoryId: item.repositoryId });
  current.current = { api, id: item.projectId, repositoryId: item.repositoryId };
  const alive = (version: number) =>
    version === generation.current &&
    current.current.api === api &&
    current.current.id === item.projectId &&
    current.current.repositoryId === item.repositoryId;
  useEffect(() => {
    generation.current++;
    pending.current = false;
    setOpen(false);
    setBusy(false);
    setLink(null);
    setError("");
    setNotice("");
    setConfirmation("");
    setDeleteOpen(false);
    setLogicalName(item.logicalName ?? item.repositoryName ?? "");
    setDescription(item.description ?? "");
    setDeleting(item.status === "deleting");
    setDeletionUnknown(false);
    setRecoveryConfirmed(false);
    setInvitationUncertain(false);
    setRecipient("");
    setLoading(false);
    setReadError("");
    return () => {
      generation.current++;
      pending.current = false;
    };
  }, [
    api,
    item.projectId,
    item.repositoryId,
    item.repositoryName,
    item.logicalName,
    item.name,
    item.description,
    item.status,
  ]);
  const loadSharing = async () => {
    if (pending.current || !api.projectInvitations) return;
    const version = generation.current;
    const sharingVersion = ++sharingGeneration.current;
    setLoading(true);
    setReadError("");
    const result = await Promise.allSettled([
      api.projectMembers(item.projectId),
      api.projectInvitations(item.projectId),
    ]);
    if (!alive(version) || sharingVersion !== sharingGeneration.current) return;
    if (result.every((value) => value.status === "fulfilled")) setInvitationUncertain(false);
    setMembers(result[0].status === "fulfilled" ? result[0].value : []);
    setInvitations(result[1].status === "fulfilled" ? result[1].value : []);
    setReadError(
      result.some((value) => value.status === "rejected")
        ? "Could not load access. Refresh access to try again."
        : "",
    );
    setLoading(false);
  };
  const mutate = async (
    action: () => Promise<void>,
    failure = "Could not save this change. Refresh repositories before trying again.",
  ) => {
    if (pending.current) return;
    const version = generation.current;
    pending.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (cause) {
      if (alive(version))
        setError(
          cause instanceof ApiError &&
            ["invalid_recipient", "recipient_unavailable", "already_member"].includes(
              cause.code ?? "",
            )
            ? cause.message
            : cause instanceof ApiError && cause.code === "repository_exists"
              ? "This repository name is already used in your account. Choose another name, then save again."
              : cause instanceof ApiError && cause.status === 409
                ? "This repository changed. Refresh repositories before trying again."
                : failure,
        );
    } finally {
      if (alive(version)) {
        pending.current = false;
        setBusy(false);
      }
    }
  };
  const deletionPermission = useRef({ fresh: false, recovery: false });
  deletionPermission.current = {
    fresh:
      deletionEnabled === true &&
      item.role === "owner" &&
      item.status === "present" &&
      item.deletable,
    recovery: deletionEnabled === true && item.role === "owner" && item.status === "deleting",
  };
  const deletionAvailable = deleting
    ? deletionPermission.current.recovery
    : deletionPermission.current.fresh;
  const targetReady = !!item.repositoryName && !!item.repositoryId;
  const unavailable = busy || deleting || deletionUnknown;
  const deleteRepository = () => {
    if (
      !api.deleteRepository ||
      !(deleting ? deletionPermission.current.recovery : deletionPermission.current.fresh) ||
      !targetReady ||
      confirmation !== item.repositoryName ||
      deletionUnknown ||
      (deleting && !recoveryConfirmed)
    )
      return;
    const version = generation.current;
    void mutate(async () => {
      try {
        const result = await api.deleteRepository!(item.projectId, {
          confirmation,
          repositoryId: item.repositoryId!,
        });
        if (!alive(version)) return;
        if (
          result.projectId !== item.projectId ||
          result.repositoryName !== item.repositoryName ||
          result.repositoryId !== item.repositoryId ||
          !["deleted", "deleting"].includes(result.status)
        )
          throw new ApiError(0);
        setLink(null);
        setConfirmation("");
        setDeletionUnknown(false);
        setDeleting(result.status === "deleting");
        setRecoveryConfirmed(false);
        // Accepted deletion freezes Work immediately, even while physical removal is pending.
        onChanged();
      } catch (cause) {
        if (alive(version)) {
          setDeletionUnknown(true);
          setConfirmation("");
          setLink(null);
        }
        throw cause;
      }
    }, "The deletion result is unknown. Refresh deletion status before taking another action.");
  };
  const refreshDeletion = async () => {
    if (pending.current || !api.repositoryStatus) return;
    const version = generation.current;
    setRecoveryConfirmed(false);
    setConfirmation("");
    void mutate(async () => {
      const result = await api.repositoryStatus!(item.projectId);
      if (!alive(version)) return;
      if (
        result.projectId !== item.projectId ||
        result.repositoryName !== item.repositoryName ||
        result.repositoryId !== item.repositoryId
      )
        throw new ApiError(0);
      setDeletionUnknown(false);
      setDeleting(result.status === "deleting");
      setRecoveryConfirmed(result.status === "deleting");
      setConfirmation("");
      if (result.status === "deleted") onChanged();
      else
        setNotice(
          result.status === "deleting"
            ? "Deletion is pending. Confirm the permanent name to recover deletion for this same repository."
            : "The repository is present. Review and confirm before deleting it.",
        );
    }, "Could not check deletion status. Refresh deletion status to try again.");
  };
  const pendingInvitations = invitations.filter(
    (invite) =>
      !invite.acceptedBy && !invite.revokedAt && Date.parse(invite.expiresAt) > Date.now(),
  );
  return (
    <section className={styles.management} aria-label={`Manage ${item.name}`}>
      <button
        type="button"
        aria-expanded={open}
        disabled={busy}
        onClick={() => {
          setOpen(!open);
          setLink(null);
          if (!open && !deleting) void loadSharing();
        }}
      >
        {open ? "Close management" : "Manage repository"}
      </button>
      {open && (
        <div className={styles.form}>
          <h3>Repository settings</h3>
          <dl className={styles.approvalTarget}>
            <dt>Physical repository name (permanent)</dt>
            <dd>{item.repositoryName ?? "Unavailable"}</dd>
            <dt>Repository ID</dt>
            <dd>{item.repositoryId ?? "Unavailable"}</dd>
          </dl>
          {!targetReady && (
            <p role="alert">
              Refresh repositories to load this repository's permanent identifiers.
            </p>
          )}
          {!deleting && !deletionUnknown && (
            <>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  if (unavailable || !canonicalName || !api.updateRepository || !targetReady)
                    return;
                  const version = generation.current;
                  void mutate(async () => {
                    const result = await api.updateRepository!(item.projectId, {
                      logicalName: canonicalName,
                      displayName: canonicalName,
                      description: description.trim(),
                      expectedRevision: item.metadataRevision ?? 0,
                    });
                    if (!alive(version)) return;
                    if (
                      result.id !== item.projectId ||
                      result.repository !== `artifact:${item.repositoryName}`
                    )
                      throw new ApiError(0);
                    onChanged();
                  });
                }}
              >
                <label>
                  Repository name
                  <input
                    value={logicalName}
                    required
                    disabled={unavailable}
                    autoCapitalize="none"
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) => setLogicalName(event.target.value)}
                  />
                </label>
                <p className={styles.note}>Renaming keeps the physical identity and history.</p>
                <label>
                  Description
                  <textarea
                    value={description}
                    maxLength={1000}
                    disabled={unavailable}
                    onChange={(event) => setDescription(event.target.value)}
                  />
                </label>
                <button
                  type="submit"
                  disabled={unavailable || !canonicalName || !targetReady || !api.updateRepository}
                >
                  Save repository details
                </button>
              </form>
              <h3>Access</h3>
              <button type="button" disabled={busy || loading} onClick={() => void loadSharing()}>
                Refresh access
              </button>
              {loading && <p role="status">Loading access…</p>}
              {readError && <p role="alert">{readError}</p>}
              {!loading && !readError && (
                <>
                  <ul className={styles.list}>
                    {members.map((member) => (
                      <li key={member.actor}>
                        <div>
                          <strong>{member.username || member.displayName || member.email}</strong>
                          <span>{member.role}</span>
                        </div>
                        {member.role === "editor" && (
                          <button
                            type="button"
                            disabled={unavailable}
                            onClick={() => {
                              const version = generation.current;
                              void mutate(async () => {
                                await api.removeProjectMember(item.projectId, member.actor);
                                if (alive(version)) {
                                  setMembers((values) =>
                                    values.filter((value) => value.actor !== member.actor),
                                  );
                                  setLink(null);
                                  setNotice("Member access revoked.");
                                }
                              });
                            }}
                          >
                            Revoke member access
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (unavailable || invitationUncertain || !recipient.trim()) return;
                      const version = generation.current;
                      setLink(null);
                      void mutate(async () => {
                        let result;
                        try {
                          result = await api.inviteProject(item.projectId, recipient.trim());
                        } catch (cause) {
                          if (
                            alive(version) &&
                            !(cause instanceof ApiError && [400, 409].includes(cause.status))
                          )
                            setInvitationUncertain(true);
                          throw cause;
                        }
                        if (!alive(version)) return;
                        if (
                          !result ||
                          !/^[a-f0-9]{64}$/.test(result.token) ||
                          !result.invitation ||
                          !result.invitation.id ||
                          result.invitation.projectId !== item.projectId ||
                          result.invitation.scope !== "project" ||
                          result.invitation.role !== "editor" ||
                          (!result.invitation.recipient && !result.invitation.email) ||
                          !Number.isFinite(Date.parse(result.invitation.expiresAt))
                        ) {
                          setInvitationUncertain(true);
                          throw new ApiError(0);
                        }
                        const url = new URL(location.origin);
                        url.searchParams.set("invitation", result.token);
                        setLink({ url: url.href, invitationId: result.invitation.id });
                        setInvitations((values) => [...values, result.invitation]);
                        setRecipient("");
                        setNotice(
                          "Invitation created. Share the link with the intended recipient.",
                        );
                      }, "Could not confirm invitation creation. Refresh access before creating another invitation.");
                    }}
                  >
                    <label>
                      Username or email
                      <input
                        type="text"
                        autoComplete="off"
                        autoCapitalize="none"
                        spellCheck={false}
                        value={recipient}
                        required
                        maxLength={254}
                        disabled={unavailable}
                        onChange={(event) => setRecipient(event.target.value)}
                      />
                    </label>
                    <p className={styles.note}>Share the link yourself; no email is sent.</p>
                    <button
                      type="submit"
                      disabled={unavailable || invitationUncertain || !recipient.trim()}
                    >
                      Create invitation link
                    </button>
                  </form>
                  {invitationUncertain && (
                    <p role="alert">
                      The invitation result is unknown. Refresh access before creating another
                      invitation.
                    </p>
                  )}
                  {link && (
                    <div>
                      <label>
                        Invitation link
                        <input readOnly value={link.url} />
                      </label>
                      <p className={styles.note}>Copy this link before closing management.</p>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          const version = generation.current;
                          void navigator.clipboard
                            .writeText(link.url)
                            .then(() => {
                              if (alive(version)) setNotice("Invitation link copied.");
                            })
                            .catch(() => {
                              if (alive(version))
                                setError("Could not copy. Select and copy the invitation link.");
                            });
                        }}
                      >
                        Copy invitation link
                      </button>
                    </div>
                  )}
                  <h4>Pending invitations</h4>
                  {pendingInvitations.length ? (
                    <ul className={styles.list}>
                      {pendingInvitations.map((invite) => (
                        <li key={invite.id}>
                          <div>
                            <strong>{invitationRecipient(invite)}</strong>
                            <span>
                              {invite.scope === "thread" ? "Thread editor" : "Repository editor"} ·
                              Expires {new Date(invite.expiresAt).toLocaleString()}
                            </span>
                          </div>
                          <button
                            type="button"
                            disabled={unavailable || !api.revokeProjectInvitation}
                            onClick={() => {
                              const version = generation.current;
                              void mutate(async () => {
                                await api.revokeProjectInvitation!(item.projectId, invite.id);
                                if (alive(version)) {
                                  setInvitations((values) =>
                                    values.filter((value) => value.id !== invite.id),
                                  );
                                  setLink((value) =>
                                    value?.invitationId === invite.id ? null : value,
                                  );
                                  setNotice("Invitation revoked.");
                                }
                              });
                            }}
                          >
                            Revoke invitation
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p>No pending invitations.</p>
                  )}
                </>
              )}
            </>
          )}
          <h3>Delete repository</h3>
          {!deletionEnabled && (
            <p>
              Repository deletion is not enabled for this account. You can still refresh pending
              deletion status.
            </p>
          )}
          {deletionEnabled && !deletionAvailable && (
            <p>
              Deletion actions are unavailable for this repository. You can still refresh pending
              deletion status.
            </p>
          )}
          {!deleteOpen && !deleting && !deletionUnknown && (
            <button
              type="button"
              disabled={
                busy || !targetReady || !deletionPermission.current.fresh || !api.deleteRepository
              }
              onClick={() => {
                if (
                  pending.current ||
                  !deletionPermission.current.fresh ||
                  !targetReady ||
                  !api.deleteRepository
                )
                  return;
                setDeleteOpen(true);
                setConfirmation("");
              }}
            >
              Review deletion
            </button>
          )}
          {(deleteOpen || deleting || deletionUnknown) && (
            <div>
              <p>
                Deletion permanently removes this repository's stored files and history. Members
                lose access, and its conversations become inaccessible. The physical name cannot be
                reused. After deletion is confirmed, you can reuse the repository name for a new
                repository.
              </p>
              <p>
                Target: <strong>{item.repositoryName}</strong> · ID:{" "}
                <strong>{item.repositoryId}</strong>
              </p>
              {(deleting || deletionUnknown) && (
                <>
                  <p role="status">
                    {deletionUnknown
                      ? "Deletion outcome is unknown."
                      : "Repository deletion is pending."}
                  </p>
                  <button
                    type="button"
                    disabled={busy || !api.repositoryStatus}
                    onClick={() => void refreshDeletion()}
                  >
                    Refresh deletion status
                  </button>
                </>
              )}
              <label>
                Type the physical repository name to confirm
                <input
                  value={confirmation}
                  disabled={busy || deletionUnknown || !deletionAvailable}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => setConfirmation(event.target.value)}
                />
              </label>
              <button
                type="button"
                disabled={
                  busy ||
                  !deletionAvailable ||
                  deletionUnknown ||
                  (deleting && !recoveryConfirmed) ||
                  !targetReady ||
                  confirmation !== item.repositoryName ||
                  !api.deleteRepository
                }
                onClick={deleteRepository}
              >
                {deleting ? "Recover repository deletion" : "Permanently delete repository"}
              </button>
              {!deleting && !deletionUnknown && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setDeleteOpen(false);
                    setConfirmation("");
                  }}
                >
                  Cancel deletion
                </button>
              )}
            </div>
          )}
          {error && <p role="alert">{error}</p>}
          {notice && <p role="status">{notice}</p>}
        </div>
      )}
    </section>
  );
}
