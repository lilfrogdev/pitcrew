export * from "./mentions.ts";
import type {
  CurrentKnowledge,
  KnowledgeRecord,
  EventProvenance,
  WorkerKnowledgeContext,
} from "./knowledge.ts";
export * from "./knowledge.ts";
export * from "./attachments.ts";
export * from "./uploads.ts";
export * from "./models.ts";
import type { ModelSelection, ModelSettings, FrozenRunModels } from "./models.ts";
import type { MessageAttachment, SubmittedAttachment } from "./attachments.ts";
import type { VerificationPlan, CheckOutcome } from "../../verification/src/index.ts";
export interface Project {
  modelSettings?: ModelSettings;
  id: string;
  name: string;
  repository: string;
  baseSha: string;
  configurationRevision: string;
}
export interface Thread {
  modelSelection?: ModelSelection;
  id: string;
  projectId: string;
  title: string;
  // Optional for legacy clients; persisted coordinators normalize this to false.
  archived?: boolean;
}
export interface Change {
  /** Frozen historical discussion; reference data, never a new task authorization. */
  conversationContext?: Message[];
  id: string;
  threadId: string;
  originMessageIds: string[];
  contextRevision: string;
}
export interface Message {
  mentions?: import("./mentions.ts").MessageMention[];
  /** Verified application identity snapshot; never supplied by the message body. */
  author?: {
    actor: string;
    email: string;
    displayName?: string;
    username?: string;
    avatar?: string | null;
  };
  attachments?: MessageAttachment[];
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
  artifactAdmission?: ArtifactRunAdmission;
  runModels?: FrozenRunModels;
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
  error?:
    | "execution_unavailable"
    | "execution_failed"
    | "reconciliation_required"
    | "model_configuration_changed";
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
  verificationGaps?: string[];
  planFingerprint?: string;
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
  provenance?: EventProvenance;
  knowledge?: KnowledgeRecord;
  sequence: number;
  projectId: string;
  type:
    | "conversation.queued"
    | "conversation.started"
    | "conversation.completed"
    | "conversation.failed"
    | "knowledge.changed"
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
  mentions?: import("./mentions.ts").SubmittedMention[];
  attachments?: SubmittedAttachment[];
  content: string;
  idempotencyKey: string;
}
export interface SubmitResult {
  change?: Change;
  message: Message;
  run: Run;
}
export interface ArtifactRunAdmission {
  sourceName: string;
  sourceRepositoryId: string;
  fingerprint: string;
  deadline: number;
}
export interface ExecutionInput {
  /** Frozen by the repository authority after its durable infrastructure reservation. */
  artifactAdmission?: ArtifactRunAdmission;
  /** Trusted initiating identity; never a credential or client-selected owner. */
  credentialActor?: string;
  conversationContext?: Message[];
  runModels?: FrozenRunModels;
  knowledgeContext?: WorkerKnowledgeContext;
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
  currentKnowledge?: CurrentKnowledge;
  revision: string;
  baseSha: string;
  configurationRevision: string;
  acceptedDecisions: { id: string; text: string; sourceRevision: string }[];
  activeWorkOmitted?: number;
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
  backend: "fixture" | "artifacts";
}
export interface LandingResultReceipt {
  authorizationId: string;
  status: "landed" | "rejected" | "uncertain";
  code?: string;
  landedSha?: string;
  backend: "fixture" | "artifacts";
}
export type * from "./source";
