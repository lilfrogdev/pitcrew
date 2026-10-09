import type {
  FrozenRunModels,
  Message,
  RepositoryContext,
  RepositoryMemoryBrief,
} from "@pitcrew/protocol";
export interface ConversationTurn {
  id: string;
  threadId: string;
  messageId: string;
  status: "queued" | "running" | "completed" | "failed";
  models: FrozenRunModels;
  actor: string;
  membershipActor?: string;
  /** Server-frozen trial profile; excluded from the model prompt. */
  canaryId?: string;
  baseSha: string;
  configurationRevision: string;
  createdAt: string;
  contextBudgetBytes?: number;
  runId?: string;
  replyMessageId?: string;
  error?: string;
  input?: ConversationInput;
}
export interface ConversationInput {
  canaryId?: string;
  /** Server-frozen source admission; excluded from the model prompt. */
  memoryMessageIds?: string[];
  memoryEventSequence?: number;
  memoryEnabled?: boolean;
  memoryBrief?: RepositoryMemoryBrief;
  credentialActor?: string;
  turnId: string;
  threadId: string;
  projectId: string;
  messageId: string;
  models: FrozenRunModels;
  baseSha: string;
  configurationRevision: string;
  repositoryContext: RepositoryContext;
  messages: Message[];
}
export interface ConversationReceipt {
  status: "running" | "completed" | "failed";
  text?: string;
  error?: string;
}
