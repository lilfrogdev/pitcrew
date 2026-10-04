import { RepositoryAgent } from "../src/index";
import { Coordinator, initialState, fakeExecution, type State } from "../src/coordinator";
import { ChangeAgent, type PiEnv } from "../src/pi-agents";
import type { KnowledgeAck, KnowledgeReport, WorkerKnowledgeContext } from "@pitcrew/protocol";
interface Env extends PiEnv {
  FIXTURE: DurableObjectNamespace<KnowledgeChangeAgent>;
  PAUSE_ACK?: string;
}
export class KnowledgeChangeAgent extends ChangeAgent {
  async queueFixture() {
    await this.lifecycle.start();
    const receiver = this.env.REPOSITORY.get(
      this.env.REPOSITORY.idFromName("pitcrew"),
    ) as unknown as KnowledgeReceiver;
    const context = await receiver.prepareFixture();
    const checkpoint = await receiver.refreshWorkerKnowledge(context);
    await this.enqueueKnowledge({
      context,
      report: {
        key: "note-1",
        text: "Synthetic verified constraint",
        kind: "constraint",
        sourceRefs: [
          { kind: "code", id: "p".repeat(200), revision: "a".repeat(40), path: "p".repeat(200) },
        ],
      },
    });
    return { queued: true, checkpoint };
  }
  async fixtureStatus() {
    await this.lifecycle.start();
    return this.sql`SELECT id,body,ack,last_error,retry_after FROM knowledge_outbox`;
  }
}
export class KnowledgeReceiver extends RepositoryAgent {
  async prepareFixture() {
    void this
      .sql`CREATE TABLE IF NOT EXISTS repository_state (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)`;
    const state = initialState({ baseSha: "a".repeat(40), configurationRevision: "1" });
    const core = new Coordinator(
      state,
      (value) => {
        void this.sql`INSERT OR REPLACE INTO repository_state VALUES(1,${JSON.stringify(value)})`;
      },
      () => "now",
      (() => {
        let id = 0;
        return () => String(++id);
      })(),
    );
    const thread = core.createThread("fixture", "thread"),
      submitted = core.submit(thread.id, "fixture intent", "message");
    const input = core.begin(submitted.run.id)!;
    core.complete(submitted.run.id, await fakeExecution.delegate(input));
    core.appendKnowledge("fixture-owner", "concurrent", {
      id: "concurrent-constraint",
      expectedVersion: 0,
      status: "accepted",
      kind: "constraint",
      text: "Explicit concurrent correction",
      reason: "Fixture principal decision",
      sourceRefs: [{ kind: "code", id: "fixture.ts", revision: input.baseSha }],
    });
    return input.knowledgeContext!;
  }
  async appendWorkerKnowledge(
    context: WorkerKnowledgeContext,
    report: KnowledgeReport,
  ): Promise<KnowledgeAck> {
    void this
      .sql`CREATE TABLE IF NOT EXISTS fixture_notes(id TEXT PRIMARY KEY,body TEXT NOT NULL,attempts INTEGER NOT NULL)`;
    const eventId = `worker:${context.runId}:${report.key}`,
      body = JSON.stringify({ context, report });
    const [existing] = this.sql<{
      body: string;
    }>`SELECT body FROM fixture_notes WHERE id=${eventId}`;
    if (existing && existing.body !== body) throw Error("idempotency_conflict");
    void this
      .sql`INSERT INTO fixture_notes VALUES(${eventId},${body},1) ON CONFLICT(id) DO UPDATE SET attempts=attempts+1`;
    const ack = await super.appendWorkerKnowledge(context, report);
    if ((this.env as unknown as Env).PAUSE_ACK) throw Error("fixture_lost_ack");
    return ack;
  }
  async fixtureStatus() {
    void this
      .sql`CREATE TABLE IF NOT EXISTS fixture_notes(id TEXT PRIMARY KEY,body TEXT NOT NULL,attempts INTEGER NOT NULL)`;
    const [row] = this.sql<{ value: string }>`SELECT value FROM repository_state WHERE id=1`;
    const state = row ? (JSON.parse(row.value) as State) : undefined;
    return this.sql`SELECT id,body,attempts FROM fixture_notes`.map((note) => ({
      ...note,
      recorded: state?.events.filter((event) => event.knowledge?.eventId === note.id),
      current: state?.knowledgeProjection?.current.entries.filter(
        (entry) => entry.eventId === note.id,
      ),
    }));
  }
}
export default {
  async fetch(request: Request, env: Env) {
    const worker = env.FIXTURE.get(env.FIXTURE.idFromName("worker"));
    const path = new URL(request.url).pathname;
    if (path === "/queue") return Response.json(await worker.queueFixture());
    if (path === "/worker") return Response.json(await worker.fixtureStatus());
    const receiver = env.REPOSITORY.get(
      env.REPOSITORY.idFromName("pitcrew"),
    ) as unknown as KnowledgeReceiver;
    return Response.json(await receiver.fixtureStatus());
  },
};
