import type { Harness } from "@earendil-works/pi-durable";
import type { LifecycleServices } from "agents/lifecycle";
import { ChangeAgent, ReviewAgent, type PiEnv } from "../src/pi-agents";
import type { PipelineState } from "../src/durable-pipeline";

interface Seed {
  deadline?: number;
  stage?: PipelineState["stage"];
  cleanup?: boolean;
  crossRoot?: boolean;
  withoutPipeline?: boolean;
}
const runId = "cold-run";
function seedPending(sql: SqlStorage, crossRoot = false) {
  sql.exec(
    "CREATE TABLE IF NOT EXISTS fixture_counters(id INTEGER PRIMARY KEY,opens INTEGER,resumes INTEGER,effects INTEGER,closes INTEGER)",
  );
  sql.exec("INSERT OR IGNORE INTO fixture_counters VALUES(1,0,0,0,0)");
  sql.exec("CREATE TABLE IF NOT EXISTS fixture_pending(id INTEGER PRIMARY KEY,cross_root INTEGER)");
  sql.exec("INSERT OR REPLACE INTO fixture_pending VALUES(1,?)", Number(crossRoot));
}
function snapshot(sql: SqlStorage, started: boolean) {
  const counters = sql.exec("SELECT * FROM fixture_counters WHERE id=1").toArray()[0];
  const stopped = sql.exec("SELECT name FROM sqlite_master WHERE name='task_control'").toArray()
    .length
    ? (sql.exec("SELECT run_id FROM task_control WHERE id=1").toArray()[0] ?? null)
    : null;
  return { ...counters, started, stopped };
}
function expire(sql: SqlStorage) {
  const row = sql.exec<{ value: string }>("SELECT value FROM task_models WHERE id=1").toArray()[0];
  sql.exec(
    "UPDATE task_models SET value=? WHERE id=1",
    JSON.stringify({ ...JSON.parse(row.value), deadline: Date.now() - 1 }),
  );
}
// The installed PiHarness and Agents native RPC/lifecycle wrapper stay real. Only
// Harness.open's return value is fake, so no provider or sandbox can be called.
function fakeHarness(sql: SqlStorage): Harness {
  sql.exec("UPDATE fixture_counters SET opens=opens+1 WHERE id=1");
  return {
    root: async () => {
      const [pending] = sql
        .exec<{ cross_root: number }>("SELECT cross_root FROM fixture_pending WHERE id=1")
        .toArray();
      if (pending?.cross_root) expire(sql);
      return { configure: async () => {} };
    },
    resume: () => {
      sql.exec("UPDATE fixture_counters SET resumes=resumes+1,effects=effects+1 WHERE id=1");
    },
    inspect: async () => ({ tasks: [], submissions: [] }),
    conversation: async () => undefined,
    close: async () => {
      sql.exec("UPDATE fixture_counters SET closes=closes+1 WHERE id=1");
    },
  } as unknown as Harness;
}
export class ColdChangeFixture extends ChangeAgent {
  protected openHarness() {
    return Promise.resolve(fakeHarness(this.ctx.storage.sql));
  }
  seed(options: Seed) {
    seedPending(this.ctx.storage.sql, options.crossRoot);
    this.bindModelAdmission(undefined, "implementer", options.deadline);
    if (options.withoutPipeline) return this.inspectFixture();
    const input = {
      runId,
      projectId: "project",
      threadId: "thread",
      repository: "owner/repo",
      baseSha: "a".repeat(40),
      configurationRevision: "fixture",
      messages: [],
    };
    const state: PipelineState = {
      input,
      fingerprint: JSON.stringify(input),
      stage: options.stage ?? "prepare",
      startedAt: Date.now(),
      ...(options.cleanup
        ? {
            cleanupPending: true,
            workspace: {
              runId,
              projectId: input.projectId,
              repository: input.repository,
              workerId: "worker",
              artifactId: "artifact",
              baseSha: input.baseSha,
              configurationRevision: "fixture",
            },
          }
        : {}),
    };
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO change_pipeline VALUES(1,?)",
      JSON.stringify(state),
    );
    return this.inspectFixture();
  }
  inspectFixture() {
    return snapshot(this.ctx.storage.sql, this.lifecycle.isStarted());
  }
  async awaken() {
    return this.inspectFixture();
  }
  async legacyObservation() {
    return this.result(runId);
  }
  expireGrant() {
    expire(this.ctx.storage.sql);
  }
  rebind() {
    this.bindModelAdmission(undefined);
    return this.taskDeadline();
  }
  directOpen() {
    return this.harness.pi().then(() => "opened");
  }
  queueWake(time: number) {
    return (this.harness as unknown as { lifecycle: LifecycleServices }).lifecycle.jobs.push({
      id: "fixture-wake",
      fn: "wake",
      payload: { session: "1" },
      time,
    });
  }
  fireWake() {
    const jobs = (this.harness as unknown as { lifecycle: LifecycleServices }).lifecycle.jobs;
    return jobs.reschedule("fixture-wake", Date.now()).then(() => this.lifecycle.alarm());
  }
  async heldPrompt() {
    const prompt = await this.prompt();
    this.recordStop(runId);
    const errors = [];
    for (const action of [() => prompt.submit("never sent"), () => prompt.wait("never sent")]) {
      try {
        await action();
      } catch (error) {
        errors.push((error as Error).message);
      }
    }
    return errors;
  }
}
export class ColdReviewFixture extends ReviewAgent {
  protected openHarness() {
    return Promise.resolve(fakeHarness(this.ctx.storage.sql));
  }
  seed(options: Seed) {
    seedPending(this.ctx.storage.sql, options.crossRoot);
    this.bindModelAdmission(undefined, "reviewer", options.deadline);
  }
  inspectFixture() {
    return snapshot(this.ctx.storage.sql, this.lifecycle.isStarted());
  }
  async awaken() {
    return this.inspectFixture();
  }
}
interface Env extends PiEnv {
  CHANGE: DurableObjectNamespace<ColdChangeFixture>;
  REVIEW: DurableObjectNamespace<ColdReviewFixture>;
}
export default {
  async fetch(request: Request, env: Env) {
    const body = (await request.json()) as Seed & {
      operation: string;
      name: string;
      reviewer?: boolean;
      time?: number;
    };
    try {
      if (body.reviewer) {
        const stub = env.REVIEW.get(env.REVIEW.idFromName(body.name));
        if (body.operation === "seed") await stub.seed(body);
        else if (body.operation === "awaken") await stub.awaken();
        else if (body.operation === "abort") await stub.abortReview(runId);
        return Response.json(await stub.inspectFixture());
      }
      const stub = env.CHANGE.get(env.CHANGE.idFromName(body.name));
      let result: unknown;
      switch (body.operation) {
        case "seed":
          result = await stub.seed(body);
          break;
        case "awaken":
          result = await stub.awaken();
          break;
        case "result":
          result = await stub.result(runId);
          break;
        case "legacy-result":
          result = await stub.legacyObservation();
          break;
        case "ack":
          result = await stub.acknowledge(runId);
          break;
        case "stop":
          result = await stub.stop(runId);
          break;
        case "expire":
          result = await stub.expireGrant();
          break;
        case "rebind":
          result = await stub.rebind();
          break;
        case "direct":
          result = await stub.directOpen();
          break;
        case "queue":
          result = await stub.queueWake(body.time!);
          break;
        case "fire":
          result = await stub.fireWake();
          break;
        case "held":
          result = await stub.heldPrompt();
          break;
      }
      return Response.json({ result: result ?? null, snapshot: await stub.inspectFixture() });
    } catch (error) {
      return Response.json({ error: (error as Error).message }, { status: 400 });
    }
  },
};
