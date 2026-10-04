import { Agent } from "agents";
import { ChangeAgent, type PiEnv } from "../src/pi-agents";
import type { KnowledgeAck, KnowledgeReport, WorkerKnowledgeContext } from "@pitcrew/protocol";
interface Env extends PiEnv {
  FIXTURE: DurableObjectNamespace<KnowledgeChangeAgent>;
  PAUSE_ACK?: string;
}
export class KnowledgeChangeAgent extends ChangeAgent {
  async queueFixture() {
    await this.lifecycle.start();
    await this.enqueueKnowledge({
      context: {
        attemptId: "run",
        projectId: "project",
        repository: "repo",
        threadId: "thread",
        changeId: "change",
        runId: "run",
        baseSha: "a".repeat(40),
        configurationRevision: "1",
        contextRevision: "1",
      },
      report: {
        key: "note-1",
        text: "Synthetic verified constraint",
        kind: "constraint",
        sourceRefs: [
          { kind: "code", id: "fixture.ts", revision: "a".repeat(40), path: "fixture.ts" },
        ],
      },
    });
    return { queued: true };
  }
  async fixtureStatus() {
    await this.lifecycle.start();
    return this.sql`SELECT id,body,ack FROM knowledge_outbox`;
  }
}
export class KnowledgeReceiver extends Agent<Env> {
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
    if (this.env.PAUSE_ACK) throw Error("fixture_lost_ack");
    return { eventId, status: existing ? "duplicate" : "recorded" };
  }
  async fixtureStatus() {
    void this
      .sql`CREATE TABLE IF NOT EXISTS fixture_notes(id TEXT PRIMARY KEY,body TEXT NOT NULL,attempts INTEGER NOT NULL)`;
    return this.sql`SELECT id,body,attempts FROM fixture_notes`;
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
