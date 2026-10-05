import { NavigationRail, WorkspacePlaceholder, type WorkspaceSection } from "./NavigationRail";
import shellStyles from "./NavigationRail.module.css";
import { Sidebar } from "./Sidebar";
import { Intake } from "./Intake";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Api, Project, Run, Snapshot, Thread, LandingCapabilities } from "./api";
import "./styles.css";
import { LandingControl, type LandingState } from "./LandingControl";
import { Workspace, WorkspaceResize, workspaceStyle } from "./Workspace";
import { Composer, readAttachment, attachmentError, type AttachmentDraft } from "./Composer";
import {
  validateMessageAttachments,
  selectionAttachmentCapabilities,
  type SubmittedAttachment,
  type ModelSelection,
} from "@pitcrew/protocol";
import { ModelPicker } from "./ModelPicker";
import { OpenRouterConnection } from "./OpenRouterConnection";
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
  const [workspaceCollapsed, setWorkspaceCollapsed] = useState(false);
  const [workspaceWidth, setWorkspaceWidth] = useState(380);
  const [section, setSection] = useState<WorkspaceSection>("work");
  const [landingEnabled, setLandingEnabled] = useState(false);
  const [composerCapabilities, setComposerCapabilities] =
    useState<LandingCapabilities["composer"]>();
  const [selections, setSelections] = useState<Record<string, ModelSelection>>({});
  const [selectionSaving, setSelectionSaving] = useState<Record<string, boolean>>({});
  const [landingStates, setLandingStates] = useState<Record<string, LandingState>>({});
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState("");
  const [threads, setThreads] = useState<Thread[]>([]);
  const [threadId, setThreadId] = useState("");
  const [snapshot, setSnapshot] = useState<Snapshot>(empty);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [attachments, setAttachments] = useState<Record<string, AttachmentDraft[]>>({});
  const attachmentDrafts = useRef<Record<string, AttachmentDraft[]>>({});
  const [attachmentErrors, setAttachmentErrors] = useState<Record<string, string>>({});
  const [title, setTitle] = useState("");
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [threadsLoading, setThreadsLoading] = useState(false);
  const [snapshotLoading, setSnapshotLoading] = useState(false);
  const loading = projectsLoading || threadsLoading || snapshotLoading;
  const [mutationError, setMutationError] = useState("");
  const [projectsError, setProjectsError] = useState("");
  const [threadsError, setThreadsError] = useState("");
  const [snapshotError, setSnapshotError] = useState("");
  const error = mutationError || projectsError || threadsError || snapshotError;
  const [announcement, setAnnouncement] = useState("");
  const [revision, setRevision] = useState(0);
  const [sidebarRevision, setSidebarRevision] = useState(0);
  const requestedThread = useRef<string | undefined>(undefined);
  const generation = useRef(0);
  const snapshotSequence = useRef(0);
  const pending = useRef<{
    threadId: string;
    content: string;
    attachments: string;
    selection: string;
    key: string;
  } | null>(null);
  const createKey = useRef<{ projectId: string; title: string; key: string } | null>(null);
  const mutation = useRef(false);
  const refresh = useCallback(() => {
    setMutationError("");
    setRevision((value) => value + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLandingEnabled(false);
    api
      .capabilities()
      .then((capabilities) => {
        if (!cancelled) {
          setComposerCapabilities(capabilities.composer);
          setLandingEnabled(
            capabilities.landing.enabled && capabilities.landing.backend === "fixture",
          );
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLandingEnabled(false);
          setComposerCapabilities(undefined);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [api, revision]);
  useEffect(() => {
    let cancelled = false;
    setProjectsLoading(true);
    api
      .projects()
      .then((items) => {
        if (!cancelled) {
          setProjects(items);
          setProjectId((id) => (items.some((item) => item.id === id) ? id : (items[0]?.id ?? "")));
          setProjectsLoading(false);
          setProjectsError("");
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setProjectsError(errorText(cause));
          setProjectsLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [api, revision]);
  useEffect(() => {
    if (!projectId) {
      setThreads([]);
      setThreadId("");
      setThreadsLoading(false);
      setThreadsError("");
      return;
    }
    let cancelled = false;
    setThreadsLoading(true);
    api
      .threads(projectId)
      .then((items) => {
        if (!cancelled) {
          setThreads(items);
          const requested = requestedThread.current;
          requestedThread.current = undefined;
          setThreadId((id) => {
            const desired = requested ?? id;
            return items.some((item) => item.id === desired)
              ? desired
              : (items.find((item) => !item.archived)?.id ?? "");
          });
          setThreadsLoading(false);
          setThreadsError("");
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setThreadsError(errorText(cause));
          setThreadsLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [api, projectId, revision]);
  // Failed writes belong to the selected conversation/repository, not its destination.
  useEffect(() => {
    setMutationError("");
  }, [api, projectId, threadId]);
  useEffect(() => {
    const current = ++generation.current;
    if (!threadId) {
      setSnapshot(empty);
      setSnapshotLoading(false);
      setSnapshotError("");
      return;
    }
    let cancelled = false;
    let inFlight = false;
    setSnapshot(empty);
    setSnapshotLoading(true);
    setSnapshotError("");
    const load = async () => {
      if (inFlight || mutation.current) return;
      inFlight = true;
      const sequence = ++snapshotSequence.current;
      try {
        const next = await api.snapshot(threadId);
        if (!cancelled && current === generation.current && sequence === snapshotSequence.current) {
          setSnapshot(next);
          setSnapshotLoading(false);
          setSnapshotError("");
        }
      } catch (cause) {
        if (!cancelled && current === generation.current && sequence === snapshotSequence.current) {
          setSnapshotError(errorText(cause));
          setSnapshotLoading(false);
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
    window.addEventListener("online", onOnline);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("online", onOnline);
    };
  }, [api, threadId, revision]);

  const selection =
    selections[threadId] ??
    threads.find((thread) => thread.id === threadId)?.modelSelection ??
    composerCapabilities?.settings.default;
  const modelValid =
    !composerCapabilities ||
    (!!selection &&
      composerCapabilities.models.some(
        (model) => model.id === selection.modelId && model.efforts.includes(selection.effort),
      ));
  const attachmentCapabilities =
    composerCapabilities && selection
      ? selectionAttachmentCapabilities(composerCapabilities.models, {
          repoAgent: selection,
          implementer: composerCapabilities.settings.roles?.implementer ?? selection,
          reviewer: composerCapabilities.settings.roles?.reviewer ?? selection,
        })
      : composerCapabilities?.attachments;
  let attachmentCompatibilityError = "";
  try {
    validateMessageAttachments(
      (attachments[threadId] ?? [])
        .filter((item) => item.status === "ready")
        .map((item) => item.attachment!),
      attachmentCapabilities,
    );
  } catch (cause) {
    attachmentCompatibilityError = attachmentError(cause);
  }
  async function chooseModel(next: ModelSelection) {
    const selected = threadId,
      selectedProject = projectId,
      selectedGeneration = generation.current;
    setSelections((all) => ({ ...all, [selected]: next }));
    if (!api.setThreadModelSelection) return;
    setSelectionSaving((all) => ({ ...all, [selected]: true }));
    try {
      const thread = await api.setThreadModelSelection(selectedProject, selected, next);
      setThreads((all) => all.map((item) => (item.id === selected ? thread : item)));
    } catch (cause) {
      if (selectedGeneration === generation.current)
        setMutationError(
          `Model preference was not saved. Your next send will apply the displayed choice. ${errorText(cause)}`,
        );
    } finally {
      setSelectionSaving((all) => ({ ...all, [selected]: false }));
    }
  }
  function updateAttachments(
    selected: string,
    update: (items: AttachmentDraft[]) => AttachmentDraft[],
  ) {
    const next = {
      ...attachmentDrafts.current,
      [selected]: update(attachmentDrafts.current[selected] ?? []),
    };
    attachmentDrafts.current = next;
    setAttachments(next);
  }
  function addFiles(files: File[]) {
    if (!threadId || mutation.current || !files.length) return;
    const selected = threadId;
    if ((attachmentDrafts.current[selected]?.length ?? 0) + files.length > 4) {
      setAttachmentErrors((all) => ({
        ...all,
        [selected]: "Attach at most four files. No new files were added.",
      }));
      return;
    }
    setAttachmentErrors((all) => ({ ...all, [selected]: "" }));
    const items = files.map((file) => ({
      id: crypto.randomUUID(),
      name: file.name,
      status: "reading" as const,
    }));
    updateAttachments(selected, (previous) => [...previous, ...items]);
    files.forEach((file, index) => {
      const id = items[index].id;
      void readAttachment(file, id)
        .then((attachment) => {
          updateAttachments(selected, (previous) =>
            previous.map((item) =>
              item.id === id ? { ...item, status: "ready", attachment } : item,
            ),
          );
        })
        .catch((cause: unknown) => {
          updateAttachments(selected, (previous) =>
            previous.map((item) =>
              item.id === id ? { ...item, status: "error", error: attachmentError(cause) } : item,
            ),
          );
        });
    });
  }
  async function send(event: React.FormEvent) {
    event.preventDefault();
    const content = (drafts[threadId] ?? "").trim();
    const files = attachmentDrafts.current[threadId] ?? [];
    if (
      !content ||
      content.length > 8000 ||
      mutation.current ||
      loading ||
      !threadId ||
      selectionSaving[threadId] ||
      !modelValid ||
      files.some((item) => item.status !== "ready")
    )
      return;
    const submittedAttachments = files.map((item) => item.attachment!) as SubmittedAttachment[];
    try {
      validateMessageAttachments(submittedAttachments, attachmentCapabilities);
    } catch (cause) {
      setAttachmentErrors((all) => ({ ...all, [threadId]: attachmentError(cause) }));
      return;
    }
    const attachmentFingerprint = JSON.stringify(submittedAttachments);
    const selectionFingerprint = JSON.stringify(selection);
    const selected = threadId;
    const selectedGeneration = generation.current;
    // Supersede any poll started before this write; it may contain an older transcript.
    const selectedSequence = ++snapshotSequence.current;
    if (
      !pending.current ||
      pending.current.threadId !== selected ||
      pending.current.content !== content ||
      pending.current.attachments !== attachmentFingerprint ||
      pending.current.selection !== selectionFingerprint
    )
      pending.current = {
        threadId: selected,
        content,
        attachments: attachmentFingerprint,
        selection: selectionFingerprint,
        key: crypto.randomUUID(),
      };
    mutation.current = true;
    setBusy(true);
    setMutationError("");
    try {
      await api.send(selected, content, pending.current.key, submittedAttachments, selection);
      pending.current = null;
      setDrafts((all) => ({ ...all, [selected]: "" }));
      updateAttachments(selected, () => []);
      setAttachmentErrors((all) => ({ ...all, [selected]: "" }));
      setAnnouncement(
        composerCapabilities?.conversation
          ? "Message sent and repository agent reply queued."
          : "Message sent and change queued.",
      );
      try {
        const next = await api.snapshot(selected);
        if (
          selectedGeneration === generation.current &&
          selectedSequence === snapshotSequence.current
        ) {
          setSnapshot(next);
          setSnapshotError("");
        }
      } catch (cause) {
        if (
          selectedGeneration === generation.current &&
          selectedSequence === snapshotSequence.current
        )
          setSnapshotError(errorText(cause));
      }
    } catch (cause) {
      if (selectedGeneration === generation.current) setMutationError(errorText(cause));
    } finally {
      mutation.current = false;
      setBusy(false);
    }
  }
  async function addThread(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = title.trim();
    if (!trimmed || mutation.current || loading || !projectId) return;
    const selected = projectId;
    if (
      !createKey.current ||
      createKey.current.projectId !== selected ||
      createKey.current.title !== trimmed
    )
      createKey.current = { projectId: selected, title: trimmed, key: crypto.randomUUID() };
    mutation.current = true;
    setBusy(true);
    setMutationError("");
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
      setMutationError(errorText(cause));
    } finally {
      mutation.current = false;
      setBusy(false);
    }
  }
  async function archiveThread(item: Thread, archived: boolean) {
    if (mutation.current || !api.setThreadArchived) return;
    mutation.current = true;
    setBusy(true);
    setMutationError("");
    try {
      const updated = await api.setThreadArchived(item.projectId, item.id, archived);
      setThreads((all) => all.map((thread) => (thread.id === updated.id ? updated : thread)));
      // Revalidate other repository lists without clearing the selected transcript/draft.
      setSidebarRevision((value) => value + 1);
      setAnnouncement(archived ? "Conversation archived." : "Conversation restored.");
      return updated;
    } catch (cause) {
      setMutationError(errorText(cause));
    } finally {
      mutation.current = false;
      setBusy(false);
    }
  }
  const project = projects.find((item) => item.id === projectId);
  const thread = threads.find((item) => item.id === threadId);
  const latest = snapshot.runs.at(-1);
  return (
    <div className={shellStyles.shell}>
      <a className="skip" href={section === "work" ? "#conversation" : "#workspace-content"}>
        {section === "work" ? "Skip to conversation" : "Skip to content"}
      </a>
      <NavigationRail section={section} onSelect={setSection} />
      <div
        className={`shell workspace-shell ${workspaceCollapsed ? "is-workspace-collapsed" : ""} ${shellStyles.work}`}
        style={workspaceStyle(workspaceWidth)}
        hidden={section !== "work"}
      >
        <Sidebar
          api={api}
          projects={projects}
          projectId={projectId}
          threads={threads}
          threadId={threadId}
          revision={revision + sidebarRevision}
          onArchive={archiveThread}
          busy={busy}
          activeRun={latest}
          onSelect={(repository, conversation) => {
            if (repository === projectId) {
              if (conversation) setThreadId(conversation);
              return;
            }
            requestedThread.current = conversation;
            setProjectId(repository);
            setThreads([]);
            setThreadId("");
            setSnapshot(empty);
            setCreating(false);
          }}
          onCreate={(repository) => {
            if (repository !== projectId) {
              requestedThread.current = undefined;
              setProjectId(repository);
              setThreads([]);
              setThreadId("");
              setSnapshot(empty);
            }
            setTitle("");
            setCreating(true);
          }}
        >
          {creating && (
            <form className="new-thread" onSubmit={addThread}>
              <label htmlFor="thread-title">Conversation title</label>
              <input
                id="thread-title"
                autoFocus
                maxLength={160}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                required
                disabled={busy}
              />
              <button type="submit" disabled={busy || loading || !title.trim()}>
                Create
              </button>
              <button type="button" disabled={busy} onClick={() => setCreating(false)}>
                Cancel
              </button>
            </form>
          )}
        </Sidebar>
        <main id="conversation" className="conversation" tabIndex={-1}>
          <header className="conversation-header">
            <div>
              <p className="eyebrow">{project?.name ?? "Workspace"} / Change thread</p>
              <h1>{thread?.title ?? "Your project conversations"}</h1>
            </div>
            {latest && <span className={`status ${latest.status}`}>{labels[latest.status]}</span>}
          </header>
          {!demo && projectId && (
            <details className="intake-panel" open={!threadId}>
              <summary>Collect and group reports</summary>
              <Intake key={projectId} projectId={projectId} onDispatch={refresh} />
            </details>
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
                      <time dateTime={message.createdAt}>
                        {new Date(message.createdAt).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </time>
                    </div>
                    <p>{message.content}</p>
                    {message.attachments?.map((attachment) => (
                      <details className="message-attachment" key={attachment.id}>
                        <summary>
                          {attachment.name} · Attached{" "}
                          {attachment.mediaType === "text/plain" ? "text" : "image"}
                        </summary>
                        {attachment.mediaType === "text/plain" ? (
                          <pre>{attachment.text}</pre>
                        ) : (
                          <img
                            alt={`Attached ${attachment.name}`}
                            src={
                              api.attachmentUrl?.(message.threadId, attachment.attachmentId) ??
                              `/api/threads/${encodeURIComponent(message.threadId)}/attachments/${encodeURIComponent(attachment.attachmentId)}`
                            }
                          />
                        )}
                      </details>
                    ))}
                  </div>
                </article>
              ))
            )}
          </div>
          {attachmentErrors[threadId] && (
            <p className="composer-error" role="alert">
              {attachmentErrors[threadId]}
            </p>
          )}
          {snapshot.turns?.some(
            (turn) => turn.status === "queued" || turn.status === "running",
          ) && (
            <p className="composer-hint" role="status">
              Repository agent replies are queued or running. New messages join the conversation
              queue.
            </p>
          )}
          {snapshot.turns
            ?.filter((turn) => turn.status === "failed")
            .map((turn) => (
              <p key={turn.id} className="composer-error" role="alert">
                Repository agent reply failed: {turn.error ?? "Execution unavailable"}. No work was
                silently replayed.
              </p>
            ))}
          {attachmentCompatibilityError && (
            <p className="composer-error" role="alert">
              {attachmentCompatibilityError}
            </p>
          )}
          <Composer
            sessionKey={threadId}
            dictationEnabled={section === "work"}
            draft={drafts[threadId] ?? ""}
            onDraft={(text) => setDrafts((all) => ({ ...all, [threadId]: text }))}
            attachments={attachments[threadId] ?? []}
            onFiles={addFiles}
            onRemove={(id) => {
              updateAttachments(threadId, (items) => items.filter((item) => item.id !== id));
              setAttachmentErrors((all) => ({ ...all, [threadId]: "" }));
            }}
            onSend={send}
            disabled={!threadId || busy}
            sending={busy}
            canSend={
              !!threadId &&
              !busy &&
              !loading &&
              !selectionSaving[threadId] &&
              modelValid &&
              !attachmentCompatibilityError &&
              !!(drafts[threadId] ?? "").trim() &&
              (drafts[threadId] ?? "").length <= 8000 &&
              (attachments[threadId] ?? []).every((item) => item.status === "ready")
            }
            capabilities={attachmentCapabilities}
            modelControls={
              composerCapabilities && selection ? (
                <ModelPicker
                  models={composerCapabilities.models}
                  selection={selection}
                  onSelection={(next) => void chooseModel(next)}
                  disabled={!threadId || busy || !!selectionSaving[threadId]}
                />
              ) : undefined
            }
          />
          <p className="sr-only" role="status">
            {announcement}
          </p>
          {api.openrouter && <OpenRouterConnection api={api.openrouter} />}
        </main>
        {!workspaceCollapsed && (
          <WorkspaceResize width={workspaceWidth} onWidth={setWorkspaceWidth} />
        )}
        <Workspace
          scope={`${projectId}:${threadId}`}
          project={project}
          snapshot={snapshot}
          api={api}
          collapsed={workspaceCollapsed}
          onCollapse={setWorkspaceCollapsed}
        >
          <div className="evidence" aria-label="Change evidence">
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
                    <strong>Change run</strong>
                    <span className={`status ${run.status}`}>{labels[run.status]}</span>
                  </div>
                  {run.error && (
                    <p className="run-error">
                      {run.error === "reconciliation_required"
                        ? "Execution needs reconciliation before another attempt. No work has been replayed."
                        : run.error === "execution_unavailable"
                          ? "Cloud execution is unavailable."
                          : "Execution failed. Inspect the evidence before trying a new change."}
                    </p>
                  )}
                  <details>
                    <summary>Tests and tool output</summary>
                    <p className="run-id">{run.id}</p>
                    <dl>
                      <dt>Base</dt>
                      <dd>
                        <code>{run.baseSha}</code>
                      </dd>
                      <dt>Candidate</dt>
                      <dd>
                        <code>{run.candidateSha ?? "Not available yet"}</code>
                      </dd>
                      {run.workerId && (
                        <>
                          <dt>Worker</dt>
                          <dd>{run.workerId}</dd>
                        </>
                      )}
                      <dt>Configuration</dt>
                      <dd>{run.configurationRevision}</dd>
                      {run.artifactId && (
                        <>
                          <dt>Artifacts fork</dt>
                          <dd>{run.artifactId}</dd>
                        </>
                      )}
                    </dl>
                    {evidence?.verification && (
                      <div className="verification-evidence">
                        <p>Plan {evidence.verification.plan.fingerprint}</p>
                        <p>
                          Profile {evidence.verification.plan.profile.revision} · Acceptance{" "}
                          {evidence.verification.plan.acceptance.revision}
                        </p>
                        {evidence.verification.plan.acceptance.criteria.map((c) => (
                          <p key={c.id}>{c.text}</p>
                        ))}
                      </div>
                    )}
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
                            {review.decision === "approve"
                              ? "Approved candidate"
                              : "Changes requested"}
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
                  {evidence?.verification && (
                    <div className="verification-evidence" aria-label="Verification evidence">
                      <h3>Verification checks</h3>
                      {evidence.verification.outcomes.map((o) => (
                        <details key={`${o.phase}:${o.checkId}`}>
                          <summary>
                            {o.checkId}: {o.status} ({o.phase})
                          </summary>
                          <p>
                            SHA {o.checkedSha} · Artifact {o.artifactId} · Duration{" "}
                            {o.durationMs === undefined ? "unmeasured" : `${o.durationMs} ms`}
                          </p>
                          <p>{o.reason}</p>
                          <pre>
                            {JSON.stringify(
                              evidence.verification!.plan.profile.checks.find(
                                (c) => c.id === o.checkId,
                              ),
                            )}
                          </pre>
                          <pre>
                            {o.result?.stdout}
                            {o.result?.stderr}
                          </pre>
                        </details>
                      ))}
                    </div>
                  )}
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
          </div>
        </Workspace>
      </div>
      {section !== "work" && <WorkspacePlaceholder section={section} />}
    </div>
  );
}
