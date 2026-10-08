import { verificationGaps } from "../../../packages/verification/src/index.ts";
import type { VerificationEvidence } from "@pitcrew/protocol";
import type { ExecutionInput, ExecutionResult, ProbeEvidence, Review } from "@pitcrew/protocol";
import type { Workspace, TestEvidence } from "../../../packages/execution/src/contracts";
export type Stage =
  | "prepare"
  | "change"
  | "publish"
  | "test"
  | "explore"
  | "review"
  | "stop"
  | "done"
  | "blocked";
export interface PipelineState {
  input: ExecutionInput;
  fingerprint: string;
  stage: Stage;
  startedAt: number;
  workspace?: Workspace;
  /** Persisted before preparation; absence of a workspace is not cleanup proof. */
  preparePending?: boolean;
  change?: { candidateSha: string; summary: string };
  evidence?: TestEvidence;
  probes?: ProbeEvidence[];
  verification?: VerificationEvidence;
  review?: Pick<
    Review,
    "baseSha" | "candidateSha" | "configurationRevision" | "decision" | "summary" | "actor"
  >;
  result?: ExecutionResult;
  resultAcknowledged?: boolean;
  stopRequested?: boolean;
  cleanupPending?: boolean;
  cleanupAttempts?: number;
  cleanupParked?: boolean;
  error?: "reconciliation_required" | "execution_failed" | "deadline_exceeded";
}
export interface PipelineStore {
  read(): PipelineState | undefined;
  write(state: PipelineState): void;
}
export interface PipelinePorts {
  prepare(input: ExecutionInput): Promise<Workspace>;
  change(workspace: Workspace, input: ExecutionInput): Promise<PipelineState["change"]>;
  publish(workspace: Workspace, candidate: string): Promise<void>;
  test(workspace: Workspace, candidate: string): Promise<TestEvidence>;
  explore?(workspace: Workspace, evidence: TestEvidence): Promise<ProbeEvidence[] | undefined>;
  verify?(workspace: Workspace, candidate: string): Promise<VerificationEvidence | undefined>;
  review(workspace: Workspace, evidence: TestEvidence): Promise<PipelineState["review"]>;
  stop(workspace: Workspace): Promise<void>;
}
export class DurableChangePipeline {
  constructor(
    private store: PipelineStore,
    private now = () => Date.now(),
  ) {}
  start(input: ExecutionInput) {
    const fingerprint = JSON.stringify(input),
      previous = this.store.read();
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw Error("idempotency_conflict");
      return previous;
    }
    const state: PipelineState = {
      input: structuredClone(input),
      fingerprint,
      stage: "prepare",
      startedAt: this.now(),
    };
    this.store.write(state);
    return state;
  }
  status() {
    return this.store.read();
  }
  acknowledge(runId: string) {
    const state = this.store.read();
    if (!state || state.input.runId !== runId || state.stage !== "done")
      throw Error("result_not_ready");
    if (!state.resultAcknowledged) this.store.write({ ...state, resultAcknowledged: true });
  }
  requestStop(runId: string) {
    const state = this.store.read();
    if (!state || state.input.runId !== runId) throw Error("not_found");
    if (state.stage === "done" || state.stopRequested) return;
    this.store.write({
      ...state,
      stopRequested: true,
      cleanupPending:
        !!state.workspace || !!state.preparePending || state.error === "reconciliation_required",
      stage: "blocked",
      error: state.error === "reconciliation_required" ? state.error : "execution_failed",
    });
  }
  private async cleanup(state: PipelineState, ports: PipelinePorts) {
    if (!state.cleanupPending || state.cleanupParked) return;
    if (!state.workspace) {
      // A failed or interrupted prepare cannot be safely replayed after Stop.
      // Keep its reservation for reconciliation until an owned acknowledgement arrives.
      this.store.write({ ...state, cleanupParked: true, error: "reconciliation_required" });
      return;
    }
    if ((state.cleanupAttempts ?? 0) >= 12) {
      this.store.write({ ...state, cleanupParked: true, error: "reconciliation_required" });
      return;
    }
    state.cleanupAttempts = (state.cleanupAttempts ?? 0) + 1;
    this.store.write(state);
    try {
      await ports.stop(state.workspace);
    } catch {
      return; // Keep the durable cleanup intent for recovery; never replay the failed effect.
    }
    const current = this.store.read();
    if (!current || current.fingerprint !== state.fingerprint) throw Error("context_conflict");
    this.store.write({ ...current, cleanupPending: !!current.preparePending });
  }
  async advance(ports: PipelinePorts) {
    const saved = this.store.read();
    if (!saved || saved.stage === "done") return;
    if (saved.stage === "blocked") {
      await this.cleanup(saved, ports);
      return;
    }
    const state = structuredClone(saved);
    if (this.now() - state.startedAt > 30 * 60 * 1000) {
      state.stage = "blocked";
      state.error = "deadline_exceeded";
      state.cleanupPending = !!state.workspace || !!state.preparePending;
      this.store.write(state);
      await this.cleanup(state, ports);
      return;
    }
    try {
      switch (state.stage) {
        case "prepare":
          if (state.preparePending) throw Error("reconciliation_required");
          state.preparePending = true;
          this.store.write(state);
          state.workspace = await ports.prepare(state.input);
          state.preparePending = false;
          state.stage = "change";
          break;
        case "change": {
          const result = await ports.change(state.workspace!, state.input);
          if (!result) return;
          if (
            !/^[a-f0-9]{40}$/.test(result.candidateSha) ||
            result.candidateSha === state.input.baseSha
          )
            throw Error("invalid_candidate");
          state.change = result;
          state.stage = "publish";
          break;
        }
        case "publish":
          await ports.publish(state.workspace!, state.change!.candidateSha);
          state.stage = "test";
          break;
        case "test":
          state.evidence = await ports.test(state.workspace!, state.change!.candidateSha);
          if (state.input.verificationPlan) {
            state.verification = await ports.verify?.(state.workspace!, state.change!.candidateSha);
            if (!state.verification) throw Error("verification_missing");
          }
          state.stage = ports.explore ? "explore" : "review";
          break;
        case "explore":
          state.probes = (await ports.explore?.(state.workspace!, state.evidence!)) ?? [];
          state.stage = "review";
          break;
        case "review": {
          const receipt = await ports.review(state.workspace!, state.evidence!);
          if (!receipt) return;
          const review = structuredClone(receipt);
          const evidence = state.evidence!;
          if (
            !["approve", "request_changes"].includes(review.decision) ||
            evidence.runId !== state.input.runId ||
            review.baseSha !== state.input.baseSha ||
            review.candidateSha !== state.change!.candidateSha ||
            review.configurationRevision !== state.input.configurationRevision ||
            !review.actor ||
            evidence.baseSha !== state.input.baseSha ||
            evidence.candidateSha !== review.candidateSha ||
            evidence.configurationRevision !== review.configurationRevision
          )
            throw Error("stale_evidence");
          if (
            review.decision === "approve" &&
            (evidence.status !== "completed" || evidence.exitCode !== 0 || evidence.truncated)
          )
            throw Error("invalid_approval");
          if (state.verification) {
            const gaps = await verificationGaps(
              state.verification.plan,
              state.verification.outcomes,
            );
            if (gaps.length && review.decision === "approve") {
              review.decision = "request_changes";
              review.summary = `Verification gaps: ${gaps.join(", ")}. ${review.summary}`.slice(
                0,
                4096,
              );
            }
          }
          const blocking = (state.probes ?? []).filter((probe) => probe.blocking);
          if (blocking.length && review.decision === "approve") {
            review.decision = "request_changes";
            review.summary =
              `Exploratory probe failed: ${blocking.map((probe) => probe.purpose).join("; ")}. ${review.summary}`.slice(
                0,
                4096,
              );
          }
          state.review = review;
          state.stage = "stop";
          break;
        }
        case "stop": {
          await ports.stop(state.workspace!);
          const e = state.evidence!,
            w = state.workspace!;
          state.result = {
            verification: state.verification,
            workerId: w.workerId,
            artifactId: w.artifactId,
            baseSha: e.baseSha,
            candidateSha: e.candidateSha,
            summary: state.change!.summary.slice(0, 4096),
            tests: {
              baseSha: e.baseSha,
              candidateSha: e.candidateSha,
              configurationRevision: e.configurationRevision,
              status:
                e.status === "completed" && e.exitCode === 0 && !e.truncated ? "passed" : "failed",
              argv: e.argv,
              exitCode: e.exitCode,
              stdout: e.stdout,
              stderr: e.stderr,
              truncated: e.truncated,
            },
            review: state.review,
          };
          state.stage = "done";
          break;
        }
      }
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "pipeline.blocked",
          message: error instanceof Error ? error.message : "unknown",
        }),
      );
      state.stage = "blocked";
      state.error =
        typeof error === "object" &&
        error !== null &&
        (("code" in error && error.code === "UNCERTAIN_OPERATION") ||
          (error instanceof Error && error.message === "reconciliation_required"))
          ? "reconciliation_required"
          : "execution_failed";
      state.cleanupPending = !!state.workspace || !!state.preparePending;
      if (state.preparePending && !state.workspace) {
        state.error = "reconciliation_required";
        state.cleanupParked = true;
      }
    }
    // A lost stage acknowledgement must be retried from the prior persisted stage.
    // Native ports use the operation journal; Pi ports reuse their durable receipt.
    const current = this.store.read();
    if (current?.stopRequested) {
      // Stop can arrive while prepare or another effect is awaiting its acknowledgement.
      // Retain any newly created workspace, but never publish its stale completion.
      const stopped = {
        ...current,
        workspace: current.workspace ?? state.workspace,
        preparePending: state.preparePending,
        ...(state.workspace && current.preparePending
          ? {
              cleanupParked: false,
              error: "execution_failed" as const,
            }
          : {}),
      };
      stopped.cleanupPending =
        !!stopped.workspace ||
        !!stopped.preparePending ||
        stopped.error === "reconciliation_required";
      this.store.write(stopped);
      await this.cleanup(stopped, ports);
      return;
    }
    this.store.write(state);
    await this.cleanup(state, ports);
  }
}
