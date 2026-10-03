import type { ExecutionAdapter, ExecutionInput, ExecutionResult } from "../../protocol/src/index.ts";
import type { Command, OperationJournal, Workspace, TestEvidence } from "./contracts.ts";
import { ExecutionError } from "./contracts.ts";
import { ExecutionCoordinator } from "./coordinator.ts";

export interface ChangeWorker {
  // The durable repository agent delegates here; it must never edit source itself.
  apply(workspace: Workspace, input: ExecutionInput, signal?: AbortSignal): Promise<{ candidateSha: string; summary: string }>;
}
export interface CandidateReviewer {
  review(workspace: Workspace, evidence: TestEvidence, signal?: AbortSignal): Promise<{
    baseSha: string; candidateSha: string; configurationRevision: string;
    decision: "approve" | "request_changes"; summary: string; actor: string;
  }>;
}

export class CloudflareExecutionAdapter implements ExecutionAdapter {
  constructor(
    private readonly coordinator: ExecutionCoordinator,
    private readonly journal: OperationJournal,
    private readonly worker: ChangeWorker,
    private readonly reviewer: CandidateReviewer,
    private readonly tests: Omit<Command, "commandId">,
  ) {}

  async delegate(input: ExecutionInput, signal?: AbortSignal): Promise<ExecutionResult> {
    if (signal?.aborted) throw new ExecutionError("STOPPED");
    const key = `delegate:${input.projectId}:${input.runId}`;
    const fingerprint = JSON.stringify(input);
    const { claimed, record } = await this.journal.claim(key, fingerprint);
    if (record.fingerprint !== fingerprint) throw new ExecutionError("IDEMPOTENCY_CONFLICT");
    if (!claimed) {
      if (record.state !== "complete") throw new ExecutionError("UNCERTAIN_OPERATION");
      return record.result as ExecutionResult;
    }
    let workspace: Workspace | undefined;
    const onAbort = () => { if (workspace) void this.coordinator.stop(workspace).catch(() => {}); };
    try {
      workspace = await this.coordinator.prepare({ runId: input.runId, projectId: input.projectId,
        repository: input.repository, baseSha: input.baseSha, configurationRevision: input.configurationRevision });
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) throw new ExecutionError("STOPPED");
      const change = await this.worker.apply(workspace, input, signal);
      await this.coordinator.publish(workspace, change.candidateSha);
      const evidence = await this.coordinator.test(workspace, change.candidateSha, { ...this.tests, commandId: "candidate-tests" }, signal);
      const review = await this.reviewer.review(workspace, evidence, signal);
      if (review.baseSha !== input.baseSha || review.candidateSha !== evidence.candidateSha ||
          review.configurationRevision !== input.configurationRevision || !review.actor ||
          !["approve", "request_changes"].includes(review.decision)) throw new ExecutionError("STALE_REVIEW");
      if (review.decision === "approve" && (evidence.status !== "completed" || evidence.exitCode !== 0 || evidence.truncated))
        throw new ExecutionError("INVALID_APPROVAL");
      const result: ExecutionResult = { workerId: workspace.workerId, artifactId: workspace.artifactId,
        baseSha: input.baseSha, candidateSha: evidence.candidateSha, summary: change.summary.slice(0, 4096),
        tests: { status: evidence.status === "completed" && evidence.exitCode === 0 ? "passed" : "failed",
          argv: evidence.argv, exitCode: evidence.exitCode, stdout: evidence.stdout, stderr: evidence.stderr, truncated: evidence.truncated },
        review: { decision: review.decision, summary: review.summary.slice(0, 4096), actor: review.actor } };
      if (signal?.aborted) throw new ExecutionError("STOPPED");
      await this.coordinator.stop(workspace);
      workspace = undefined;
      // Persist completion before reporting success. If the acknowledgement is lost, replay reads it.
      await this.journal.complete(key, fingerprint, result);
      return result;
    } catch {
      throw new ExecutionError("UNCERTAIN_OPERATION");
    } finally {
      signal?.removeEventListener("abort", onAbort);
      if (workspace) await this.coordinator.stop(workspace);
    }
  }
}
