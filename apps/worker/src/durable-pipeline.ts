import type { ExecutionInput, ExecutionResult, Review } from "@pitcrew/protocol";
import type { Workspace, TestEvidence } from "../../../packages/execution/src/contracts";
export type Stage =
  | "prepare"
  | "change"
  | "publish"
  | "test"
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
  change?: { candidateSha: string; summary: string };
  evidence?: TestEvidence;
  review?: Pick<
    Review,
    "baseSha" | "candidateSha" | "configurationRevision" | "decision" | "summary" | "actor"
  >;
  result?: ExecutionResult;
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
  async advance(ports: PipelinePorts) {
    const saved = this.store.read();
    if (!saved || ["done", "blocked"].includes(saved.stage)) return;
    const state = structuredClone(saved);
    if (this.now() - state.startedAt > 30 * 60 * 1000) {
      state.stage = "blocked";
      state.error = "deadline_exceeded";
      if (state.workspace) await ports.stop(state.workspace).catch(() => {});
      this.store.write(state);
      return;
    }
    try {
      switch (state.stage) {
        case "prepare":
          state.workspace = await ports.prepare(state.input);
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
          state.stage = "review";
          break;
        case "review": {
          const review = await ports.review(state.workspace!, state.evidence!);
          if (!review) return;
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
          state.review = review;
          state.stage = "stop";
          break;
        }
        case "stop": {
          await ports.stop(state.workspace!);
          const e = state.evidence!,
            w = state.workspace!;
          state.result = {
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
      state.stage = "blocked";
      state.error =
        typeof error === "object" &&
        error !== null &&
        (("code" in error && error.code === "UNCERTAIN_OPERATION") ||
          (error instanceof Error && error.message === "reconciliation_required"))
          ? "reconciliation_required"
          : "execution_failed";
      if (state.workspace) await ports.stop(state.workspace).catch(() => {});
    }
    // A lost stage acknowledgement must be retried from the prior persisted stage.
    // Native ports use the operation journal; Pi ports reuse their durable receipt.
    this.store.write(state);
  }
}
