import type {
  Project,
  Thread,
  Message,
  Run,
  Review,
  RunEvidence,
  LandingAuthorizationReceipt,
  LandingResultReceipt,
} from "@pitcrew/protocol";
export type { Project, Thread, Message, Run, Review } from "@pitcrew/protocol";
export type Snapshot = {
  messages: Message[];
  runs: Run[];
  reviews: Review[];
  evidence: RunEvidence[];
};
export type LandingCapabilities = { landing: { enabled: boolean; backend: "fixture" | null } };
export type ApprovalInput = {
  expectedTargetSha: string;
  candidateSha: string;
  configurationRevision: string;
  idempotencyKey: string;
};
export type Authorization = LandingAuthorizationReceipt;
export type LandingResult = LandingResultReceipt;
export interface Api {
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
  send(threadId: string, content: string, key: string): Promise<unknown>;
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
async function request<T>(path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method: body ? "POST" : "GET",
      signal: AbortSignal.timeout(10000),
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0);
  }
  if (!response.ok) throw new ApiError(response.status);
  try {
    return (await response.json()) as T;
  } catch {
    throw new ApiError(0);
  }
}
export const httpApi: Api = {
  capabilities: () => request("/capabilities"),
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
    const [messages, runs] = await Promise.all([
      request<Message[]>(`${path}/messages`),
      request<Run[]>(`${path}/runs`),
    ]);
    const evidence = await Promise.all(
      runs.map((run) => request<RunEvidence>(`/runs/${encodeURIComponent(run.id)}/evidence`)),
    );
    return {
      messages,
      runs: evidence.map((item) => item.run),
      reviews: evidence.flatMap((item) => item.reviews),
      evidence,
    };
  },
  createThread: (id, title, idempotencyKey) =>
    request(`/projects/${encodeURIComponent(id)}/threads`, { title, idempotencyKey }),
  send: (id, content, idempotencyKey) =>
    request(`/threads/${encodeURIComponent(id)}/messages`, { content, idempotencyKey }),
};
