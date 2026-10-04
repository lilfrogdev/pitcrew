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
    expect(outbox.pending()[0].last_error).toBe("invalid_ack");
    db.prepare("UPDATE knowledge_outbox SET retry_after=0").run(); // explicit fixture recovery after receiver repair
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

it("persists capacity backoff across SQLite reopen without losing pending reports or retrying hot", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pitcrew-capacity-")),
    path = join(directory, "outbox.sqlite");
  let db = new DatabaseSync(path),
    outbox = new KnowledgeOutbox(sqlitePort(db));
  try {
    outbox.enqueue(delivery);
    await expect(
      outbox.deliver(async () => {
        throw Error("knowledge_projection_capacity");
      }),
    ).rejects.toThrow("knowledge_projection_capacity");
    expect(outbox.pending()[0].last_error).toBe("capacity_or_conflict");
    expect(outbox.nextRetryAt()).toBeGreaterThan(Date.now() + 59000);
    const body = outbox.pending()[0].body;
    db.close();
    db = new DatabaseSync(path);
    outbox = new KnowledgeOutbox(sqlitePort(db));
    let calls = 0;
    await outbox.deliver(async () => {
      calls++;
      return { eventId: "worker:run:call-1", status: "recorded" };
    });
    expect(calls).toBe(0);
    expect(outbox.pending()[0].body).toBe(body);
    db.prepare("UPDATE knowledge_outbox SET retry_after=0").run();
    await outbox.deliver(async () => ({ eventId: "worker:run:call-1", status: "recorded" }));
    expect(outbox.pending()).toHaveLength(0);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it("backs off null and undefined acknowledgements with durable diagnostics", async () => {
  const db = new DatabaseSync(":memory:"),
    outbox = new KnowledgeOutbox(sqlitePort(db));
  try {
    outbox.enqueue(delivery);
    for (const invalid of [null, undefined]) {
      db.prepare("UPDATE knowledge_outbox SET retry_after=0").run();
      await expect(outbox.deliver(async () => invalid as never)).rejects.toThrow(
        "invalid_knowledge_ack",
      );
      expect(outbox.pending()[0].last_error).toBe("invalid_ack");
      expect(outbox.nextRetryAt()).toBeGreaterThan(Date.now() + 59000);
    }
  } finally {
    db.close();
  }
});

it("settles independent reports behind a failed delivery and retries only the unacknowledged event", async () => {
  const db = new DatabaseSync(":memory:"),
    outbox = new KnowledgeOutbox(sqlitePort(db));
  try {
    for (let i = 1; i <= 16; i++)
      outbox.enqueue({ ...delivery, report: { ...delivery.report, key: `call-${i}` } });
    const calls: string[] = [];
    await expect(
      outbox.deliver(async (value) => {
        calls.push(value.report.key);
        if (value.report.key === "call-1") throw Error("transport_unavailable");
        return { eventId: `worker:run:${value.report.key}`, status: "recorded" };
      }),
    ).rejects.toThrow("transport_unavailable");
    expect(calls).toHaveLength(16);
    expect(outbox.pending().map((row) => row.id)).toEqual(["worker:run:call-1"]);
    await outbox.deliver(async (value) => {
      expect(value).toEqual(delivery);
      return { eventId: "worker:run:call-1", status: "duplicate" };
    });
    expect(outbox.pending()).toHaveLength(0);
  } finally {
    db.close();
  }
});

it("does not let invalid or capacity acknowledgements block stale and rejected settlements", async () => {
  const db = new DatabaseSync(":memory:"),
    outbox = new KnowledgeOutbox(sqlitePort(db));
  try {
    for (let i = 1; i <= 4; i++)
      outbox.enqueue({ ...delivery, report: { ...delivery.report, key: `call-${i}` } });
    await expect(
      outbox.deliver(async (value) => {
        if (value.report.key === "call-1") return { eventId: "wrong", status: "recorded" };
        if (value.report.key === "call-2") throw Error("knowledge_projection_capacity");
        return {
          eventId: `worker:run:${value.report.key}`,
          status: value.report.key === "call-3" ? "stale" : "rejected",
        };
      }),
    ).rejects.toThrow("invalid_knowledge_ack");
    expect(outbox.pending().map((row) => row.last_error)).toEqual([
      "invalid_ack",
      "capacity_or_conflict",
    ]);
    expect(outbox.nextRetryAt()).toBeGreaterThan(Date.now() + 59000);
    await outbox.deliver(async () => {
      throw Error("must_not_retry_during_backoff");
    });
  } finally {
    db.close();
  }
});

it("coalesces concurrent flushes and releases the pass after failure for recovery", async () => {
  const db = new DatabaseSync(":memory:"),
    outbox = new KnowledgeOutbox(sqlitePort(db));
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    outbox.enqueue(delivery);
    let calls = 0;
    const send = async () => {
      calls++;
      await waiting;
      throw Error("lost_ack");
    };
    const passes = Array.from({ length: 32 }, () => outbox.deliver(send));
    const settled = Promise.allSettled(passes);
    expect(calls).toBe(1);
    release();
    expect((await settled).every((result) => result.status === "rejected")).toBe(true);
    expect(outbox.pending()).toHaveLength(1);
    await outbox.deliver(async () => ({ eventId: "worker:run:call-1", status: "recorded" }));
    expect(outbox.pending()).toHaveLength(0);
    await outbox.deliver(async () => {
      throw Error("settled_event_was_resent");
    });
  } finally {
    release();
    db.close();
  }
});
