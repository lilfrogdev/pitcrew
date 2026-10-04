import type { KnowledgeAck, KnowledgeReport, WorkerKnowledgeContext } from "@pitcrew/protocol";

export interface KnowledgeDelivery {
  context: WorkerKnowledgeContext;
  report: KnowledgeReport;
}
interface Row {
  id: string;
  body: string;
  ack: string | null;
  last_error: string | null;
  retry_after: number | null;
}
export interface KnowledgeSql {
  exec<T extends Record<string, string | number | null>>(
    query: string,
    ...bindings: (string | number | null)[]
  ): { toArray(): T[] };
}

// Independent of the unsafe mutation journal: retransmitting an immutable proposal is safe.
export class KnowledgeOutbox {
  constructor(private sql: KnowledgeSql) {
    sql.exec(`CREATE TABLE IF NOT EXISTS knowledge_outbox (
      id TEXT PRIMARY KEY, body TEXT NOT NULL, ack TEXT, last_error TEXT, retry_after INTEGER)`);
    const columns = sql.exec<{ name: string }>("PRAGMA table_info(knowledge_outbox)").toArray();
    if (!columns.some((column) => column.name === "last_error"))
      sql.exec("ALTER TABLE knowledge_outbox ADD COLUMN last_error TEXT");
    if (!columns.some((column) => column.name === "retry_after"))
      sql.exec("ALTER TABLE knowledge_outbox ADD COLUMN retry_after INTEGER");
  }
  get(id: string) {
    const [row] = this.sql
      .exec<Row & Record<string, string | number | null>>(
        "SELECT id,body,ack,last_error,retry_after FROM knowledge_outbox WHERE id=?",
        id,
      )
      .toArray();
    return row;
  }
  enqueue(delivery: KnowledgeDelivery) {
    const { context, report } = delivery;
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(report.key)) throw Error("invalid_report_key");
    const id = `worker:${context.runId}:${report.key}`;
    const body = JSON.stringify(delivery);
    if (new TextEncoder().encode(body).length > 16384) throw Error("report_too_large");
    const existing = this.get(id);
    if (existing) {
      if (existing.body !== body) throw Error("idempotency_conflict");
      return id;
    }
    const [count] = this.sql
      .exec<{ n: number }>("SELECT count(*) AS n FROM knowledge_outbox")
      .toArray();
    if (count.n >= 16) throw Error("knowledge_budget");
    this.sql.exec("INSERT INTO knowledge_outbox(id,body,ack) VALUES(?,?,NULL)", id, body);
    return id;
  }
  pending() {
    return this.sql
      .exec<Row & Record<string, string | number | null>>(
        "SELECT id,body,ack,last_error,retry_after FROM knowledge_outbox WHERE ack IS NULL ORDER BY rowid LIMIT 16",
      )
      .toArray();
  }
  nextRetryAt() {
    return Math.min(
      ...this.pending().map((row) => Math.max(Date.now() + 1000, row.retry_after ?? 0)),
    );
  }
  async deliver(send: (delivery: KnowledgeDelivery) => Promise<KnowledgeAck>) {
    for (const row of this.pending()) {
      if ((row.retry_after ?? 0) > Date.now()) continue;
      let ack: KnowledgeAck;
      try {
        ack = await send(JSON.parse(row.body) as KnowledgeDelivery);
      } catch (error) {
        const persistent =
          error instanceof Error &&
          /(?:knowledge_projection_capacity|^capacity$|idempotency_conflict)/.test(error.message);
        const code = persistent ? "capacity_or_conflict" : "delivery_unavailable";
        this.sql.exec(
          "UPDATE knowledge_outbox SET last_error=?,retry_after=? WHERE id=? AND ack IS NULL",
          code,
          Date.now() + (persistent ? 60000 : 0),
          row.id,
        );
        throw error;
      }
      if (
        ack.eventId !== row.id ||
        !["recorded", "duplicate", "stale", "rejected"].includes(ack.status)
      ) {
        this.sql.exec(
          "UPDATE knowledge_outbox SET last_error=?,retry_after=? WHERE id=? AND ack IS NULL",
          "invalid_ack",
          Date.now() + 60000,
          row.id,
        );
        throw Error("invalid_knowledge_ack");
      }
      const existing = this.get(row.id);
      if (!existing || existing.body !== row.body) throw Error("idempotency_conflict");
      if (existing.ack && JSON.parse(existing.ack).eventId !== ack.eventId)
        throw Error("invalid_knowledge_ack");
      this.sql.exec(
        "UPDATE knowledge_outbox SET ack=?,last_error=NULL,retry_after=NULL WHERE id=? AND ack IS NULL",
        JSON.stringify(ack),
        row.id,
      );
    }
  }
}
