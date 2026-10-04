import type {
  Command,
  CommandResult,
  Workspace,
  WorkspaceTransport,
} from "../../execution/src/contracts.ts";
import { assertCommand, assertSha } from "../../execution/src/contracts.ts";
import type { Event, Review } from "../../protocol/src/index.ts";

export type Check =
  | { id: string; kind: "command"; command: Omit<Command, "commandId"> }
  | { id: string; kind: "runtime"; capability: string; description: string };
export interface VerificationProfile {
  projectId: string;
  revision: string;
  checks: Check[];
}
export interface AcceptanceCriteria {
  revision: string;
  criteria: { id: string; text: string; checkIds: string[] }[];
}
export interface PlanInput {
  projectId: string;
  changeId: string;
  baseSha: string;
  candidateSha: string;
  configurationRevision: string;
  profile: VerificationProfile;
  acceptance: AcceptanceCriteria;
  reproduceBaseline: boolean;
}
export interface VerificationPlan extends PlanInput {
  fingerprint: string;
}
export interface CheckOutcome {
  planFingerprint: string;
  checkId: string;
  phase: "baseline" | "candidate";
  status: "passed" | "failed" | "not_run" | "blocked";
  reason?: string;
  checkedSha: string;
  artifactId?: string;
  runId?: string;
  durationMs?: number;
  result?: CommandResult;
}
function requireText(value: string): void {
  if (typeof value !== "string" || !value.trim() || value.length > 4096)
    throw new Error("INVALID_PLAN");
}
function validate(input: PlanInput): void {
  assertSha(input.baseSha);
  assertSha(input.candidateSha);
  [
    input.projectId,
    input.changeId,
    input.configurationRevision,
    input.profile.revision,
    input.acceptance.revision,
  ].forEach(requireText);
  if (
    input.profile.projectId !== input.projectId ||
    typeof input.reproduceBaseline !== "boolean" ||
    input.profile.checks.length === 0 ||
    input.profile.checks.length > 32 ||
    input.acceptance.criteria.length === 0 ||
    input.acceptance.criteria.length > 64
  )
    throw new Error("INVALID_PLAN");
  const checks = new Set<string>();
  for (const check of input.profile.checks) {
    requireText(check.id);
    if (checks.has(check.id)) throw new Error("DUPLICATE_CHECK");
    checks.add(check.id);
    if (check.kind === "command") assertCommand({ ...check.command, commandId: check.id });
    else if (check.kind === "runtime") {
      requireText(check.capability);
      requireText(check.description);
    } else throw new Error("INVALID_CHECK");
  }
  const criteria = new Set<string>();
  for (const criterion of input.acceptance.criteria) {
    requireText(criterion.id);
    requireText(criterion.text);
    if (
      criteria.has(criterion.id) ||
      !criterion.checkIds.length ||
      new Set(criterion.checkIds).size !== criterion.checkIds.length ||
      criterion.checkIds.some((id) => !checks.has(id))
    )
      throw new Error("INVALID_CRITERION");
    criteria.add(criterion.id);
  }
}
// Canonical keys bind actual check definitions and criterion text, not just revision labels.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
async function digest(input: PlanInput): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(input)));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
export async function pinPlan(input: PlanInput): Promise<VerificationPlan> {
  const snapshot = structuredClone(input);
  validate(snapshot);
  return freeze({ ...snapshot, fingerprint: await digest(snapshot) });
}
export async function assertPinned(plan: VerificationPlan): Promise<void> {
  const { fingerprint, ...input } = plan;
  validate(input);
  if ((await digest(input)) !== fingerprint) throw new Error("PLAN_CHANGED");
}
export async function evidenceIsCurrent(
  plan: VerificationPlan,
  current: PlanInput,
): Promise<boolean> {
  await assertPinned(plan);
  validate(current);
  return plan.fingerprint === (await digest(current));
}
export function pendingOutcomes(plan: VerificationPlan): CheckOutcome[] {
  return (
    plan.reproduceBaseline ? (["baseline", "candidate"] as const) : (["candidate"] as const)
  ).flatMap((phase) =>
    plan.profile.checks.map((check) => ({
      planFingerprint: plan.fingerprint,
      checkId: check.id,
      phase,
      checkedSha: phase === "baseline" ? plan.baseSha : plan.candidateSha,
      status: "not_run" as const,
    })),
  );
}
// Runtime/browser checks remain blocked until a real capability is supplied by execution.
// This package does not implement a browser or interpret reviewer prose as evidence.
export async function executePlan(
  plan: VerificationPlan,
  phase: "baseline" | "candidate",
  workspace: Workspace,
  transport: Pick<WorkspaceTransport, "run" | "inspect">,
  signal?: AbortSignal,
  now: () => number = () => performance.now(),
): Promise<CheckOutcome[]> {
  plan = freeze(structuredClone(plan));
  await assertPinned(plan);
  if (
    (phase === "baseline" && !plan.reproduceBaseline) ||
    workspace.projectId !== plan.projectId ||
    workspace.baseSha !== plan.baseSha ||
    workspace.configurationRevision !== plan.configurationRevision ||
    !workspace.artifactId ||
    !workspace.runId
  )
    throw new Error("WORKSPACE_MISMATCH");
  const checkedSha = phase === "baseline" ? plan.baseSha : plan.candidateSha;
  const outcomes: CheckOutcome[] = [];
  for (const check of plan.profile.checks) {
    const outcome: CheckOutcome = {
      planFingerprint: plan.fingerprint,
      checkId: check.id,
      phase,
      checkedSha,
      artifactId: workspace.artifactId,
      runId: workspace.runId,
      status: "blocked",
    };
    if (signal?.aborted) {
      outcomes.push({ ...outcome, status: "not_run", reason: "stopped" });
      continue;
    }
    if (check.kind === "runtime") {
      outcomes.push({ ...outcome, reason: `unsupported_capability:${check.capability}` });
      continue;
    }
    let started: number | undefined;
    try {
      const before = await transport.inspect(workspace);
      if (before.sha !== checkedSha || !before.clean) {
        outcomes.push({ ...outcome, reason: "stale_workspace" });
        continue;
      }
      started = now();
      const result = await transport.run(
        workspace,
        {
          ...structuredClone(check.command),
          commandId: `${plan.fingerprint}:${phase}:${check.id}`,
        },
        signal,
      );
      const durationMs = Math.max(0, now() - started);
      const after = await transport.inspect(workspace);
      if (after.sha !== checkedSha || !after.clean) {
        outcomes.push({ ...outcome, durationMs, reason: "workspace_changed" });
        continue;
      }
      outcomes.push({
        ...outcome,
        durationMs,
        result,
        status: signal?.aborted
          ? "not_run"
          : result.status === "completed" && result.exitCode === 0 && !result.truncated
            ? "passed"
            : "failed",
      });
    } catch {
      outcomes.push({
        ...outcome,
        reason: "execution_unavailable",
        ...(started === undefined ? {} : { durationMs: Math.max(0, now() - started) }),
      });
    }
  }
  return freeze(outcomes);
}
export async function verificationGaps(
  plan: VerificationPlan,
  outcomes: readonly CheckOutcome[],
): Promise<string[]> {
  plan = freeze(structuredClone(plan));
  await assertPinned(plan);
  return plan.profile.checks.flatMap((check) => {
    const matches = outcomes.filter((o) => o.checkId === check.id && o.phase === "candidate");
    const o = matches[0];
    return check.kind === "command" &&
      matches.length === 1 &&
      o.planFingerprint === plan.fingerprint &&
      o.checkedSha === plan.candidateSha &&
      o.status === "passed" &&
      !!o.artifactId &&
      !!o.runId &&
      o.result?.status === "completed" &&
      o.result.exitCode === 0 &&
      !o.result.truncated
      ? []
      : [check.id];
  });
}
export interface GapReview {
  actor: string;
  planFingerprint: string;
  gaps: string[];
  summary: string;
}
export function recordGapReview(
  plan: VerificationPlan,
  executorActor: string,
  reviewerActor: string,
  gaps: string[],
  summary: string,
): GapReview {
  requireText(reviewerActor);
  requireText(executorActor);
  requireText(summary);
  if (
    reviewerActor === executorActor ||
    gaps.some((id) => !plan.profile.checks.some((c) => c.id === id))
  )
    throw new Error("INVALID_REVIEWER");
  return freeze({
    actor: reviewerActor,
    planFingerprint: plan.fingerprint,
    gaps: [...new Set(gaps)],
    summary,
  });
}
// Completed runs and approvals are not accepted/landed changes. Event history has no landing event.
export function verificationMetrics(
  events: readonly Event[],
  reviews: readonly Review[],
  outcomes: readonly CheckOutcome[],
) {
  const uniqueEvents = [
    ...new Map(events.map((e) => [`${e.projectId}:${e.sequence}`, e])).values(),
  ];
  const uniqueReviews = [...new Map(reviews.map((r) => [r.id, r])).values()];
  const measured = [
    ...new Map(
      outcomes.map((o) => [`${o.runId}:${o.planFingerprint}:${o.phase}:${o.checkId}`, o]),
    ).values(),
  ].filter(
    (o) => o.durationMs !== undefined && Number.isFinite(o.durationMs) && o.durationMs! >= 0,
  );
  return {
    completedRuns: uniqueEvents.filter((e) => e.type === "run.completed").length,
    approvedRuns: new Set(uniqueReviews.filter((r) => r.decision === "approve").map((r) => r.runId))
      .size,
    reworkReviews: uniqueReviews.filter((r) => r.decision === "request_changes").length,
    acceptedChanges: null,
    measuredChecks: measured.length,
    checkDurationMs: measured.reduce((sum, o) => sum + o.durationMs!, 0),
  };
}
