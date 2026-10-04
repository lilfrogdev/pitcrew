import { AdmissionError } from "./coordinator";

// Call mutations on a draft within the host's synchronous aggregate transaction.
// Scope and actor come from trusted admission, never from an untrusted request body.
export interface IntakeReportInput {
  source: { system: string; id: string; url?: string };
  occurredAt: string;
  content: string;
}
export interface IntakeReport extends IntakeReportInput {
  id: string;
  scope: string;
  actor: string;
  receivedAt: string;
  groupId: string;
  dispatch?: IntakeLink;
}
export interface IntakeLink {
  threadId: string;
  changeId: string;
  runId: string;
}
export interface IntakeGroup {
  id: string;
  scope: string;
  title: string;
  revision: number;
}
export interface IntakeState {
  reports: IntakeReport[];
  groups: IntakeGroup[];
  keys: Record<string, { body: string; result: unknown }>;
}
export const initialIntake = (): IntakeState => ({ reports: [], groups: [], keys: {} });
export interface IntakeContext {
  scope: string;
  actor: string;
  now: () => string;
  id: () => string;
}
function valid(value: unknown, max: number): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new AdmissionError("invalid_intake_input");
}
function context(c: IntakeContext) {
  valid(c.scope, 256);
  valid(c.actor, 256);
}
function group(state: IntakeState, scope: string, id: string) {
  const result = state.groups.find((g) => g.id === id && g.scope === scope);
  if (!result) throw new AdmissionError("not_found", 404);
  return result;
}
function operation<T>(
  state: IntakeState,
  c: IntakeContext,
  key: string,
  body: unknown,
  apply: () => T,
): T {
  context(c);
  if (typeof key !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(key))
    throw new AdmissionError("invalid_idempotency_key");
  const identity = JSON.stringify([c.scope, c.actor, key]);
  const serialized = JSON.stringify(body);
  const previous = state.keys[identity];
  if (previous) {
    if (previous.body !== serialized) throw new AdmissionError("idempotency_conflict", 409);
    return structuredClone(previous.result) as T;
  }
  if (Object.keys(state.keys).length >= 500) throw new AdmissionError("capacity", 429);
  const result = apply();
  state.keys[identity] = { body: serialized, result: structuredClone(result) };
  return structuredClone(result);
}
export function receiveReport(state: IntakeState, c: IntakeContext, input: IntakeReportInput) {
  context(c);
  valid(input?.source?.system, 128);
  valid(input?.source?.id, 256);
  valid(input?.content, 8000);
  valid(input?.occurredAt, 64);
  if (!Number.isFinite(Date.parse(input.occurredAt))) throw new AdmissionError("invalid_timestamp");
  if (input.source.url !== undefined) {
    valid(input.source.url, 2048);
    try {
      if (!["http:", "https:"].includes(new URL(input.source.url).protocol)) throw Error();
    } catch {
      throw new AdmissionError("invalid_source_url");
    }
  }
  // Explicit field order makes identical deliveries independent of JSON property order.
  const original = {
    source: {
      system: input.source.system,
      id: input.source.id,
      ...(input.source.url === undefined ? {} : { url: input.source.url }),
    },
    occurredAt: input.occurredAt,
    content: input.content,
  };
  const previous = state.reports.find(
    (r) =>
      r.scope === c.scope &&
      r.source.system === input.source.system &&
      r.source.id === input.source.id,
  );
  if (previous) {
    const same =
      previous.actor === c.actor &&
      previous.occurredAt === original.occurredAt &&
      previous.content === original.content &&
      JSON.stringify(previous.source) === JSON.stringify(original.source);
    if (!same) throw new AdmissionError("source_delivery_conflict", 409);
    return structuredClone(previous);
  }
  if (state.reports.length >= 500 || state.groups.length >= 500)
    throw new AdmissionError("capacity", 429);
  const g: IntakeGroup = {
    id: c.id(),
    scope: c.scope,
    title: input.content.slice(0, 200),
    revision: 1,
  };
  const report: IntakeReport = {
    ...original,
    id: c.id(),
    scope: c.scope,
    actor: c.actor,
    receivedAt: c.now(),
    groupId: g.id,
  };
  state.groups.push(g);
  state.reports.push(report);
  return structuredClone(report);
}
export function intakeGroups(state: IntakeState, scope: string) {
  return state.groups
    .filter((g) => g.scope === scope)
    .map((g) => {
      const reports = state.reports.filter((r) => r.scope === scope && r.groupId === g.id);
      const links = reports.flatMap((r) => (r.dispatch ? [r.dispatch] : []));
      return structuredClone({
        ...g,
        reports,
        links,
        status: reports.length === 0 ? "empty" : links.length ? "linked" : "collecting",
      });
    });
}
export interface MoveReports {
  reportIds: string[];
  revisions: Record<string, number>;
  targetGroupId?: string;
  title?: string;
}
// Moving to a new group also implements split; dispatched evidence retains its link.
export function moveReports(state: IntakeState, c: IntakeContext, key: string, input: MoveReports) {
  return operation(state, c, key, { move: input }, () => {
    if (
      !Array.isArray(input.reportIds) ||
      !input.reportIds.length ||
      input.reportIds.length > 500 ||
      new Set(input.reportIds).size !== input.reportIds.length
    )
      throw new AdmissionError("invalid_reports");
    const reports = input.reportIds.map((id) => {
      const r = state.reports.find((r) => r.id === id && r.scope === c.scope);
      if (!r) throw new AdmissionError("not_found", 404);
      return r;
    });
    const affected = new Set(reports.map((r) => r.groupId));
    if (input.targetGroupId) affected.add(input.targetGroupId);
    for (const id of affected) {
      if (group(state, c.scope, id).revision !== input.revisions?.[id])
        throw new AdmissionError("group_revision_conflict", 409);
    }
    if (!input.targetGroupId) {
      valid(input.title, 200);
      if (state.groups.length >= 500) throw new AdmissionError("capacity", 429);
    }
    const target = input.targetGroupId
      ? group(state, c.scope, input.targetGroupId)
      : { id: c.id(), scope: c.scope, title: input.title!, revision: 1 };
    if (!input.targetGroupId) state.groups.push(target);
    for (const r of reports) r.groupId = target.id;
    for (const id of affected) group(state, c.scope, id).revision++;
    return target;
  });
}
export interface AssociationSuggestion {
  groupId: string;
  reportIds: string[];
  evidence: string;
}
export function associationSuggestion(
  state: IntakeState,
  scope: string,
  suggestion: AssociationSuggestion,
) {
  group(state, scope, suggestion.groupId);
  valid(suggestion.evidence, 2000);
  if (
    !Array.isArray(suggestion.reportIds) ||
    !suggestion.reportIds.length ||
    suggestion.reportIds.length > 500 ||
    suggestion.reportIds.some((id) => !state.reports.some((r) => r.id === id && r.scope === scope))
  )
    throw new AdmissionError("not_found", 404);
  return structuredClone(suggestion); // suggestion only; no report or group mutation
}
export interface DispatchIntake {
  groupId: string;
  revision: number;
  activeChange?: IntakeLink;
}
export interface IntakeDispatchAdapter {
  // Both methods must be synchronous, local, and part of the same host transaction.
  // Require matching scope, thread/change/run ownership, and active status.
  verifyActive: (scope: string, link: IntakeLink) => void;
  create: (group: IntakeGroup, reports: IntakeReport[]) => IntakeLink;
}
export function dispatchIntake(
  state: IntakeState,
  c: IntakeContext,
  key: string,
  input: DispatchIntake,
  adapter: IntakeDispatchAdapter,
) {
  return operation(state, c, key, { dispatch: input }, () => {
    const g = group(state, c.scope, input.groupId);
    if (g.revision !== input.revision) throw new AdmissionError("group_revision_conflict", 409);
    const reports = state.reports.filter((r) => r.scope === c.scope && r.groupId === g.id);
    if (!reports.length) throw new AdmissionError("empty_group", 409);
    const linked = reports.flatMap((r) => (r.dispatch ? [r.dispatch] : []));
    if (input.activeChange) linked.push(input.activeChange);
    if (new Set(linked.map((l) => JSON.stringify([l.threadId, l.changeId, l.runId]))).size > 1)
      throw new AdmissionError("multiple_changes", 409);
    let link = linked[0];
    if (link) adapter.verifyActive(c.scope, structuredClone(link));
    else link = adapter.create(structuredClone(g), structuredClone(reports));
    valid(link?.threadId, 256);
    valid(link?.changeId, 256);
    valid(link?.runId, 256);
    for (const r of reports) r.dispatch = structuredClone(link);
    return { ...link, groupId: g.id, revision: g.revision, reportIds: reports.map((r) => r.id) };
  });
}
