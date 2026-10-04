import { useCallback, useEffect, useRef, useState } from "react";
import type { Api, Project, Run, Snapshot, Thread } from "./api";
import "./styles.css";
import { LandingControl, type LandingState } from "./LandingControl";
const empty: Snapshot = { messages: [], runs: [], reviews: [], evidence: [] };
const labels: Record<Run["status"], string> = {
  queued: "Queued",
  running: "Worker running",
  awaiting_review: "Awaiting review",
  waiting_user: "Needs your attention",
  completed: "Completed",
  failed: "Failed",
  stopped: "Stopped",
};
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "Something went wrong. Try again.";
export function App({ api, demo = false }: { api: Api; demo?: boolean }) {
  const [landingEnabled, setLandingEnabled] = useState(false);
  const [landingStates, setLandingStates] = useState<Record<string, LandingState>>({});
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState("");
  const [threads, setThreads] = useState<Thread[]>([]);
  const [threadId, setThreadId] = useState("");
  const [snapshot, setSnapshot] = useState<Snapshot>(empty);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [title, setTitle] = useState("");
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [connection, setConnection] = useState("Connecting");
  const [announcement, setAnnouncement] = useState("");
  const [revision, setRevision] = useState(0);
  const generation = useRef(0);
  const pending = useRef<{ threadId: string; content: string; key: string } | null>(null);
  const createKey = useRef<{ projectId: string; title: string; key: string } | null>(null);
  const mutation = useRef(false);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLandingEnabled(false);
    api
      .capabilities()
      .then((capabilities) => {
        if (!cancelled)
          setLandingEnabled(
            capabilities.landing.enabled && capabilities.landing.backend === "fixture",
          );
      })
      .catch(() => {
        if (!cancelled) setLandingEnabled(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api, revision]);
  useEffect(() => {
    let cancelled = false;
    api
      .projects()
      .then((items) => {
        if (!cancelled) {
          setProjects(items);
          setProjectId((id) => (items.some((item) => item.id === id) ? id : (items[0]?.id ?? "")));
          setLoading(false);
          setConnection("Connected");
          setError("");
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(errorText(cause));
          setConnection("Disconnected");
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [api, revision]);
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    setLoading(true);
    api
      .threads(projectId)
      .then((items) => {
        if (!cancelled) {
          setThreads(items);
          setThreadId((id) => (items.some((item) => item.id === id) ? id : (items[0]?.id ?? "")));
          setLoading(false);
          setError("");
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(errorText(cause));
          setLoading(false);
          setConnection("Disconnected");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [api, projectId, revision]);
  useEffect(() => {
    const current = ++generation.current;
    if (!threadId) {
      setSnapshot(empty);
      return;
    }
    let cancelled = false;
    let requestSequence = 0;
    let inFlight = false;
    setSnapshot(empty);
    setLoading(true);
    setError("");
    const load = async () => {
      if (inFlight) return;
      inFlight = true;
      const sequence = ++requestSequence;
      try {
        const next = await api.snapshot(threadId);
        if (!cancelled && current === generation.current && sequence === requestSequence) {
          setSnapshot(next);
          setLoading(false);
          setConnection("Connected");
          setError("");
        }
      } catch (cause) {
        if (!cancelled && current === generation.current && sequence === requestSequence) {
          setError(errorText(cause));
          setLoading(false);
          setConnection("Disconnected");
        }
      } finally {
        inFlight = false;
      }
    };
    void load();
    // Poll snapshots, never replay writes after an uncertain response.
    const timer = window.setInterval(() => {
      if (!document.hidden) void load();
    }, 5000);
    const onOnline = () => {
      void load();
    };
    const onOffline = () => setConnection("Offline");
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, [api, threadId, revision]);

  async function send(event: React.FormEvent) {
    event.preventDefault();
    const content = (drafts[threadId] ?? "").trim();
    if (!content || mutation.current || loading || !threadId) return;
    const selected = threadId;
    const selectedGeneration = generation.current;
    if (
      !pending.current ||
      pending.current.threadId !== selected ||
      pending.current.content !== content
    )
      pending.current = { threadId: selected, content, key: crypto.randomUUID() };
    mutation.current = true;
    setBusy(true);
    setError("");
    try {
      await api.send(selected, content, pending.current.key);
      pending.current = null;
      setDrafts((all) => ({ ...all, [selected]: "" }));
      setAnnouncement("Message sent and change queued.");
      const next = await api.snapshot(selected);
      if (selectedGeneration === generation.current) setSnapshot(next);
    } catch (cause) {
      if (selectedGeneration === generation.current) setError(errorText(cause));
    } finally {
      mutation.current = false;
      setBusy(false);
    }
  }
  async function addThread(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = title.trim();
    if (!trimmed || mutation.current || !projectId) return;
    const selected = projectId;
    if (
      !createKey.current ||
      createKey.current.projectId !== selected ||
      createKey.current.title !== trimmed
    )
      createKey.current = { projectId: selected, title: trimmed, key: crypto.randomUUID() };
    mutation.current = true;
    setBusy(true);
    setError("");
    try {
      const thread = await api.createThread(selected, trimmed, createKey.current.key);
      createKey.current = null;
      setTitle("");
      setCreating(false);
      setThreads((items) =>
        items.some((item) => item.id === thread.id) ? items : [...items, thread],
      );
      setThreadId(thread.id);
      setAnnouncement("Thread created.");
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      mutation.current = false;
      setBusy(false);
    }
  }
  const project = projects.find((item) => item.id === projectId);
  const thread = threads.find((item) => item.id === threadId);
  const latest = snapshot.runs.at(-1);
  return (
    <div className="shell">
      <a className="skip" href="#conversation">
        Skip to conversation
      </a>
      <aside className="sidebar" aria-label="Projects and threads">
        <div className="brand">
          <span className="brand-icon" aria-hidden="true">
            P
          </span>
          <strong>Pitcrew</strong>
          <span className="private">Private PoC</span>
        </div>
        <div className="section-label">Projects</div>
        <nav aria-label="Projects">
          {projects.map((item) => (
            <button
              key={item.id}
              className={`project ${item.id === projectId ? "selected" : ""}`}
              aria-label={`${item.name} · ${item.repository}`}
              aria-current={item.id === projectId ? "page" : undefined}
              disabled={busy}
              onClick={() => {
                if (item.id === projectId) return;
                setProjectId(item.id);
                setThreads([]);
                setThreadId("");
                setSnapshot(empty);
                setCreating(false);
              }}
            >
              <span className="project-icon" aria-hidden="true">
                {item.name.slice(0, 1)}
              </span>
              <span>
                {item.name}
                <small>{item.repository}</small>
              </span>
            </button>
          ))}
        </nav>
        <div className="thread-heading">
          <span className="section-label">Threads</span>
          <button
            aria-label="Create thread"
            disabled={!projectId || busy}
            onClick={() => setCreating((value) => !value)}
          >
            +
          </button>
        </div>
        {creating && (
          <form className="new-thread" onSubmit={addThread}>
            <label htmlFor="thread-title">Thread title</label>
            <input
              id="thread-title"
              autoFocus
              maxLength={160}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              required
              disabled={busy}
            />
            <button type="submit" disabled={busy || !title.trim()}>
              Create
            </button>
            <button type="button" disabled={busy} onClick={() => setCreating(false)}>
              Cancel
            </button>
          </form>
        )}
        <nav aria-label="Threads">
          {threads.map((item) => (
            <button
              key={item.id}
              className={`thread ${item.id === threadId ? "selected" : ""}`}
              aria-current={item.id === threadId ? "page" : undefined}
              onClick={() => setThreadId(item.id)}
            >
              <span aria-hidden="true">#</span>
              {item.title}
            </button>
          ))}
        </nav>
        {!loading && projectId && !threads.length && (
          <p className="hint">No threads yet. Create one to start a change.</p>
        )}
        <div className="sidebar-footer">
          <span
            className={`connection ${connection === "Connected" ? "online" : ""}`}
            aria-hidden="true"
          />
          {connection}
          <button onClick={refresh} disabled={busy} aria-label="Reconnect and refresh">
            ↻
          </button>
        </div>
      </aside>
      <main id="conversation" className="conversation" tabIndex={-1}>
        <header className="conversation-header">
          <div>
            <p className="eyebrow">{project?.name ?? "Workspace"} / Change thread</p>
            <h1>{thread?.title ?? "Your project conversations"}</h1>
          </div>
          {latest && <span className={`status ${latest.status}`}>{labels[latest.status]}</span>}
        </header>
        {demo && (
          <div className="demo-banner">
            Synthetic preview · No cloud execution, model calls, or repository changes.
          </div>
        )}
        {error && (
          <div role="alert" className="error">
            <span>{error}</span>
            <button onClick={refresh} disabled={busy}>
              Retry connection
            </button>
          </div>
        )}
        <div
          className="transcript"
          role="log"
          aria-label="Conversation transcript"
          aria-busy={loading}
        >
          {loading ? (
            <p className="empty">Loading conversation…</p>
          ) : !thread ? (
            <div className="empty">
              <h2>A place for every change</h2>
              <p>Select a project and create a thread to work with your crew.</p>
            </div>
          ) : !snapshot.messages.length ? (
            <div className="empty">
              <h2>Start with the outcome</h2>
              <p>
                Describe what you want changed. Your repository agent will coordinate a separate
                worker and reviewer.
              </p>
            </div>
          ) : (
            snapshot.messages.map((message) => (
              <article className={`message ${message.role}`} key={message.id}>
                <div className="avatar" aria-hidden="true">
                  {message.role === "user" ? "Y" : message.role.slice(0, 1).toUpperCase()}
                </div>
                <div className="message-body">
                  <div className="message-meta">
                    <strong>
                      {message.role === "user"
                        ? "You"
                        : message.role === "coordinator"
                          ? "Repository agent"
                          : message.role === "worker"
                            ? "Change worker"
                            : "Reviewer"}
                    </strong>
                    <span className="role-label">{message.role}</span>
                    <time dateTime={message.createdAt}>
                      {new Date(message.createdAt).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </time>
                  </div>
                  <p>{message.content}</p>
                </div>
              </article>
            ))
          )}
        </div>
        <form className="composer" onSubmit={send}>
          <label htmlFor="message">Message your crew</label>
          <textarea
            id="message"
            placeholder="Describe a change or ask about the work…"
            maxLength={8000}
            rows={3}
            value={drafts[threadId] ?? ""}
            disabled={!threadId || busy}
            onChange={(event) => setDrafts((all) => ({ ...all, [threadId]: event.target.value }))}
          />
          <div className="composer-footer">
            <span>Work runs in isolated cloud sandboxes.</span>
            <button
              type="submit"
              disabled={!threadId || busy || loading || !(drafts[threadId] ?? "").trim()}
            >
              {busy ? "Sending…" : "Send message"}
              <span aria-hidden="true"> ↑</span>
            </button>
          </div>
        </form>
        <p className="sr-only" role="status">
          {announcement}
        </p>
      </main>
      <aside className="evidence" aria-label="Change evidence">
        <div className="evidence-heading">
          <h2>Change evidence</h2>
          <span>{snapshot.runs.length} runs</span>
        </div>
        {!snapshot.runs.length && (
          <p className="hint">
            Worker activity, tests, and trusted reviews will appear here when a change runs.
          </p>
        )}
        {[...snapshot.runs].reverse().map((run) => {
          const evidence = snapshot.evidence.find((item) => item.run.id === run.id);
          const reviews = snapshot.reviews.filter((item) => item.runId === run.id);
          return (
            <section className="run-card" key={run.id}>
              <div className="run-title">
                <strong>{run.workerId ? `Worker ${run.workerId}` : "Change run"}</strong>
                <span className={`status ${run.status}`}>{labels[run.status]}</span>
              </div>
              <p className="run-id">{run.id}</p>
              {run.error && (
                <p className="run-error">
                  {run.error === "reconciliation_required"
                    ? "Execution needs reconciliation before another attempt. No work has been replayed."
                    : run.error === "execution_unavailable"
                      ? "Cloud execution is unavailable."
                      : "Execution failed. Inspect the evidence before trying a new change."}
                </p>
              )}
              <dl>
                <dt>Base</dt>
                <dd>
                  <code>{run.baseSha}</code>
                </dd>
                <dt>Candidate</dt>
                <dd>
                  <code>{run.candidateSha ?? "Not available yet"}</code>
                </dd>
                <dt>Configuration</dt>
                <dd>{run.configurationRevision}</dd>
                {run.artifactId && (
                  <>
                    <dt>Artifacts fork</dt>
                    <dd>{run.artifactId}</dd>
                  </>
                )}
              </dl>
              <details>
                <summary>Tests and tool output</summary>
                {evidence?.tests ? (
                  <>
                    <p className={`test-result ${evidence.tests.status}`}>
                      Tests {evidence.tests.status.replace("_", " ")} · exit{" "}
                      {evidence.tests.exitCode ?? "unavailable"}
                    </p>
                    <p>
                      {evidence.tests.baseSha === run.baseSha &&
                      evidence.tests.candidateSha === run.candidateSha &&
                      evidence.tests.configurationRevision === run.configurationRevision
                        ? "Tests match current candidate"
                        : "Stale test evidence — inspect exact hashes"}
                    </p>
                    <code>{evidence.tests.candidateSha}</code>
                    <br />
                    <code>{evidence.tests.argv.join(" ")}</code>
                    <pre>
                      {evidence.tests.stdout || "No stdout recorded."}
                      {evidence.tests.stderr && `\n${evidence.tests.stderr}`}
                    </pre>
                    {evidence.tests.truncated && <p>Output was truncated.</p>}
                  </>
                ) : (
                  <p className="hint">No structured test evidence recorded.</p>
                )}
              </details>
              <details open={reviews.length > 0}>
                <summary>Review evidence ({reviews.length})</summary>
                {reviews.length ? (
                  reviews.map((review) => (
                    <div className="review" key={review.id}>
                      <strong>
                        {review.decision === "approve" ? "Approved candidate" : "Changes requested"}
                      </strong>
                      <p>{review.summary}</p>
                      <small>
                        {review.actor} ·{" "}
                        {review.candidateSha === run.candidateSha &&
                        review.baseSha === run.baseSha &&
                        review.configurationRevision === run.configurationRevision
                          ? "Matches current candidate"
                          : "Stale evidence — inspect exact hashes"}
                      </small>
                    </div>
                  ))
                ) : (
                  <p className="hint">Awaiting a trusted reviewer.</p>
                )}
              </details>
              <LandingControl
                api={api}
                run={run}
                evidence={evidence}
                reviews={reviews}
                enabled={landingEnabled}
                state={landingStates[run.id]}
                onStateChange={(state) =>
                  setLandingStates((states) => ({ ...states, [run.id]: state }))
                }
              />
            </section>
          );
        })}
      </aside>
    </div>
  );
}
