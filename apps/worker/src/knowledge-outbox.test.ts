import { expect, it } from "vite-plus/test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KnowledgeOutbox, type KnowledgeDelivery, type KnowledgeSql } from "./knowledge-outbox";

export function sqlitePort(db: DatabaseSync): KnowledgeSql {
  return {
    exec: (query, ...bindings) => {
      const rows = db.prepare(query).all(...bindings);
      return { toArray: () => rows as never };
    },
  };
}
export const delivery: KnowledgeDelivery = {
  context: {
    attemptId: "run",
    projectId: "p",
    repository: "repo",
    threadId: "t",
    changeId: "c",
    runId: "run",
    baseSha: "a".repeat(40),
    configurationRevision: "1",
    contextRevision: "1",
  },
  report: {
    key: "call-1",
    text: "Verified fixture constraint",
    kind: "constraint",
    sourceRefs: [{ kind: "code", id: "fixture.ts", revision: "a".repeat(40), path: "fixture.ts" }],
  },
};
it("reopens SQLite after remote commit/lost ack, retries exact event, and persists acknowledgement", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pitcrew-outbox-"));
  const path = join(directory, "outbox.sqlite");
  let db = new DatabaseSync(path);
  let outbox = new KnowledgeOutbox(sqlitePort(db));
  const recorded = new Map<string, string>();
  const send = async (value: KnowledgeDelivery) => {
    const eventId = `worker:${value.context.runId}:${value.report.key}`;
    const existing = recorded.has(eventId);
    recorded.set(eventId, JSON.stringify(value));
    return { eventId, status: existing ? ("duplicate" as const) : ("recorded" as const) };
  };
  try {
    outbox.enqueue(delivery);
    await expect(
      outbox.deliver(async (value) => {
        await send(value);
        throw Error("lost_ack");
      }),
    ).rejects.toThrow("lost_ack");
    db.close();
    db = new DatabaseSync(path);
    outbox = new KnowledgeOutbox(sqlitePort(db));
    expect(outbox.pending()).toHaveLength(1);
    expect(outbox.enqueue(delivery)).toBe("worker:run:call-1");
    await outbox.deliver(send);
    expect(outbox.pending()).toHaveLength(0);
    expect(recorded.size).toBe(1);
    db.close();
    db = new DatabaseSync(path);
    outbox = new KnowledgeOutbox(sqlitePort(db));
    expect(JSON.parse(outbox.get("worker:run:call-1")!.ack!)).toEqual({
      eventId: "worker:run:call-1",
      status: "duplicate",
    });
    let calls = 0;
    await outbox.deliver(async (value) => {
      calls++;
      return send(value);
    });
    expect(calls).toBe(0);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
it("rejects conflicting replay/wrong ack and bounds selected notes, settling stale attempts without overwrite", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    const outbox = new KnowledgeOutbox(sqlitePort(db));
    outbox.enqueue(delivery);
    expect(() =>
      outbox.enqueue({ ...delivery, report: { ...delivery.report, text: "changed" } }),
    ).toThrow("idempotency_conflict");
    await expect(
      outbox.deliver(async () => ({ eventId: "wrong", status: "recorded" })),
    ).rejects.toThrow("invalid_knowledge_ack");
    expect(outbox.pending()).toHaveLength(1);
    await outbox.deliver(async () => ({ eventId: "worker:run:call-1", status: "stale" }));
    expect(outbox.pending()).toHaveLength(0);
    for (let i = 2; i <= 16; i++)
      outbox.enqueue({ ...delivery, report: { ...delivery.report, key: `call-${i}` } });
    expect(() =>
      outbox.enqueue({ ...delivery, report: { ...delivery.report, key: "call-17" } }),
    ).toThrow("knowledge_budget");
    expect(() =>
      outbox.enqueue({ ...delivery, report: { ...delivery.report, key: "invalid:key" } }),
    ).toThrow("invalid_report_key");
  } finally {
    db.close();
  }
});
