import { DurableObject } from "cloudflare:workers";
import worker, { RepositoryAgent } from "../src/index";
import type { State } from "../src/coordinator";
import type { ExecutionInput, ExecutionResult } from "@pitcrew/protocol";
interface Env {
  PAUSE_ACK?: string;
  REPOSITORY: DurableObjectNamespace<DeliveryRepositoryAgent>;
  CHANGE: DurableObjectNamespace<DeliveryChangeAgent>;
}
export class DeliveryRepositoryAgent extends RepositoryAgent {
  async persisted(runId: string) {
    const rows = this.ctx.storage.sql
      .exec<{ value: string }>("SELECT value FROM repository_state WHERE id=1")
      .toArray();
    const state = JSON.parse(rows[0].value) as State;
    return {
      status: state.runs.find((run) => run.id === runId)?.status ?? null,
      testsPresent: !!state.evidence[runId],
      reviewCount: state.reviews.filter((review) => review.runId === runId).length,
    };
  }
}
export class DeliveryChangeAgent extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS delivery(id INTEGER PRIMARY KEY,input TEXT NOT NULL,result TEXT NOT NULL,effects INTEGER NOT NULL,ack_attempts INTEGER NOT NULL,acknowledged INTEGER NOT NULL,observed_commit INTEGER NOT NULL)",
    );
  }
  async start(input: ExecutionInput) {
    const [existing] = this.ctx.storage.sql
      .exec<{ input: string }>("SELECT input FROM delivery WHERE id=1")
      .toArray();
    if (existing) {
      if (existing.input !== JSON.stringify(input)) throw Error("context_conflict");
      return;
    }
    const candidateSha = "b".repeat(40);
    const binding = {
      baseSha: input.baseSha,
      candidateSha,
      configurationRevision: input.configurationRevision,
    };
    const result: ExecutionResult = {
      workerId: `fixture-worker:${input.runId}`,
      artifactId: `fixture-artifact:${input.runId}`,
      baseSha: input.baseSha,
      candidateSha,
      summary: "fixture completion",
      tests: {
        ...binding,
        status: "passed",
        argv: ["fixture"],
        exitCode: 0,
        stdout: "passed",
        stderr: "",
        truncated: false,
      },
      review: {
        ...binding,
        decision: "approve",
        summary: "fixture review",
        actor: `fixture-reviewer:${input.runId}`,
      },
    };
    this.ctx.storage.sql.exec(
      "INSERT INTO delivery VALUES(1,?,?,1,0,0,0)",
      JSON.stringify(input),
      JSON.stringify(result),
    );
  }
  async result(runId: string) {
    const [row] = this.ctx.storage.sql
      .exec<{ input: string; result: string }>("SELECT input,result FROM delivery WHERE id=1")
      .toArray();
    if (JSON.parse(row.input).runId !== runId) throw Error("context_mismatch");
    return { stage: "done", result: JSON.parse(row.result) as ExecutionResult };
  }
  async acknowledge(runId: string) {
    const persisted = await this.env.REPOSITORY.get(
      this.env.REPOSITORY.idFromName("pitcrew"),
    ).persisted(runId);
    if (
      persisted.status !== "awaiting_review" ||
      !persisted.testsPresent ||
      persisted.reviewCount !== 1
    )
      throw Error("acknowledgement_before_commit");
    this.ctx.storage.sql.exec(
      "UPDATE delivery SET ack_attempts=ack_attempts+1,observed_commit=1 WHERE id=1",
    );
    const [row] = this.ctx.storage.sql
      .exec<{ ack_attempts: number }>("SELECT ack_attempts FROM delivery WHERE id=1")
      .toArray();
    if (row.ack_attempts === 1 || this.env.PAUSE_ACK) throw Error("fixture_lost_acknowledgement");
    this.ctx.storage.sql.exec("UPDATE delivery SET acknowledged=1 WHERE id=1");
  }
  async status() {
    return this.ctx.storage.sql
      .exec<{
        effects: number;
        ack_attempts: number;
        acknowledged: number;
        observed_commit: number;
      }>("SELECT effects,ack_attempts,acknowledged,observed_commit FROM delivery WHERE id=1")
      .toArray()[0];
  }
}
export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    if (url.pathname === "/fixture/delivery") {
      const runId = url.searchParams.get("runId");
      const child = env.CHANGE.get(env.CHANGE.idFromName(`change:pitcrew:${runId}`));
      return Response.json(await child.status());
    }
    return worker.fetch(request, env as unknown as Parameters<typeof worker.fetch>[1]);
  },
};
