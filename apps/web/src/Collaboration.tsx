import { useCallback, useEffect, useRef, useState } from "react";
import type { Account, CollaborationApi, CreatedInvitation, InvitationPreview, Member } from "./api";
import { ApiError } from "./api";
import type { AuthUser } from "./auth-api";
import styles from "./Collaboration.module.css";

const problem = (cause: unknown) =>
  cause instanceof Error ? cause.message : "Could not load sharing. Try again.";

export function AccountSummary({ api, viewer, onSignOut }: {
  api?: CollaborationApi; viewer?: AuthUser; onSignOut?: () => Promise<void>;
}) {
  const [account, setAccount] = useState<Account>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!api) return;
    let active = true;
    api.account().then((value) => {
      if (active) setAccount(value);
    }).catch((cause) => {
      if (active) setError(problem(cause));
    });
    return () => { active = false; };
  }, [api]);
  if (!api) return null;
  return (
    <section className={styles.account} aria-label="Account">
      <h2>Account</h2>
      {account ? <p><strong>{viewer?.username || viewer?.name || account.email}</strong><br />{account.email}</p> : error ?
        <p role="alert">{error}</p> : <p role="status">Checking account…</p>}
      {onSignOut && <button type="button" disabled={busy} onClick={() => {
        setBusy(true); setError("");
        void onSignOut().catch(() => setError("Could not sign out. Try again."))
          .finally(() => setBusy(false));
      }}>Sign out</button>}
      {account && error && <p role="alert">{error}</p>}
    </section>
  );
}

export function InvitationGate({
  api,
  onAccepted,
  manual = false,
  fromUrl = true,
}: {
  api?: CollaborationApi;
  onAccepted: (invitation: InvitationPreview) => void;
  manual?: boolean;
  fromUrl?: boolean;
}) {
  const [token, setToken] = useState(() => fromUrl ? new URLSearchParams(location.search).get("invitation") ?? "" : "");
  const [draft, setDraft] = useState("");
  const [preview, setPreview] = useState<InvitationPreview>();
  const [loading, setLoading] = useState(!!token);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!fromUrl || !token) return;
    const url = new URL(location.href);
    url.searchParams.delete("invitation");
    history.replaceState(null, "", url);
  }, [fromUrl, token]);
  useEffect(() => {
    if (!token || !api) return;
    let active = true;
    api.invitation(token).then((value) => {
      if (active) { setPreview(value); setError(""); }
    }).catch((cause) => {
      if (active) setError(problem(cause));
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [api, token]);
  if (!api || (!token && !manual)) return null;
  const clear = () => {
    setToken("");
    setDraft("");
    setPreview(undefined);
    setError("");
  };
  const accept = async () => {
    if (!preview || busy) return;
    setBusy(true);
    setError("");
    try {
      await api.acceptInvitation(token);
      clear();
      onAccepted(preview);
    } catch (cause) {
      setError(problem(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className={manual ? styles.manualInvitation : styles.invitation} aria-label="Invitation">
      <div>
        <h2>Join shared work</h2>
        {manual && !token && <form onSubmit={(event) => {
          event.preventDefault();
          const code = draft.trim().toLowerCase();
          if (!/^[a-f0-9]{64}$/.test(code)) {
            setError("Enter the 64-character invite code.");
            return;
          }
          setError("");
          setLoading(true);
          setToken(code);
        }} className={styles.codeForm}>
          <label htmlFor="join-code">Invite code</label>
          <input id="join-code" value={draft} onChange={(event) => setDraft(event.target.value)}
            autoComplete="off" spellCheck={false} maxLength={64} />
          <button type="submit" disabled={!draft.trim()}>Check invitation</button>
        </form>}
        {loading && token ? <p role="status">Checking invitation…</p> : preview ? (
          <p>{preview.scope === "thread" ? "Thread" : "Repository"} invitation for {preview.email}.</p>
        ) : token ? <p>This invitation is unavailable.</p> : null}
        {error && <p role="alert">{error}</p>}
      </div>
      {token && <div className={styles.actions}>
        <button type="button" disabled={!preview || busy} onClick={() => void accept()}>
          {busy ? "Joining…" : "Accept invitation"}
        </button>
        <button type="button" onClick={clear} disabled={busy}>Dismiss</button>
      </div>}
    </section>
  );
}

export function Collaborators({
  api,
  projectId,
  threadId,
  onAccessLost,
}: {
  api?: CollaborationApi;
  projectId: string;
  threadId: string;
  onAccessLost: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [account, setAccount] = useState<Account>();
  const [projectMembers, setProjectMembers] = useState<Member[]>([]);
  const [threadMembers, setThreadMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [email, setEmail] = useState("");
  const [scope, setScope] = useState<"project" | "thread">("project");
  const [invitation, setInvitation] = useState<CreatedInvitation>();
  const requestGeneration = useRef(0);
  const trigger = useRef<HTMLButtonElement>(null);
  const load = useCallback(async (foreground = false) => {
    if (!api || !projectId) return;
    const generation = ++requestGeneration.current;
    if (foreground) setLoading(true);
    try {
      const [identity, project, thread] = await Promise.all([
        api.account(), api.projectMembers(projectId),
        threadId ? api.threadMembers(threadId) : Promise.resolve([]),
      ]);
      if (generation === requestGeneration.current) {
        setAccount(identity);
        setProjectMembers(project);
        setThreadMembers(thread);
        if (!project.some((member) => member.actor === identity.actor && member.role === "owner") &&
            thread.some((member) => member.actor === identity.actor && member.role === "owner"))
          setScope("thread");
        setError("");
      }
    } catch (cause) {
      if (generation === requestGeneration.current) {
        if (cause instanceof ApiError && [401, 403, 404].includes(cause.status)) onAccessLost();
        else setError(problem(cause));
      }
    } finally {
      if (foreground && generation === requestGeneration.current) setLoading(false);
    }
  }, [api, projectId, threadId, onAccessLost]);
  useEffect(() => {
    setProjectMembers([]);
    setThreadMembers([]);
    setInvitation(undefined);
    setScope("project");
    setError("");
    setLoading(true);
    void load(true);
    const interval = window.setInterval(() => { if (!document.hidden) void load(); }, 10000);
    const online = () => void load(true);
    window.addEventListener("online", online);
    return () => {
      requestGeneration.current++;
      window.clearInterval(interval);
      window.removeEventListener("online", online);
    };
  }, [load]);
  if (!api || !projectId) return null;
  const projectOwner = projectMembers.some((member) => member.actor === account?.actor && member.role === "owner");
  const threadOwner = threadMembers.some((member) => member.actor === account?.actor && member.role === "owner");
  const canInvite = projectOwner || threadOwner;
  const makeInvite = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy || (scope === "project" ? !projectOwner : !(projectOwner || threadOwner))) return;
    setBusy(true);
    setError("");
    setNotice("");
    setInvitation(undefined);
    try {
      const next = scope === "project"
        ? await api.inviteProject(projectId, email.trim())
        : await api.inviteThread(threadId, email.trim());
      setInvitation(next);
      setNotice("Invite link ready. Send it to the intended recipient.");
    } catch (cause) {
      setError(problem(cause));
    } finally { setBusy(false); }
  };
  const remove = async (kind: "project" | "thread", member: Member) => {
    if (busy || (kind === "project" ? !projectOwner : !(projectOwner || threadOwner)) ||
        member.actor === account?.actor) return;
    setBusy(true);
    setError("");
    try {
      if (kind === "project") await api.removeProjectMember(projectId, member.actor);
      else await api.removeThreadMember(threadId, member.actor);
      setNotice(`${member.email} removed from ${kind === "project" ? "repository" : "thread"}.`);
      await load();
    } catch (cause) { setError(problem(cause)); }
    finally { setBusy(false); }
  };
  const code = invitation?.token ?? "";
  return (
    <div className={styles.sharing}>
      <button ref={trigger} type="button" aria-expanded={open} aria-controls="collaboration-panel" onClick={() => setOpen(!open)}>
        Share{threadMembers.length > 1 ? ` · ${threadMembers.length}` : ""}
      </button>
      {open && <section id="collaboration-panel" className={styles.panel} aria-label="Sharing"
        onKeyDown={(event) => { if (event.key === "Escape") { setOpen(false); trigger.current?.focus(); } }}>
        <div className={styles.heading}>
          <h2>People</h2>
          <div className={styles.actions}>
            <button type="button" onClick={() => void load(true)} disabled={busy || loading}>Refresh</button>
            <button type="button" onClick={() => { setOpen(false); trigger.current?.focus(); }}>Close</button>
          </div>
        </div>
        {loading ? <p role="status">Loading people…</p> : <>
          {error && <p role="alert">{error}</p>}
          {notice && <p role="status">{notice}</p>}
          <MemberList title="Repository" members={projectMembers} account={account} owner={projectOwner}
            busy={busy} onRemove={(member) => void remove("project", member)} />
          {threadId && <MemberList title="Thread" members={threadMembers} account={account} owner={projectOwner || threadOwner}
            busy={busy} onRemove={(member) => void remove("thread", member)} />}
          {canInvite && <form onSubmit={(event) => void makeInvite(event)} className={styles.form}>
            <h3>Invite a person</h3>
            <label htmlFor="invite-scope">Access</label>
            <select id="invite-scope" value={scope} onChange={(event) => {
              setScope(event.target.value as "project" | "thread"); setInvitation(undefined);
            }}>
              {projectOwner && <option value="project">Repository</option>}
              {threadId && <option value="thread">This thread</option>}
            </select>
            <label htmlFor="invite-email">Email</label>
            <input id="invite-email" type="email" required value={email} onChange={(event) => setEmail(event.target.value)}
              autoComplete="email" disabled={busy} />
            {scope === "thread" && <small>Invite them to the repository first.</small>}
            <button type="submit" disabled={busy || !email.trim()}>Create invite link</button>
          </form>}
          {code && <div className={styles.link}>
            <label htmlFor="invite-code">Invite code for {invitation?.invitation.email}</label>
            <input id="invite-code" readOnly value={code} onFocus={(event) => event.target.select()} />
            <small>They can enter this code in Profile on their own Pitcrew.</small>
            <div className={styles.actions}>
              <button type="button" onClick={() => {
                if (!navigator.clipboard?.writeText) { setError("Select and copy the code above."); return; }
                void navigator.clipboard.writeText(code).then(() => setNotice("Code copied."))
                  .catch(() => setError("Select and copy the code above."));
              }}>Copy code</button>
              <button type="button" disabled={busy} onClick={() => {
                if (!invitation) return;
                setBusy(true);
                void api.revokeInvitation(invitation.token).then(() => {
                  setInvitation(undefined); setNotice("Invite link revoked.");
                }).catch((cause) => setError(problem(cause))).finally(() => setBusy(false));
              }}>Revoke code</button>
            </div>
          </div>}
        </>}
      </section>}
    </div>
  );
}

function MemberList({ title, members, account, owner, busy, onRemove }: {
  title: string; members: Member[]; account?: Account; owner: boolean; busy: boolean;
  onRemove: (member: Member) => void;
}) {
  return <section className={styles.members} aria-label={`${title} members`}>
    <h3>{title}</h3>
    {members.length ? <ul>{members.map((member) => <li key={member.actor}>
      <span>{member.email}{member.actor === account?.actor ? " (you)" : ""} · {member.role}</span>
      {owner && member.actor !== account?.actor && <button type="button" disabled={busy}
        aria-label={`Remove ${member.email} from ${title.toLowerCase()}`} onClick={() => onRemove(member)}>Remove</button>}
    </li>)}</ul> : <p>No members shown.</p>}
  </section>;
}
