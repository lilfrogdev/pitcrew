import { createRepositoryApi, type RepositoryApi } from "./repository-api";
import type {
  Project,
  Thread,
  Message,
  Run,
  Review,
  RunEvidence,
  LandingAuthorizationReceipt,
  LandingResultReceipt,
  SubmittedAttachment,
  AttachmentCapabilities,
  ModelChoice,
  ModelSelection,
  ModelSettings,
} from "@pitcrew/protocol";
import type { OpenRouterConnectionApi, OpenRouterStatus } from "./openrouter-types";
export type { Project, Thread, Message, Run, Review } from "@pitcrew/protocol";
export type Snapshot = {
  messages: Message[];
  runs: Run[];
  reviews: Review[];
  evidence: RunEvidence[];
  turns?: { id: string; status: "queued" | "running" | "completed" | "failed"; error?: string }[];
};
export type LandingCapabilities = {
  landing: { enabled: boolean; backend: "fixture" | null };
  composer?: {
    models: ModelChoice[];
    settings: ModelSettings;
    conversation: boolean;
    /** Display metadata never authorizes this API's Work transport. */
    displayOnly?: boolean;
    catalogRevision?: string;
    executionEnabled?: boolean;
    attachments?: AttachmentCapabilities;
  };
};
export type ApprovalInput = {
  expectedTargetSha: string;
  candidateSha: string;
  configurationRevision: string;
  idempotencyKey: string;
};
export type Authorization = LandingAuthorizationReceipt;
export type LandingResult = LandingResultReceipt;
export interface Api {
  openrouter?: OpenRouterConnectionApi;
  repositories?: RepositoryApi;
  capabilities(): Promise<LandingCapabilities>;
  approve(runId: string, input: ApprovalInput): Promise<Authorization>;
  land(runId: string, authorizationId: string): Promise<LandingResult>;
  reconcile(runId: string, authorizationId: string): Promise<LandingResult>;
  projects(): Promise<Project[]>;
  threads(projectId: string): Promise<Thread[]>;
  setThreadArchived?(projectId: string, threadId: string, archived: boolean): Promise<Thread>;
  snapshot(threadId: string): Promise<Snapshot>;
  latestRun?(threadId: string): Promise<Run | undefined>;
  createThread(projectId: string, title: string, key: string): Promise<Thread>;
  setThreadModelSelection?(
    projectId: string,
    threadId: string,
    selection: ModelSelection,
  ): Promise<Thread>;
  setModelSettings?(projectId: string, settings: ModelSettings): Promise<ModelSettings>;
  attachmentUrl?(threadId: string, attachmentId: string): string;
  send(
    threadId: string,
    content: string,
    key: string,
    attachments?: SubmittedAttachment[],
    selection?: ModelSelection,
  ): Promise<unknown>;
}
export class ApiError extends Error {
  constructor(public status: number) {
    super(
      status === 403 || status === 401
        ? "Access is unavailable. Ask the project owner to enable protected access."
        : status === 409
          ? "The thread changed. Refresh before trying again."
          : status === 413
            ? "This message is too large. Shorten it and try again."
            : status === 429
              ? "The crew is at capacity. Wait for an active change to finish, then try again."
              : "Could not reach Pitcrew. Your draft is saved here; try again.",
    );
  }
}
let sessionRequest: Promise<string | null> | undefined;
async function sessionNonce(): Promise<string | null> {
  const response = await fetch("/api/local-session", { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new ApiError(response.status);
  const { nonce } = (await response.json()) as { nonce: string | null };
  if (nonce !== null && (typeof nonce !== "string" || !/^[a-f0-9]{64}$/.test(nonce)))
    throw new ApiError(0);
  return nonce;
}
export async function mutationHeaders(): Promise<Record<string, string>> {
  // Share only in-flight bootstrap, so simultaneous first mutations use one cookie.
  sessionRequest ??= sessionNonce().finally(() => {
    sessionRequest = undefined;
  });
  const nonce = await sessionRequest;
  return {
    "Content-Type": "application/json",
    ...(nonce ? { "X-Pitcrew-Local-Nonce": nonce } : {}),
  };
}
export async function apiFetch(path: string, body?: unknown): Promise<Response> {
  const send = async () => {
    const headers = body ? await mutationHeaders() : undefined;
    const response = await fetch(`/api${path}`, {
      method: body ? "POST" : "GET",
      signal: AbortSignal.timeout(10000),
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { response, local: !!headers?.["X-Pitcrew-Local-Nonce"] };
  };
  const first = await send();
  // A rejected local admission has no side effects. Another tab may have
  // established the session cookie while our initial bootstrap was in flight.
  if (first.local && first.response.status === 403) return (await send()).response;
  return first.response;
}
async function request<T>(path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await apiFetch(path, body);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(0);
  }
  if (!response.ok) throw new ApiError(response.status);
  try {
    return (await response.json()) as T;
  } catch {
    throw new ApiError(0);
  }
}
async function connectionRequest(path: string, init?: RequestInit): Promise<OpenRouterStatus> {
  const response = await fetch(path, {
    ...init,
    cache: "no-store",
    signal: AbortSignal.timeout(90000),
  });
  if (!response.ok) throw new ApiError(0);
  const value = (await response.json()) as OpenRouterStatus;
  if (
    !value ||
    [value.available, value.configured, value.executionEnabled].some(
      (flag) => typeof flag !== "boolean",
    )
  )
    throw new ApiError(0);
  return {
    available: value.available,
    configured: value.configured,
    executionEnabled: value.executionEnabled,
    storageAvailable: value.storageAvailable === true,
  };
}
async function connectionMutation(
  body: { action: "store"; key: string } | { action: "remove" },
): Promise<OpenRouterStatus> {
  const session = await fetch("/api/provider-connection/openrouter/session", {
    cache: "no-store",
    signal: AbortSignal.timeout(10000),
  });
  if (!session.ok) throw new ApiError(0);
  const { nonce } = (await session.json()) as { nonce?: unknown };
  if (nonce !== null && (typeof nonce !== "string" || !/^[a-f0-9]{64}$/.test(nonce)))
    throw new ApiError(0);
  return connectionRequest("/api/provider-connection/openrouter", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(nonce ? { "X-Pitcrew-Connection-Nonce": nonce } : {}),
    },
    body: JSON.stringify(body),
  });
}
export const httpApi: Api = {
  repositories: createRepositoryApi(),
  openrouter: {
    async status() {
      return connectionRequest("/api/provider-connection/openrouter");
    },
    store: (key) => connectionMutation({ action: "store", key }),
    remove: () => connectionMutation({ action: "remove" }),
  },
  attachmentUrl: (threadId, attachmentId) =>
    `/api/threads/${encodeURIComponent(threadId)}/attachments/${encodeURIComponent(attachmentId)}`,
  async capabilities() {
    const capabilities = await request<LandingCapabilities>("/capabilities");
    if (
      capabilities.composer?.conversation &&
      capabilities.composer.models.some(
        (model) => !["fixture", "pitcrew-fixture"].includes(model.provider),
      )
    )
      return capabilities;
    try {
      const display = await request<{
        models: ModelChoice[];
        catalogRevision?: string;
        defaultSelection?: ModelSelection;
      }>("/provider-connection/openrouter/models");
      if (
        !display.models?.length ||
        !/^[a-f0-9]{64}$/.test(display.catalogRevision ?? "") ||
        !display.defaultSelection
      )
        return capabilities;
      return {
        ...capabilities,
        composer: {
          models: display.models,
          settings: { default: display.defaultSelection },
          catalogRevision: display.catalogRevision,
          conversation: false,
          displayOnly: true,
          executionEnabled: false,
        },
      };
    } catch {
      return capabilities;
    }
  },
  approve: (id, input) => request(`/runs/${encodeURIComponent(id)}/merge-approval`, input),
  land: (id, authorizationId) =>
    request(`/runs/${encodeURIComponent(id)}/landing`, { authorizationId }),
  reconcile: (id, authorizationId) =>
    request(`/runs/${encodeURIComponent(id)}/landing/reconcile`, { authorizationId }),
  projects: () => request("/projects"),
  threads: (id) => request(`/projects/${encodeURIComponent(id)}/threads`),
  setThreadArchived: (projectId, id, archived) =>
    request(
      `/projects/${encodeURIComponent(projectId)}/threads/${encodeURIComponent(id)}/archive`,
      { archived },
    ),
  latestRun: async (id) => (await request<Run[]>(`/threads/${encodeURIComponent(id)}/runs`)).at(-1),
  snapshot: async (id) => {
    const path = `/threads/${encodeURIComponent(id)}`;
    const [messages, runs, turns] = await Promise.all([
      request<Message[]>(`${path}/messages`),
      request<Run[]>(`${path}/runs`),
      request<NonNullable<Snapshot["turns"]>>(`${path}/turns`),
    ]);
    const evidence = await Promise.all(
      runs.map((run) => request<RunEvidence>(`/runs/${encodeURIComponent(run.id)}/evidence`)),
    );
    return {
      messages,
      turns,
      runs: evidence.map((item) => item.run),
      reviews: evidence.flatMap((item) => item.reviews),
      evidence,
    };
  },
  createThread: (id, title, idempotencyKey) =>
    request(`/projects/${encodeURIComponent(id)}/threads`, { title, idempotencyKey }),
  setThreadModelSelection: (projectId, id, modelSelection) =>
    request(
      `/projects/${encodeURIComponent(projectId)}/threads/${encodeURIComponent(id)}/model-selection`,
      { modelSelection },
    ),
  setModelSettings: (projectId, settings) =>
    request(`/projects/${encodeURIComponent(projectId)}/model-settings`, { settings }),
  send: (id, content, idempotencyKey, attachments, modelSelection) =>
    request(`/threads/${encodeURIComponent(id)}/messages`, {
      content,
      idempotencyKey,
      attachments,
      modelSelection,
    }),
};
