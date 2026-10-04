export interface KnowledgeSource {
  kind: "message" | "artifact" | "code" | "report" | "review" | "pi-call" | "policy";
  id: string;
  revision?: string;
  path?: string;
}
export interface WorkerKnowledgeContext {
  attemptId: string;
  projectId: string;
  repository: string;
  threadId: string;
  changeId: string;
  runId: string;
  baseSha: string;
  configurationRevision: string;
  contextRevision: string;
}
export interface KnowledgeReport {
  key: string;
  text: string;
  kind: "discovery" | "constraint" | "decision";
  sourceRefs: KnowledgeSource[];
}
export interface KnowledgeAck {
  eventId: string;
  status: "recorded" | "duplicate" | "stale" | "rejected";
}
export interface KnowledgeMutation {
  id: string;
  expectedVersion: number;
  status: "proposed" | "accepted" | "superseded";
  text: string;
  kind: KnowledgeReport["kind"];
  sourceRefs: KnowledgeSource[];
  reason: string;
}
export interface KnowledgeRecord extends Omit<KnowledgeMutation, "expectedVersion"> {
  version: number;
  eventId: string;
  actor: { kind: "principal" | "worker" | "application"; id: string };
  projectId: string;
  repository: string;
  visibility: "repository";
  baseSha: string;
  configurationRevision: string;
  threadId?: string;
  changeId?: string;
  runId?: string;
}
export interface CurrentKnowledge {
  revision: number;
  complete: true;
  entries: KnowledgeRecord[];
}
export interface EventProvenance {
  actor: KnowledgeRecord["actor"];
  repository: string;
  baseSha: string;
  candidateSha?: string;
  configurationRevision: string;
  threadId?: string;
  changeId?: string;
  runId?: string;
  sourceRefs: KnowledgeSource[];
  outcome?:
    | "candidate_recorded"
    | "review_approved"
    | "review_changes_requested"
    | "fixture_landed";
}
