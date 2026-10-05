import type { FrozenRunModels, Message, RepositoryContext } from "@pitcrew/protocol";
export interface ConversationTurn {
  id: string;
  threadId: string;
  messageId: string;
  status: "queued" | "running" | "completed" | "failed";
  models: FrozenRunModels;
  actor: string;
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
