export interface Project {
  id: string;
  name: string;
  repository: string;
  baseSha: string;
  configurationRevision: string;
}
export interface Thread {
  id: string;
  projectId: string;
  title: string;
}
export interface Message {
  id: string;
  threadId: string;
  role: "user" | "coordinator" | "worker" | "reviewer";
  content: string;
  createdAt: string;
}
export type RunStatus =
  | "queued"
  | "running"
  | "awaiting_review"
  | "waiting_user"
  | "completed"
  | "failed"
  | "stopped";
export interface Run {
  messageId?: string;
  id: string;
  threadId: string;
  status: RunStatus;
  baseSha: string;
  candidateSha?: string;
  configurationRevision: string;
  workerId?: string;
  artifactId?: string;
  error?: "execution_unavailable" | "execution_failed" | "reconciliation_required";
}
export interface TestEvidence {
  baseSha: string;
  candidateSha: string;
  configurationRevision: string;
  status: "passed" | "failed" | "not_run";
  argv: string[];
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
}
export interface Review {
  id: string;
  runId: string;
  decision: "approve" | "request_changes";
  summary: string;
  actor: string;
  baseSha: string;
  candidateSha: string;
  configurationRevision: string;
}
export interface Event {
  sequence: number;
  projectId: string;
  type:
    | "thread.created"
    | "message.created"
    | "run.queued"
    | "run.started"
    | "run.awaiting_review"
    | "run.completed"
    | "run.failed"
    | "review.created";
  entityId: string;
  createdAt: string;
}
export interface SubmitMessage {
  content: string;
  idempotencyKey: string;
}
export interface SubmitResult {
  message: Message;
  run: Run;
}
export interface ExecutionInput {
  repositoryContext?: RepositoryContext;
  runId: string;
  projectId: string;
  threadId: string;
  repository: string;
  baseSha: string;
  configurationRevision: string;
  messages: Message[];
}
export interface ExecutionResult {
  workerId: string;
  artifactId: string;
  baseSha: string;
  candidateSha: string;
  summary: string;
  tests: TestEvidence;
  review?: Pick<
    Review,
    "decision" | "summary" | "actor" | "baseSha" | "candidateSha" | "configurationRevision"
  >;
}
// Implementations must reconcile persisted runId operations before repeating mutations.
export interface ExecutionAdapter {
  delegate(input: ExecutionInput, signal?: AbortSignal): Promise<ExecutionResult>;
}
export interface RunEvidence {
  run: Run;
  tests?: TestEvidence;
  reviews: Review[];
}
export type ModelConfiguration =
  | { provider: "fake" }
  | { provider: "cloudflare"; model: string }
  | { provider: "byok"; providerId: string; model: string; secretBinding: string };

export interface RepositoryContext {
  revision: string;
  baseSha: string;
  configurationRevision: string;
  acceptedDecisions: { id: string; text: string; sourceRevision: string }[];
  activeWork: {
    runId: string;
    threadId: string;
    title: string;
    status: RunStatus;
    intent: string;
  }[];
}
