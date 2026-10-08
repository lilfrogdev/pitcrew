import { useMentionMembers, useMentionDrafts } from "./mentions/useMentions";
import { MessageContent, Mentioned } from "./mentions/Message";
import { Repositories } from "./Repositories";
import { AccountRepositories } from "./AccountRepositories";
import { NavigationRail, WorkspacePlaceholder, type WorkspaceSection } from "./NavigationRail";
import shellStyles from "./NavigationRail.module.css";
import { Sidebar } from "./Sidebar";
import { Intake } from "./Intake";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { VisualizationWorkspace } from "./visualizations/VisualizationWorkspace";
import type {
  Api,
  Project,
  Run,
  Snapshot,
  Thread,
  LandingCapabilities,
  InvitationPreview,
} from "./api";
import "./styles.css";
import { LandingControl, type LandingState } from "./LandingControl";
import { isLandedReceipt, runDisplayStatus } from "./landing-receipt";
import { landingStateKey, readLandingStates, saveLandingState } from "./landing-storage";
import { Workspace, WorkspaceResize, workspaceStyle } from "./Workspace";
import { uploadInputs } from "./uploads/input";
import { UploadDrafts } from "./uploads/drafts";
import { StoredFile } from "./uploads/Preview";
import { Composer, readAttachment, attachmentError, type AttachmentDraft } from "./Composer";
import {
  validateMessageAttachments,
  isStoredFile,
  type UploadSubmission,
  selectionAttachmentCapabilities,
  TEXT_ATTACHMENT_CAPABILITIES,
  type SubmittedAttachment,
  type ModelSelection,
} from "@pitcrew/protocol";
import { ModelPicker } from "./ModelPicker";
import { PermissionsMenu } from "./PermissionsMenu";
import { useKeyboardFocus } from "./useKeyboardFocus";
import { ProfileProviders } from "./ProfileProviders";
import { Collaborators, InvitationGate } from "./Collaboration";
import { readDisplayPreference, saveDisplayPreference } from "./display-preference";
import type { AuthApi } from "./auth-api";
import type { AuthUser } from "./auth-api";
import { Avatar } from "./Avatar";
import { useThreadPresence } from "./useThreadPresence";
import { ComposerStatus } from "./ComposerStatus";
import { landingApprovalPending } from "./landing-approval";
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
export function App({
  api,
  auth,
  viewer,
  demo = false,
}: {
  api: Api;
  auth?: AuthApi;
  viewer?: AuthUser;
  demo?: boolean;
}) {
  const [workspaceCollapsed, setWorkspaceCollapsed] = useState(false);
  const [workspaceWidth, setWorkspaceWidth] = useState(380);
  const keyboardFocus = useKeyboardFocus();
  const [section, setSection] = useState<WorkspaceSection>("work");
  const [landingEnabled, setLandingEnabled] = useState(false);
  const [landingBackend, setLandingBackend] =
    useState<LandingCapabilities["landing"]["backend"]>(null);
  const [providerRevision, setProviderRevision] = useState(0);
  const [providersLoading, setProvidersLoading] = useState(true);
  const [composerCapabilities, setComposerCapabilities] =
    useState<LandingCapabilities["composer"]>();
  const [notesEnabled, setNotesEnabled] = useState(false);
  const [selections, setSelections] = useState<Record<string, ModelSelection>>({});
  const [selectionSaving, setSelectionSaving] = useState<Record<string, boolean>>({});
  const landingAccount = viewer?.id ?? (demo ? "fixture-local" : undefined);
  const [landingStates, setLandingStates] = useState<Record<string, LandingState>>(() =>
    readLandingStates(landingAccount),
  );
  useEffect(() => {
    setLandingStates(readLandingStates(landingAccount));
  }, [landingAccount]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState("");
  const [threads, setThreads] = useState<Thread[]>([]);
  const [threadId, setThreadId] = useState("");
  const [snapshot, setSnapshot] = useState<Snapshot>(empty);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const mentionDraft = useMentionDrafts(threadId, drafts[threadId] ?? "");
  const [attachments, setAttachments] = useState<Record<string, AttachmentDraft[]>>({});
  const attachmentDrafts = useRef<Record<string, AttachmentDraft[]>>({});
  const uploadManager = useMemo(
    () => (api.uploads ? new UploadDrafts(api.uploads, updateAttachments) : undefined),
    [api.uploads, viewer?.id],
  );
  useEffect(() => () => uploadManager?.dispose(), [uploadManager, viewer?.id]);
  const [uploadsEnabled, setUploadsEnabled] = useState(false);
  const [attachmentErrors, setAttachmentErrors] = useState<Record<string, string>>({});
  const [title, setTitle] = useState("");
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [threadsLoading, setThreadsLoading] = useState(false);
  const [snapshotLoading, setSnapshotLoading] = useState(false);
  const loading = projectsLoading || threadsLoading || snapshotLoading;
  const mentionMembers = useMentionMembers(
    api.collaboration,
    threadId,
    section === "work" && !loading,
    viewer?.id,
  );
  const visualizationThreadAvailable = threads.some(
    (thread) => thread.id === threadId && thread.projectId === projectId,
  );
  const visualizationSource = useMemo(
    () =>
      viewer?.id && api.visualizations && !loading && projectId && visualizationThreadAvailable
        ? {
            accountId: `account:${viewer.id}`,
            repositoryId: projectId,
            threadId,
            load: (signal: AbortSignal) => api.visualizations!(projectId, threadId, signal),
          }
        : undefined,
    [viewer?.id, api, loading, projectId, threadId, visualizationThreadAvailable],
  );
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
  const pending = useRef<
    Record<
      string,
      {
        threadId: string;
        content: string;
        attachments: string;
        drafts: string;
        submitted: (SubmittedAttachment | UploadSubmission)[];
        selection: string;
        mentions: string;
        key: string;
      }
    >
  >({});
  const createKey = useRef<{ projectId: string; title: string; key: string } | null>(null);
  const mutation = useRef(false);
  const refresh = useCallback(() => {
    setMutationError("");
    setRevision((value) => value + 1);
  }, []);
  const accessLost = useCallback(() => {
    uploadManager?.dispose();
    pending.current = {};
    attachmentDrafts.current = {};
    setAttachments({});
    setAttachmentErrors({});
    window.dispatchEvent(new Event("pitcrew-access-lost"));
    setSnapshot(empty);
    setThreads([]);
    setThreadId("");
    setProjectId("");
    setProjects([]);
    setMutationError("Access changed. Your workspace is refreshing.");
    setRevision((value) => value + 1);
  }, [uploadManager]);
  const presence = useThreadPresence(api.presence, threadId, section === "work", accessLost);
  const [connectionFailed, setConnectionFailed] = useState(false);
  const connectionThread = useRef("");

  useEffect(() => {
    let cancelled = false;
    setLandingEnabled(false);
    setLandingBackend(null);
    setProvidersLoading(true);
    setComposerCapabilities(undefined);
    setNotesEnabled(false);
    setUploadsEnabled(false);
    if (api.collaboration && !projectId) {
      setProvidersLoading(false);
      return;
    }
    api
      .capabilities(projectId || undefined)
      .then((capabilities) => {
        if (!cancelled) {
          setComposerCapabilities(capabilities.composer);
          setNotesEnabled(capabilities.notesEnabled === true);
          setUploadsEnabled(!!capabilities.uploads && !!api.uploads);
          setProvidersLoading(false);
          setLandingEnabled(
            capabilities.landing.enabled &&
              ["fixture", "artifacts"].includes(capabilities.landing.backend ?? ""),
          );
          setLandingBackend(
            ["fixture", "artifacts"].includes(capabilities.landing.backend ?? "")
              ? capabilities.landing.backend
              : null,
          );
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLandingEnabled(false);
          setLandingBackend(null);
          setComposerCapabilities(undefined);
          setProvidersLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [api, projectId, revision, providerRevision]);
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
  // A refresh also cancels directory reads started before a membership change.
  useEffect(() => {
    if (!api.collaboration) return;
    let cancelled = false;
    let inFlight = false;
    const revalidate = async () => {
      if (inFlight || mutation.current || document.hidden) return;
      inFlight = true;
      try {
        const nextProjects = await api.projects();
        if (cancelled) return;
        if (projectId && !nextProjects.some((item) => item.id === projectId)) {
          accessLost();
          return;
        }
        setProjects(nextProjects);
        if (projectId) {
          const nextThreads = await api.threads(projectId);
          if (cancelled) return;
          setThreads(nextThreads);
          if (threadId && !nextThreads.some((item) => item.id === threadId)) {
            setSnapshot(empty);
            setThreadId(nextThreads.find((item) => !item.archived)?.id ?? "");
          }
        }
      } catch (cause) {
        if (
          !cancelled &&
          cause instanceof Error &&
          "status" in cause &&
          [401, 403, 404].includes(Number(cause.status))
        )
          accessLost();
      } finally {
        inFlight = false;
      }
    };
    const timer = window.setInterval(() => void revalidate(), 15000);
    const online = () => void revalidate();
    const visible = () => {
      if (!document.hidden) void revalidate();
    };
    window.addEventListener("online", online);
    document.addEventListener("visibilitychange", visible);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("online", online);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [api, projectId, threadId, accessLost, revision]);
  // Failed writes belong to the selected conversation/repository, not its destination.
  useEffect(() => {
    setMutationError("");
  }, [api, projectId, threadId]);
  useEffect(() => {
    const current = ++generation.current;
    if (connectionThread.current !== threadId) {
      connectionThread.current = threadId;
      setConnectionFailed(false);
    }
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
          setConnectionFailed(false);
        }
      } catch (cause) {
        if (!cancelled && current === generation.current && sequence === snapshotSequence.current) {
          if (
            cause instanceof Error &&
            "status" in cause &&
            [401, 403, 404].includes(Number(cause.status))
          ) {
            accessLost();
          } else {
            setSnapshotError(errorText(cause));
            setConnectionFailed(true);
          }
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
  }, [api, threadId, revision, accessLost]);

  const displayOnly = composerCapabilities?.displayOnly === true;
  const executionEnabled =
    !displayOnly &&
    (composerCapabilities?.executionEnabled ?? composerCapabilities?.conversation ?? false);
  const humanMessages = notesEnabled && !executionEnabled;
  const usableModels =
    composerCapabilities?.conversation || displayOnly
      ? composerCapabilities.models.filter(
          (model) =>
            model.efforts.length &&
            (demo || !["fixture", "pitcrew-fixture"].includes(model.provider)),
        )
      : [];
  const selectionKey = displayOnly
    ? `display:${projectId}:${threadId}:${composerCapabilities?.catalogRevision}`
    : threadId;
  const selection =
    selections[selectionKey] ??
    (displayOnly
      ? readDisplayPreference(
          projectId,
          threadId,
          composerCapabilities?.catalogRevision ?? "",
          usableModels,
        )
      : threads.find((thread) => thread.id === threadId)?.modelSelection) ??
    composerCapabilities?.settings.default;
  const providerConnected = usableModels.length > 0;
  const modelValid =
    providerConnected &&
    !!selection &&
    usableModels.some(
      (model) => model.id === selection.modelId && model.efforts.includes(selection.effort),
    );
  const attachmentCapabilities =
    providerConnected && composerCapabilities?.conversation && selection
      ? selectionAttachmentCapabilities(usableModels, {
          repoAgent: selection,
          implementer: composerCapabilities.settings.roles?.implementer ?? selection,
          reviewer: composerCapabilities.settings.roles?.reviewer ?? selection,
        })
      : TEXT_ATTACHMENT_CAPABILITIES;
  const draftFingerprint = (items: AttachmentDraft[]) =>
    JSON.stringify(items.map((item) => [item.id, item.attachment]));
  function prepareAttachments() {
    const files = attachmentDrafts.current[threadId] ?? [];
    const prior = pending.current[threadId];
    if (
      prior &&
      prior.threadId === threadId &&
      prior.content === (drafts[threadId] ?? "").trim() &&
      prior.selection === JSON.stringify(selection) &&
      prior.drafts === draftFingerprint(files)
    ) {
      // A refreshed transcript may include this very submission. Keep its exact
      // input decisions and request body while an unchanged send is uncertain.
      return files.map((item, index) => ({
        ...item,
        attachment: prior.submitted[index],
        modelInput:
          "uploadId" in prior.submitted[index] ? prior.submitted[index].modelInput : undefined,
      }));
    }
    return uploadInputs(
      files,
      snapshot.messages.flatMap((message) => message.attachments ?? []),
      attachmentCapabilities,
      !humanMessages && executionEnabled,
    );
  }
  const preparedAttachments = prepareAttachments();
  let attachmentCompatibilityError = "";
  try {
    validateMessageAttachments(
      (attachments[threadId] ?? [])
        .filter((item) => item.status === "ready")
        .map((item) => item.attachment!)
        .filter((item) => !("uploadId" in item)),
      attachmentCapabilities,
    );
  } catch (cause) {
    attachmentCompatibilityError = attachmentError(cause);
  }
  async function chooseModel(next: ModelSelection) {
    const selected = threadId,
      selectedProject = projectId,
      selectedGeneration = generation.current;
    setSelections((all) => ({ ...all, [selectionKey]: next }));
    if (displayOnly) {
      const choice = usableModels.find(
        (model) => model.id === next.modelId && model.efforts.includes(next.effort),
      );
      if (choice && composerCapabilities?.catalogRevision) {
        try {
          saveDisplayPreference(
            selectedProject,
            selected,
            composerCapabilities.catalogRevision,
            choice,
            next,
          );
        } catch {
          setMutationError("Model preference could not be saved for the next visit.");
        }
      }
      return;
    }
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
    if (uploadsEnabled && uploadManager) {
      try {
        uploadManager.add(selected, files, attachmentDrafts.current[selected] ?? []);
        setAttachmentErrors((all) => ({ ...all, [selected]: "" }));
      } catch (cause) {
        setAttachmentErrors((all) => ({
          ...all,
          [selected]: cause instanceof Error ? cause.message : "Upload failed.",
        }));
      }
      return;
    }
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
    const files = prepareAttachments();
    if (
      !content ||
      content.length > 8000 ||
      mutation.current ||
      loading ||
      !(humanMessages || executionEnabled) ||
      !threadId ||
      selectionSaving[threadId] ||
      (!humanMessages && !modelValid) ||
      (humanMessages && files.length > 0 && !uploadsEnabled) ||
      files.some((item) => item.status !== "ready")
    )
      return;
    const submittedAttachments = files.map((item) => item.attachment!) as (
      | SubmittedAttachment
      | UploadSubmission
    )[];
    try {
      validateMessageAttachments(
        submittedAttachments.filter((item) => !("uploadId" in item)),
        attachmentCapabilities,
      );
    } catch (cause) {
      setAttachmentErrors((all) => ({ ...all, [threadId]: attachmentError(cause) }));
      return;
    }
    const submittedMentions = mentionDraft.submitted();
    const mentionFingerprint = JSON.stringify(submittedMentions);
    const attachmentFingerprint = JSON.stringify(submittedAttachments);
    const selectionFingerprint = JSON.stringify(selection);
    const selected = threadId;
    const selectedGeneration = generation.current;
    // Supersede any poll started before this write; it may contain an older transcript.
    const selectedSequence = ++snapshotSequence.current;
    const existing = pending.current[selected];
    if (
      !existing ||
      existing.content !== content ||
      existing.attachments !== attachmentFingerprint ||
      existing.selection !== selectionFingerprint ||
      existing.mentions !== mentionFingerprint
    )
      pending.current[selected] = {
        threadId: selected,
        content,
        attachments: attachmentFingerprint,
        drafts: draftFingerprint(attachmentDrafts.current[threadId] ?? []),
        submitted: structuredClone(submittedAttachments),
        selection: selectionFingerprint,
        mentions: mentionFingerprint,
        key: crypto.randomUUID(),
      };
    uploadManager?.freezeExpiry(files.map((file) => file.id));
    mutation.current = true;
    setBusy(true);
    setMutationError("");
    try {
      await api.send(
        selected,
        content,
        pending.current[selected].key,
        submittedAttachments,
        selection,
        submittedMentions.length ? submittedMentions : undefined,
      );
      delete pending.current[selected];
      mentionDraft.clear();
      setDrafts((all) => ({ ...all, [selected]: "" }));
      files.forEach((file) => uploadManager?.remove(file.id, false));
      updateAttachments(selected, () => []);
      setAttachmentErrors((all) => ({ ...all, [selected]: "" }));
      setAnnouncement(
        humanMessages
          ? "Message sent."
          : composerCapabilities?.conversation
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
          setConnectionFailed(false);
        }
      } catch (cause) {
        if (
          selectedGeneration === generation.current &&
          selectedSequence === snapshotSequence.current
        ) {
          setSnapshotError(errorText(cause));
          setConnectionFailed(true);
        }
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
  const approvalRun =
    !loading &&
    !snapshotError &&
    [...snapshot.runs].reverse().find(
      (run) =>
        run.threadId === threadId &&
        landingApprovalPending(
          run,
          snapshot.evidence.find((item) => item.run.id === run.id),
          snapshot.reviews.filter((review) => review.runId === run.id),
          landingEnabled,
          landingBackend,
          landingStates[landingStateKey(landingAccount, projectId, run.id)],
        ),
    );
  const openApproval = () => {
    if (!approvalRun) return;
    setWorkspaceCollapsed(false);
    requestAnimationFrame(() => {
      document.getElementById("workspace-tab-review")?.click();
      requestAnimationFrame(() => {
        const control = document.getElementById(`landing-control-${approvalRun.id}`);
        control?.scrollIntoView?.({ block: "nearest" });
        control?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
      });
    });
  };
  const invitationAccepted = (invitation: InvitationPreview) => {
    requestedThread.current = invitation.threadId;
    setProjectId(invitation.projectId);
    setSection("work");
    setRevision((value) => value + 1);
    setAnnouncement("Invitation accepted.");
  };
  return (
    <div className={shellStyles.shell} data-keyboard-focus={keyboardFocus}>
      <a className="skip" href={section === "work" ? "#conversation" : "#workspace-content"}>
        {section === "work" ? "Skip to conversation" : "Skip to content"}
      </a>
      <NavigationRail section={section} onSelect={setSection} viewer={viewer} />
      <div
        className={`shell workspace-shell ${workspaceCollapsed ? "is-workspace-collapsed" : ""} ${shellStyles.work}`}
        style={workspaceStyle(workspaceWidth)}
        hidden={section !== "work"}
      >
        <Sidebar
          key={viewer?.id ?? "local"}
          accountId={viewer?.id}
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
          <InvitationGate api={api.collaboration} onAccepted={invitationAccepted} />
          <header className="conversation-header">
            <div>
              <p className="eyebrow">{project?.name ?? "Workspace"} / Change thread</p>
              <h1>
                {thread?.title ??
                  (projects.length ? "Your repository conversations" : "Your repositories")}
              </h1>
            </div>
            <Collaborators
              api={api.collaboration}
              projectId={projectId}
              threadId={threadId}
              onAccessLost={accessLost}
            />
            {latest && (
              <span className={`status ${runDisplayStatus(latest)}`}>
                {labels[runDisplayStatus(latest)]}
              </span>
            )}
          </header>
          {!demo && projectId && (
            <details className="intake-panel" open={!threadId}>
              <summary>Collect and group reports</summary>
              <Intake key={projectId} projectId={projectId} onDispatch={refresh} />
            </details>
          )}
          {error && !(error === snapshotError && connectionFailed) && (
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
                <h2>{projects.length ? "A place for every change" : "No repositories yet"}</h2>
                <p>
                  {projects.length
                    ? "Select a repository and create a thread to work with your crew."
                    : "Repositories you own or join will appear here. Open Repositories to check for an approved repository, or ask a project owner for an invitation."}
                </p>
              </div>
            ) : !snapshot.messages.length ? (
              <div className="empty">
                <h2>{humanMessages ? "Start the conversation" : "Start with the outcome"}</h2>
                {humanMessages ? (
                  <p>Share a message with the people in this thread.</p>
                ) : (
                  <p>
                    Describe what you want changed. Your repository agent will coordinate a separate
                    worker and reviewer.
                  </p>
                )}
              </div>
            ) : (
              snapshot.messages.map((message) => {
                const isSelf = !!viewer && message.author?.actor === `account:${viewer.id}`;
                const authorName =
                  message.author?.username ||
                  (isSelf ? viewer.username || viewer.name : undefined) ||
                  message.author?.displayName ||
                  message.author?.email ||
                  "Participant";
                const authorImage = isSelf ? viewer.image : message.author?.avatar;
                return (
                  <article className={`message ${message.role}`} key={message.id}>
                    <Avatar
                      className="avatar"
                      name={message.role === "user" ? authorName : message.role}
                      image={message.role === "user" ? authorImage : undefined}
                    />
                    <div className="message-body">
                      <div className="message-meta">
                        <strong>
                          {message.role === "user"
                            ? authorName
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
                        <Mentioned
                          message={message}
                          recipient={viewer ? `account:${viewer.id}` : undefined}
                        />
                      </div>
                      <MessageContent message={message} members={mentionMembers} />
                      {message.attachments?.map((attachment) =>
                        isStoredFile(attachment) ? (
                          <StoredFile
                            key={attachment.id}
                            attachment={attachment}
                            url={
                              api.attachmentUrl?.(message.threadId, attachment.attachmentId) ??
                              `/api/threads/${encodeURIComponent(message.threadId)}/attachments/${encodeURIComponent(attachment.attachmentId)}`
                            }
                          />
                        ) : (
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
                        ),
                      )}
                    </div>
                  </article>
                );
              })
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
          {humanMessages && (
            <p className="composer-hint">Messages are shared. Agent runs are disabled.</p>
          )}
          <ComposerStatus
            onReconnect={error && error !== snapshotError ? undefined : refresh}
            usernames={presence.usernames}
            reconnecting={presence.reconnecting || connectionFailed}
            approval={approvalRun ? { onOpen: openApproval } : undefined}
          />
          <Composer
            onTyping={presence.activity}
            onTypingStop={presence.stop}
            sessionKey={threadId}
            dictationEnabled={section === "work"}
            draft={drafts[threadId] ?? ""}
            mentionMembers={mentionMembers}
            onMention={(text, mention) => {
              mentionDraft.change(text, mention);
              setDrafts((all) => ({ ...all, [threadId]: text }));
            }}
            onDraft={(text) => {
              mentionDraft.change(text);
              setDrafts((all) => ({ ...all, [threadId]: text }));
            }}
            attachments={preparedAttachments}
            onFiles={addFiles}
            uploadsEnabled={uploadsEnabled}
            onRetry={(id) => uploadManager?.retry(id)}
            onRemove={(id) => {
              uploadManager?.remove(id);
              updateAttachments(threadId, (items) => items.filter((item) => item.id !== id));
              setAttachmentErrors((all) => ({ ...all, [threadId]: "" }));
            }}
            onSend={send}
            disabled={!threadId || busy}
            attachmentsEnabled={uploadsEnabled || !humanMessages}
            sending={busy}
            canSend={
              !!threadId &&
              !busy &&
              !loading &&
              (humanMessages || executionEnabled) &&
              !selectionSaving[threadId] &&
              (humanMessages || modelValid) &&
              (!humanMessages || uploadsEnabled || !(attachments[threadId] ?? []).length) &&
              !attachmentCompatibilityError &&
              !!(drafts[threadId] ?? "").trim() &&
              (drafts[threadId] ?? "").length <= 8000 &&
              (attachments[threadId] ?? []).every((item) => item.status === "ready")
            }
            capabilities={attachmentCapabilities}
            modelControls={
              providerConnected && selection ? (
                <ModelPicker
                  models={usableModels}
                  selection={selection}
                  onSelection={(next) => void chooseModel(next)}
                  disabled={!threadId || busy || !!selectionSaving[threadId]}
                  executionEnabled={composerCapabilities ? executionEnabled : null}
                />
              ) : !projectId ? null : humanMessages ? (
                <PermissionsMenu executionEnabled={false} />
              ) : providersLoading ? (
                <span className="provider-setup" role="status">
                  Checking providers…
                </span>
              ) : (
                <button
                  type="button"
                  className="provider-setup"
                  onClick={() => setSection("account")}
                >
                  Set up a provider
                </button>
              )
            }
          />
          <p className="sr-only" role="status">
            {announcement}
          </p>
        </main>
        {!workspaceCollapsed && (
          <WorkspaceResize width={workspaceWidth} onWidth={setWorkspaceWidth} />
        )}
        <Workspace
          scope={`${projectId}:${threadId}`}
          threadId={threadId}
          project={project}
          snapshot={snapshot}
          api={api}
          collapsed={workspaceCollapsed}
          onCollapse={setWorkspaceCollapsed}
          visualizations={
            visualizationSource ? (
              <VisualizationWorkspace source={visualizationSource} authorized />
            ) : undefined
          }
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
                    <span className={`status ${runDisplayStatus(run)}`}>
                      {labels[runDisplayStatus(run)]}
                    </span>
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
                    backend={landingBackend}
                    state={landingStates[landingStateKey(landingAccount, projectId, run.id)]}
                    onStateChange={(state) => {
                      const confirmed = isLandedReceipt(run, state.result, landingBackend);
                      let persisted = true;
                      try {
                        saveLandingState(landingAccount, projectId, run.id, state);
                      } catch {
                        persisted = false;
                      }
                      setLandingStates((states) => ({
                        ...states,
                        [landingStateKey(landingAccount, projectId, run.id)]:
                          persisted || confirmed
                            ? state
                            : {
                                ...state,
                                busy: false,
                                persistenceError: true,
                                error:
                                  "Could not save the landing receipt in this browser. Landing is disabled; restore browser storage and reload to check the receipt.",
                              },
                      }));
                      if (confirmed) {
                        setSnapshot((current) => ({
                          ...current,
                          runs: current.runs.map((item) =>
                            item.id === run.id &&
                            item.baseSha === run.baseSha &&
                            item.candidateSha === run.candidateSha &&
                            item.configurationRevision === run.configurationRevision
                              ? { ...item, landing: state.result, status: "completed" }
                              : item,
                          ),
                        }));
                      }
                      return persisted || confirmed;
                    }}
                  />
                </section>
              );
            })}
          </div>
        </Workspace>
      </div>
      {section === "account" && (
        <ProfileProviders
          auth={auth}
          api={api.openrouter}
          collaboration={api.collaboration}
          viewer={viewer}
          onSignOut={
            auth
              ? async () => {
                  await auth.signOut();
                  window.dispatchEvent(new Event("pitcrew-auth-required"));
                }
              : undefined
          }
          invitation={
            <InvitationGate
              api={api.collaboration}
              manual
              fromUrl={false}
              onAccepted={invitationAccepted}
            />
          }
          onChange={() => {
            setComposerCapabilities(undefined);
            setProvidersLoading(true);
            setProviderRevision((value) => value + 1);
          }}
        />
      )}
      {section === "repositories" &&
        (api.collaboration ? (
          <AccountRepositories
            key={viewer?.id ?? "local"}
            api={api.collaboration}
            onAdopted={refresh}
          />
        ) : (
          <Repositories api={api.repositories} />
        ))}
      {section === "tickets" && <WorkspacePlaceholder section={section} />}
    </div>
  );
}
