import type {
  CurrentKnowledge,
  Event,
  KnowledgeMutation,
  WorkerKnowledgeContext,
} from "../../../packages/protocol/src/index.ts";

export const KNOWLEDGE_LIMITS = {
  page: 256,
  entries: 100,
  projectionBytes: 65536,
  recordBytes: 4096,
};
// Metadata only: extracted text must never contain credentials or raw secret values.
const secrets =
  /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})\b|(?:password|secret|token|api[_ -]?key)\s*[:=]\s*["']?[^\s"']{8,})/i;
export function validKnowledge(input: KnowledgeMutation): boolean {
  if (
    !input ||
    typeof input !== "object" ||
    typeof input.id !== "string" ||
    !/^[A-Za-z0-9:_-]{1,256}$/.test(input.id) ||
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion < 0 ||
    !["proposed", "accepted", "superseded"].includes(input.status) ||
    !["discovery", "constraint", "decision"].includes(input.kind) ||
    typeof input.text !== "string" ||
    !input.text.trim() ||
    input.text.length > 512 ||
    typeof input.reason !== "string" ||
    !input.reason.trim() ||
    input.reason.length > 256 ||
    !Array.isArray(input.sourceRefs) ||
    !input.sourceRefs.length ||
    input.sourceRefs.length > 8
  )
    return false;
  for (const ref of input.sourceRefs) {
    if (
      !ref ||
      !["message", "artifact", "code", "report", "review", "pi-call", "policy"].includes(
        ref.kind,
      ) ||
      typeof ref.id !== "string" ||
      !ref.id.trim() ||
      ref.id.length > 200 ||
      (ref.revision !== undefined &&
        (typeof ref.revision !== "string" || ref.revision.length > 200)) ||
      (ref.path !== undefined && (typeof ref.path !== "string" || ref.path.length > 200))
    )
      return false;
  }
  const serialized = JSON.stringify(input);
  return (
    new TextEncoder().encode(serialized).length <= KNOWLEDGE_LIMITS.recordBytes &&
    !secrets.test(serialized)
  );
}
function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
const contextFields = [
  "attemptId",
  "projectId",
  "repository",
  "threadId",
  "changeId",
  "runId",
  "baseSha",
  "configurationRevision",
  "contextRevision",
] as const satisfies readonly (keyof WorkerKnowledgeContext)[];

// Transport serialization may reorder keys; fencing depends on every field's value.
export function sameKnowledgeContext(
  input: WorkerKnowledgeContext,
  frozen: WorkerKnowledgeContext,
): boolean {
  return (
    !!input &&
    typeof input === "object" &&
    Object.keys(input).length === contextFields.length &&
    contextFields.every((field) => nonempty(input[field]) && input[field] === frozen[field])
  );
}
// One authoritative journal; scope must match both project and repository. Legacy
// objective events have no knowledge payload and never become inferred decisions.
export function applyKnowledgePage(
  current: CurrentKnowledge,
  events: readonly Event[],
  projectId: string,
  repository: string,
): CurrentKnowledge {
  if (events.length > KNOWLEDGE_LIMITS.page) throw Error("knowledge_page_capacity");
  const entries = new Map(current.entries.map((entry) => [entry.id, structuredClone(entry)]));
  let revision = current.revision;
  for (const event of events) {
    const record = event.knowledge;
    if (
      !record ||
      event.projectId !== projectId ||
      record.projectId !== projectId ||
      record.repository !== repository
    )
      continue;
    const previous = entries.get(record.id);
    if (
      event.type !== "knowledge.changed" ||
      !Number.isSafeInteger(event.sequence) ||
      event.sequence <= revision ||
      event.entityId !== record.id ||
      !validKnowledge({ ...record, expectedVersion: record.version - 1 }) ||
      record.version !== (previous?.version ?? 0) + 1 ||
      !nonempty(record.eventId) ||
      !record.actor ||
      !["principal", "worker", "application"].includes(record.actor.kind) ||
      !nonempty(record.actor.id) ||
      record.visibility !== "repository" ||
      !nonempty(record.baseSha) ||
      !nonempty(record.configurationRevision) ||
      (record.actor.kind === "worker" && record.status !== "proposed") ||
      (!previous && record.status === "superseded") ||
      (previous?.status === "accepted" && record.status === "proposed") ||
      previous?.status === "superseded"
    )
      throw Error("invalid_knowledge_history");
    entries.set(record.id, structuredClone(record));
    revision = event.sequence;
  }
  const result: CurrentKnowledge = { revision, complete: true, entries: [...entries.values()] };
  if (
    entries.size > KNOWLEDGE_LIMITS.entries ||
    new TextEncoder().encode(JSON.stringify(result)).length > KNOWLEDGE_LIMITS.projectionBytes
  )
    throw Error("knowledge_projection_capacity");
  return result;
}

// Offline replay/migration only. Routine coordinator reads use the persisted projection.
export function projectKnowledge(
  events: readonly Event[],
  projectId: string,
  repository: string,
): CurrentKnowledge {
  let current: CurrentKnowledge = { revision: 0, complete: true, entries: [] };
  for (let offset = 0; offset < events.length; offset += KNOWLEDGE_LIMITS.page)
    current = applyKnowledgePage(
      current,
      events.slice(offset, offset + KNOWLEDGE_LIMITS.page),
      projectId,
      repository,
    );
  return current;
}
