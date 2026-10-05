import type { Harness } from "@earendil-works/pi-durable";
import type { LifecycleServices } from "agents/lifecycle";
import { RepoConversationAgent } from "../src/repo-conversation-agent";
import { Coordinator, initialState } from "../src/coordinator";
import { resolveCatalog } from "../src/model-selection";
import type { ConversationInput } from "../src/conversation";
import type { PiEnv } from "../src/pi-agents";

export class ColdConversationFixture extends RepoConversationAgent {
  protected openHarness() {
    const sql = this.ctx.storage.sql;
    sql.exec("UPDATE fixture_counters SET opens=opens+1 WHERE id=1");
    const [mode] = sql
      .exec<{ crossing: string }>("SELECT crossing FROM fixture_counters WHERE id=1")
      .toArray();
    if (mode.crossing === "open") this.env.CLOUD_CONVERSATION_ENABLED = "false";
    let roots = 0;
    // Real Agents/PiHarness lifecycle and durable jobs; no provider implementation.
    return Promise.resolve({
      root: async () => {
        if (++roots === 2 && mode.crossing === "root")
          this.env.CLOUD_CONVERSATION_ENABLED = "false";
        return { configure: async () => {} };
      },
      resume: () => {
        sql.exec("UPDATE fixture_counters SET resumes=resumes+1 WHERE id=1");
      },
      inspect: async () => ({ tasks: [], submissions: [] }),
      conversation: async () => undefined,
      close: async () => {
        sql.exec("UPDATE fixture_counters SET closes=closes+1 WHERE id=1");
      },
    } as unknown as Harness);
  }
  seed(crossing = "", running = false) {
    const core = new Coordinator(initialState(), () => {});
    const thread = core.createThread("Synthetic conversation", "thread");
    const turn = core.queueTurn(
      thread.id,
      "Explain the fixture",
      "question",
      "owner",
      resolveCatalog(this.env),
    );
    const input = core.beginConversation(turn.turn.id)!;
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO conversation_input VALUES(1,?)",
      JSON.stringify(input),
    );
    const receipt = running ? { status: "running" } : { status: "completed", text: "saved result" };
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO conversation_receipt VALUES(1,?,?)",
      receipt.status,
      JSON.stringify(receipt),
    );
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS fixture_counters(id INTEGER PRIMARY KEY,opens INTEGER,resumes INTEGER,closes INTEGER,crossing TEXT)",
    );
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO fixture_counters VALUES(1,0,0,0,?)",
      crossing,
    );
    return input.turnId;
  }
  inspectFixture() {
    return {
      ...this.ctx.storage.sql.exec("SELECT * FROM fixture_counters WHERE id=1").toArray()[0],
      started: this.lifecycle.isStarted(),
    };
  }
  async awaken() {
    return this.inspectFixture();
  }
  retryStart() {
    const row = this.ctx.storage.sql
      .exec<{ value: string }>("SELECT value FROM conversation_input WHERE id=1")
      .toArray()[0];
    return this.start(JSON.parse(row.value) as ConversationInput);
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
}
interface Env extends PiEnv {
  CONVERSATION: DurableObjectNamespace<ColdConversationFixture>;
}
export default {
  async fetch(request: Request, env: Env) {
    const body = (await request.json()) as {
      name: string;
      operation: string;
      turnId: string;
      crossing?: string;
      running?: boolean;
    };
    const stub = env.CONVERSATION.get(env.CONVERSATION.idFromName(body.name));
    let result: unknown;
    if (body.operation === "seed") result = await stub.seed(body.crossing, body.running);
    else if (body.operation === "result") result = await stub.result(body.turnId);
    else if (body.operation === "start") result = await stub.retryStart();
    else if (body.operation === "awaken") result = await stub.awaken();
    else if (body.operation === "queue") await stub.queueWake(Date.now() + 600_000);
    else if (body.operation === "fire") await stub.fireWake();
    return Response.json({ result, snapshot: await stub.inspectFixture() });
  },
};
