import type { VerificationPlan, CheckOutcome } from "../../verification/src/index.ts";
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
export interface Change {
  id: string;
  threadId: string;
  originMessageIds: string[];
  contextRevision: string;
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
  landing?: LandingResultReceipt;
  // Optional only for legacy wire records; coordinator assigns every stored run.
  changeId?: string;
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
    | "change.created"
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
  change?: Change;
  message: Message;
  run: Run;
}
export interface ExecutionInput {
  verificationPlan?: VerificationPlan;
  changeId?: string;
  repositoryContext?: RepositoryContext;
  runId: string;
  projectId: string;
  threadId: string;
  repository: string;
  baseSha: string;
  configurationRevision: string;
  messages: Message[];
}
export interface VerificationEvidence {
  plan: VerificationPlan;
  outcomes: CheckOutcome[];
}
export interface ExecutionResult {
  verification?: VerificationEvidence;
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
  verification?: VerificationEvidence;
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

export interface LandingAuthorizationReceipt {
  authorizationId: string;
  runId: string;
  expectedTargetSha: string;
  candidateSha: string;
  configurationRevision: string;
  expiresAt: number;
  state: "authorized" | "pending" | "landed" | "rejected" | "uncertain";
  backend: "fixture";
}
export interface LandingResultReceipt {
  authorizationId: string;
  status: "landed" | "rejected" | "uncertain";
  code?: string;
  landedSha?: string;
  backend: "fixture";
}
