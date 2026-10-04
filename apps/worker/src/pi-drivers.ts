import type { ExecutionInput } from "@pitcrew/protocol";
import type {
  Workspace,
  TestEvidence,
  WorkspaceTransport,
} from "../../../packages/execution/src/contracts";
export interface DurablePrompt {
  submit(prompt: string, options: { operationId: string }): Promise<unknown>;
  wait(
    operationId: string,
    options?: { signal?: AbortSignal },
  ): Promise<{ status: "done" | "unanswered"; text?: string }>;
}
export async function bootstrapDependencies(transport: WorkspaceTransport, workspace: Workspace) {
  const before = await transport.inspect(workspace);
  if (!before.clean || before.sha !== workspace.baseSha) throw Error("bootstrap_context_mismatch");
  const result = await transport.run(workspace, {
    commandId: "dependencies",
    argv: ["pnpm", "install", "--frozen-lockfile", "--ignore-scripts", "--reporter=silent"],
    timeoutMs: 180000,
    maxOutputBytes: 16384,
  });
  if (result.status !== "completed" || result.exitCode !== 0 || result.truncated)
    throw Error("bootstrap_failed");
  const after = await transport.inspect(workspace);
  if (!after.clean || after.sha !== workspace.baseSha) throw Error("bootstrap_changed_source");
  return { prepared: true };
}
export async function applyChange(
  harness: DurablePrompt,
  transport: WorkspaceTransport,
  workspace: Workspace,
  input: ExecutionInput,
  signal?: AbortSignal,
) {
  if (
    workspace.runId !== input.runId ||
    workspace.baseSha !== input.baseSha ||
    workspace.configurationRevision !== input.configurationRevision
  )
    throw Error("context_mismatch");
  const prompt = JSON.stringify({
    task: "Implement the requested change in this isolated checkout, test, and commit it. Only edit code/tests/config/LICENSE/NOTICE. Never merge or push. Return a short summary.",
    baseSha: input.baseSha,
    configurationRevision: input.configurationRevision,
    repositoryContext: input.repositoryContext,
    messages: input.messages,
  });
  await harness.submit(prompt, { operationId: `change:${input.runId}` });
  const result = await harness.wait(`change:${input.runId}`, { signal });
  if (result.status !== "done") throw Error("change_unanswered");
  const candidate = await transport.inspect(workspace);
  if (
    !candidate.clean ||
    candidate.sha === workspace.baseSha ||
    !/^[a-f0-9]{40}$/.test(candidate.sha)
  )
    throw Error("invalid_candidate");
  return { candidateSha: candidate.sha, summary: (result.text ?? "").slice(0, 4096) };
}
export interface ReviewBrief {
  messages: ExecutionInput["messages"];
  repositoryContext?: ExecutionInput["repositoryContext"];
  implementationSummary: string;
}
export async function reviewCandidate(
  harness: DurablePrompt,
  workspace: Workspace,
  evidence: TestEvidence,
  signal?: AbortSignal,
  brief?: ReviewBrief,
) {
  if (
    evidence.runId !== workspace.runId ||
    evidence.baseSha !== workspace.baseSha ||
    evidence.configurationRevision !== workspace.configurationRevision
  )
    throw Error("context_mismatch");
  await harness.submit(
    JSON.stringify({
      task: 'Independently review the pinned candidate using read_candidate tools. Return only JSON {decision:"approve"|"request_changes",summary:string}. Never modify source. Tests alone do not prove the change correct.',
      baseSha: evidence.baseSha,
      candidateSha: evidence.candidateSha,
      configurationRevision: evidence.configurationRevision,
      tests: evidence,
      requestedChange: brief,
    }),
    { operationId: `review:${workspace.runId}` },
  );
  const result = await harness.wait(`review:${workspace.runId}`, { signal });
  if (result.status !== "done" || !result.text || result.text.length > 8192)
    throw Error("review_unanswered");
  const parsed = JSON.parse(result.text) as { decision: string; summary: string };
  if (
    !["approve", "request_changes"].includes(parsed.decision) ||
    typeof parsed.summary !== "string" ||
    parsed.summary.length > 4096
  )
    throw Error("invalid_review");
  if (
    parsed.decision === "approve" &&
    (evidence.status !== "completed" || evidence.exitCode !== 0 || evidence.truncated)
  )
    throw Error("invalid_approval");
  return {
    baseSha: evidence.baseSha,
    candidateSha: evidence.candidateSha,
    configurationRevision: evidence.configurationRevision,
    decision: parsed.decision as "approve" | "request_changes",
    summary: parsed.summary,
    actor: `pi-reviewer:${workspace.runId}`,
  };
}

export interface MutationStore {
  read(id: string): { body: string; state: "pending" | "complete"; result?: unknown } | undefined;
  hasPending(): boolean;
  start(id: string, body: string): void;
  finish(id: string, result: unknown): void;
}
export async function guardedMutation<T>(
  store: MutationStore,
  id: string,
  body: string,
  action: () => Promise<T>,
): Promise<T> {
  const existing = store.read(id);
  if (existing) {
    if (existing.body !== body) throw Error("mutation_conflict");
    if (existing.state !== "complete") throw Error("reconciliation_required");
    return existing.result as T;
  }
  if (store.hasPending()) throw Error("reconciliation_required");
  store.start(id, body);
  const result = await action();
  store.finish(id, result);
  return result;
}
