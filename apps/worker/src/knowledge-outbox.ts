import type { KnowledgeAck, KnowledgeReport, WorkerKnowledgeContext } from "@pitcrew/protocol";

export interface KnowledgeDelivery {
  context: WorkerKnowledgeContext;
  report: KnowledgeReport;
}
interface Row {
  id: string;
  body: string;
  ack: string | null;
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
      id TEXT PRIMARY KEY, body TEXT NOT NULL, ack TEXT)`);
  }
  get(id: string) {
    const [row] = this.sql
      .exec<Row & Record<string, string | number | null>>(
        "SELECT id,body,ack FROM knowledge_outbox WHERE id=?",
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
    this.sql.exec("INSERT INTO knowledge_outbox VALUES(?,?,NULL)", id, body);
    return id;
  }
  pending() {
    return this.sql
      .exec<Row & Record<string, string | number | null>>(
        "SELECT id,body,ack FROM knowledge_outbox WHERE ack IS NULL ORDER BY rowid LIMIT 16",
      )
      .toArray();
  }
  async deliver(send: (delivery: KnowledgeDelivery) => Promise<KnowledgeAck>) {
    for (const row of this.pending()) {
      const ack = await send(JSON.parse(row.body) as KnowledgeDelivery);
      if (
        ack.eventId !== row.id ||
        !["recorded", "duplicate", "stale", "rejected"].includes(ack.status)
      )
        throw Error("invalid_knowledge_ack");
      const existing = this.get(row.id);
      if (!existing || existing.body !== row.body) throw Error("idempotency_conflict");
      if (existing.ack && JSON.parse(existing.ack).eventId !== ack.eventId)
        throw Error("invalid_knowledge_ack");
      this.sql.exec(
        "UPDATE knowledge_outbox SET ack=? WHERE id=? AND ack IS NULL",
        JSON.stringify(ack),
        row.id,
      );
    }
  }
}
