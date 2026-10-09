import type {
  CurrentKnowledge,
  KnowledgeRecord,
  EventProvenance,
  WorkerKnowledgeContext,
} from "./knowledge.ts";
export * from "./knowledge.ts";
export * from "./attachments.ts";
export * from "./models.ts";
import type { ModelSelection, ModelSettings, FrozenRunModels } from "./models.ts";
import type { MessageAttachment, SubmittedAttachment } from "./attachments.ts";
import type {
  VerificationPlan,
  CheckOutcome,
  ContractSnapshot,
  Check,
  AcceptanceCriteria,
} from "../../verification/src/index.ts";
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
export type CrewRole =
  | "repository"
  | "planner"
  | "coordinator"
  | "implementer"
  | "test_runner"
  | "test_agent"
  | "reviewer";
export type TraceStatus = "waiting" | "active" | "passed" | "failed" | "skipped" | "stopped";
export interface Message {
  attachments?: MessageAttachment[];
  /** Stable crew identity. Legacy messages omit it and keep their original role label. */
  crew?: CrewRole;
  id: string;
  threadId: string;
  role: "user" | "coordinator" | "worker" | "reviewer";
  content: string;
  createdAt: string;
}
export interface TraceNode {
  id: string;
  threadId: string;
  runId?: string;
  missionId?: string;
  role: CrewRole;
  stage: string;
  status: TraceStatus;
  title: string;
  summary: string;
  sequence: number;
  createdAt: string;
  updatedAt: string;
  revision?: string;
  candidateSha?: string;
}
export interface TraceEdge {
  id: string;
  threadId: string;
  runId?: string;
  from: string;
  to: string;
  label: string;
  sequence: number;
  createdAt: string;
}
export interface ProbeEvidence {
  id: string;
  threadId: string;
  runId: string;
  purpose: string;
  command: string[];
  candidateSha: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  reproducible: boolean;
  blocking: boolean;
}
export interface OrchestrationTrace {
  nodes: TraceNode[];
  edges: TraceEdge[];
  /** Ordered status snapshots so replay can show thinking → passed for the same stage. */
  steps: TraceNode[];
  probes: ProbeEvidence[];
  sequence: number;
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
    | "review.created"
    | "mission.updated"
    | "orchestration.updated";
  entityId: string;
  createdAt: string;
}
export type MissionStatus =
  | "clarifying"
  | "proposed"
  | "approved"
  | "running"
  | "awaiting_review"
  | "completed"
  | "failed"
  | "stopped";
export interface MissionQuestion {
  id: string;
  prompt: string;
  answer?: string;
}
export interface MissionProposal {
  revision: string;
  summary: string;
  affectedArea: string;
  acceptance: AcceptanceCriteria;
  checks: Check[];
  digest: string;
}
export interface Mission {
  id: string;
  projectId: string;
  threadId: string;
  messageId: string;
  status: MissionStatus;
  request: string;
  questions: MissionQuestion[];
  proposal?: MissionProposal;
  approvedRevision?: string;
  changeId?: string;
  runId?: string;
  contract?: ContractSnapshot;
}
export interface SubmitMessage {
  attachments?: SubmittedAttachment[];
  content: string;
  idempotencyKey: string;
}
export interface SubmitResult {
  change?: Change;
  message: Message;
  run: Run;
}
export interface ExecutionInput {
  /** Trusted initiating identity; never a credential or client-selected owner. */
  credentialActor?: string;
  conversationContext?: Message[];
  runModels?: FrozenRunModels;
  knowledgeContext?: WorkerKnowledgeContext;
  verificationPlan?: VerificationPlan;
  contractSnapshot?: ContractSnapshot;
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
  backend: "fixture";
}
export interface LandingResultReceipt {
  authorizationId: string;
  status: "landed" | "rejected" | "uncertain";
  code?: string;
  landedSha?: string;
  backend: "fixture";
}
