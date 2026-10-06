export { UserCredentials } from "../src/user-credentials-agent";
import { sqliteAdmission } from "../src/infrastructure-admission";
import { readRepositoryState } from "../src/repository-state";
import { Agent } from "agents";
import { LifecycleCapability } from "agents/lifecycle";
import { ChangeAgent, type PiEnv } from "../src/pi-agents";
import worker, { RepositoryAgent } from "../src/index";
import type { State } from "../src/coordinator";
import type { ExecutionInput, ExecutionResult } from "@pitcrew/protocol";
interface Env {
  PAUSE_ACK?: string;
  FAIL_START_ONCE?: string;
  REPOSITORY: DurableObjectNamespace<DeliveryRepositoryAgent>;
  CHANGE: DurableObjectNamespace<DeliveryChangeAgent>;
}
export class DeliveryRepositoryAgent extends RepositoryAgent {
  async recordActivation() {
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS activations(id INTEGER PRIMARY KEY,calls INTEGER NOT NULL)",
    );
    this.ctx.storage.sql.exec(
      "INSERT INTO activations VALUES(1,1) ON CONFLICT(id) DO UPDATE SET calls=calls+1",
    );
  }
  reservations() {
    return sqliteAdmission(this.ctx.storage).active();
  }
  async activations() {
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS activations(id INTEGER PRIMARY KEY,calls INTEGER NOT NULL)",
    );
    return (
      this.ctx.storage.sql
        .exec<{ calls: number }>("SELECT calls FROM activations WHERE id=1")
        .toArray()[0]?.calls ?? 0
    );
  }
  async persisted(runId: string) {
    const stored = readRepositoryState(this.ctx.storage.sql);
    if (!stored) throw Error("fixture_state_missing");
    const state = JSON.parse(stored) as State;
    return {
      status: state.runs.find((run) => run.id === runId)?.status ?? null,
      testsPresent: !!state.evidence[runId],
      reviewCount: state.reviews.filter((review) => review.runId === runId).length,
    };
  }
}
class FixtureActivation extends LifecycleCapability {
  constructor(private readonly activate: () => Promise<void>) {
    super("fixture-activation");
  }
  async onStart() {
    await this.activate();
  }
}
export class DeliveryChangeAgent extends Agent<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.lifecycle.use(
      new FixtureActivation(() =>
        env.REPOSITORY.get(env.REPOSITORY.idFromName("pitcrew")).recordActivation(),
      ),
    );
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS delivery(id INTEGER PRIMARY KEY,input TEXT NOT NULL,result TEXT NOT NULL,effects INTEGER NOT NULL,ack_attempts INTEGER NOT NULL,acknowledged INTEGER NOT NULL,observed_commit INTEGER NOT NULL)",
    );
  }
  async start(input: ExecutionInput) {
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS starts(id INTEGER PRIMARY KEY,calls INTEGER NOT NULL)",
    );
    this.ctx.storage.sql.exec(
      "INSERT INTO starts VALUES(1,1) ON CONFLICT(id) DO UPDATE SET calls=calls+1",
    );
    const [attempt] = this.ctx.storage.sql
      .exec<{ calls: number }>("SELECT calls FROM starts WHERE id=1")
      .toArray();
    if (this.env.FAIL_START_ONCE && attempt.calls === 1) throw Error(this.env.FAIL_START_ONCE);
    const [existing] = this.ctx.storage.sql
      .exec<{ input: string }>("SELECT input FROM delivery WHERE id=1")
      .toArray();
    if (existing) {
      if (existing.input !== JSON.stringify(input)) throw Error("context_conflict");
      return { runId: input.runId, stage: "done" as const };
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
    return { runId: input.runId, stage: "done" as const };
  }
  async result(runId: string) {
    const [row] = this.ctx.storage.sql
      .exec<{ input: string; result: string }>("SELECT input,result FROM delivery WHERE id=1")
      .toArray();
    if (JSON.parse(row.input).runId !== runId) throw Error("context_mismatch");
    // This fixture runs no container; its synchronous owned work is already complete.
    return {
      stage: "done",
      result: JSON.parse(row.result) as ExecutionResult,
      cleanupVerified: true,
    };
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
    // Polling may reach the fixture before the asynchronous first start.
    if (
      !this.ctx.storage.sql
        .exec("SELECT name FROM sqlite_master WHERE type='table' AND name='starts'")
        .toArray().length
    )
      return null;
    return (
      this.ctx.storage.sql
        .exec<{
          effects: number;
          ack_attempts: number;
          acknowledged: number;
          observed_commit: number;
        }>(
          "SELECT effects,ack_attempts,acknowledged,observed_commit,(SELECT calls FROM starts WHERE id=1) AS calls FROM delivery WHERE id=1",
        )
        .toArray()[0] ?? null
    );
  }
}
export class PreflightChangeAgent extends ChangeAgent {
  constructor(ctx: DurableObjectState, env: PiEnv & { CHILD_REVISION?: string }) {
    super(ctx, {
      ...env,
      CONFIGURATION_REVISION: env.CHILD_REVISION ?? env.CONFIGURATION_REVISION,
    });
  }
  async start(input: ExecutionInput) {
    void this.sql`CREATE TABLE IF NOT EXISTS starts(id INTEGER PRIMARY KEY,calls INTEGER NOT NULL)`;
    void this.sql`INSERT INTO starts VALUES(1,1) ON CONFLICT(id) DO UPDATE SET calls=calls+1`;
    return super.start(input);
  }
  async status() {
    if (
      !this.ctx.storage.sql
        .exec("SELECT name FROM sqlite_master WHERE type='table' AND name='starts'")
        .toArray().length
    )
      return null;
    const [row] = this.sql<{ calls: number }>`SELECT calls FROM starts WHERE id=1`;
    const [state] = this.ctx.storage.sql
      .exec("SELECT name FROM sqlite_master WHERE type='table' AND name='change_pipeline'")
      .toArray().length
      ? this.sql<{ value: string }>`SELECT value FROM change_pipeline WHERE id=1`
      : [];
    return { calls: row?.calls ?? 0, pipeline: state ? JSON.parse(state.value) : null };
  }
}
export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    if (url.pathname === "/fixture/reservations")
      return Response.json(
        await env.REPOSITORY.get(env.REPOSITORY.idFromName("pitcrew")).reservations(),
      );
    if (url.pathname === "/fixture/activations") {
      return Response.json(
        await env.REPOSITORY.get(env.REPOSITORY.idFromName("pitcrew")).activations(),
      );
    }
    if (url.pathname === "/fixture/delivery") {
      const runId = url.searchParams.get("runId");
      const child = env.CHANGE.get(env.CHANGE.idFromName(`change:pitcrew:${runId}`));
      return Response.json(await child.status());
    }
    return worker.fetch(request, env as unknown as Parameters<typeof worker.fetch>[1]);
  },
};
