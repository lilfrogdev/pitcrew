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
export async function reviewCandidate(
  harness: DurablePrompt,
  workspace: Workspace,
  evidence: TestEvidence,
  signal?: AbortSignal,
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
