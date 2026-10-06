import {
  encodedBytes,
  readVisualizationRecord,
  VisualizationError,
  VISUALIZATION_LIMITS,
  type VisualizationRecord,
} from "../../../packages/protocol/src/visualizations";
export interface VisualizationSql {
  exec(query: string, ...bindings: (string | number)[]): { toArray(): Record<string, unknown>[] };
}
// Private coordinator SQL only. Every lookup includes both repository and thread.
// Admission and live authority checks run inside the same synchronous transaction.
export class VisualizationStore {
  constructor(
    private sql: VisualizationSql,
    private transaction: <T>(work: () => T) => T,
  ) {
    sql.exec(`CREATE TABLE IF NOT EXISTS visualization_artifacts (
      id TEXT PRIMARY KEY, repository_id TEXT NOT NULL, thread_id TEXT NOT NULL,
      creator_actor TEXT NOT NULL, delivery_key TEXT NOT NULL, digest TEXT NOT NULL,
      bytes INTEGER NOT NULL, record_json TEXT NOT NULL,
      UNIQUE(repository_id,thread_id,creator_actor,delivery_key))`);
  }
  list(repositoryId: string, threadId: string): VisualizationRecord[] {
    const rows = this.sql
      .exec(
        "SELECT record_json FROM visualization_artifacts WHERE repository_id=? AND thread_id=? ORDER BY id LIMIT ?",
        repositoryId,
        threadId,
        VISUALIZATION_LIMITS.threadCount + 1,
      )
      .toArray();
    if (rows.length > VISUALIZATION_LIMITS.threadCount)
      throw new VisualizationError("visualization_store_unavailable", 503);
    return rows.map((row) => this.hydrate(row, repositoryId, threadId));
  }
  get(repositoryId: string, threadId: string, id: string): VisualizationRecord | undefined {
    const row = this.sql
      .exec(
        "SELECT record_json FROM visualization_artifacts WHERE repository_id=? AND thread_id=? AND id=?",
        repositoryId,
        threadId,
        id,
      )
      .toArray()[0];
    return row ? this.hydrate(row, repositoryId, threadId) : undefined;
  }
  private hydrate(row: Record<string, unknown>, repositoryId: string, threadId: string) {
    const result = readVisualizationRecord(JSON.parse(row.record_json as string));
    if (result.repositoryId !== repositoryId || result.threadId !== threadId)
      throw new VisualizationError("visualization_store_unavailable", 503);
    return result;
  }
  put(input: VisualizationRecord, key: string, fence: () => void): VisualizationRecord {
    const record = readVisualizationRecord(input),
      bytes = encodedBytes(record);
    return this.transaction(() => {
      fence();
      const prior = this.sql
        .exec(
          "SELECT record_json,digest FROM visualization_artifacts WHERE repository_id=? AND thread_id=? AND creator_actor=? AND delivery_key=?",
          record.repositoryId,
          record.threadId,
          record.creatorActor,
          key,
        )
        .toArray()[0];
      if (prior) {
        if (prior.digest !== record.digest)
          throw new VisualizationError("visualization_replay_conflict", 409);
        const existing = this.hydrate(prior, record.repositoryId, record.threadId);
        if (existing.turnId !== record.turnId || existing.invocationId !== record.invocationId)
          throw new VisualizationError("visualization_replay_conflict", 409);
        return existing;
      }
      const usage = (query: string, ...args: string[]) =>
        this.sql.exec(query, ...args).toArray()[0] as { count: number; bytes: number };
      const thread = usage(
        "SELECT COUNT(*) AS count,COALESCE(SUM(bytes),0) AS bytes FROM visualization_artifacts WHERE repository_id=? AND thread_id=?",
        record.repositoryId,
        record.threadId,
      );
      const repo = usage(
        "SELECT COUNT(*) AS count,COALESCE(SUM(bytes),0) AS bytes FROM visualization_artifacts WHERE repository_id=?",
        record.repositoryId,
      );
      if (
        thread.count >= VISUALIZATION_LIMITS.threadCount ||
        thread.bytes + bytes > VISUALIZATION_LIMITS.threadBytes ||
        repo.count >= VISUALIZATION_LIMITS.repositoryCount ||
        repo.bytes + bytes > VISUALIZATION_LIMITS.repositoryBytes
      )
        throw new VisualizationError("visualization_capacity", 429);
      fence();
      this.sql.exec(
        "INSERT INTO visualization_artifacts VALUES(?,?,?,?,?,?,?,?)",
        record.id,
        record.repositoryId,
        record.threadId,
        record.creatorActor,
        key,
        record.digest,
        bytes,
        JSON.stringify(record),
      );
      return structuredClone(record);
    });
  }
  // Only trusted thread deletion/retention lifecycle calls this; no public delete endpoint.
  deleteThread(repositoryId: string, threadId: string) {
    this.transaction(() =>
      this.sql.exec(
        "DELETE FROM visualization_artifacts WHERE repository_id=? AND thread_id=?",
        repositoryId,
        threadId,
      ),
    );
  }
}
