import { ExecutionError } from "./contracts.ts";
import type {
  LandingAuthorization,
  LandingRecord,
  LandingResult,
  LandingStore,
} from "./landing.ts";

export class SqliteLandingStore implements LandingStore {
  constructor(private readonly storage: Pick<DurableObjectStorage, "sql" | "transactionSync">) {
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS landing_permissions (
      id TEXT PRIMARY KEY, issue_key TEXT UNIQUE NOT NULL, fingerprint TEXT NOT NULL, record TEXT NOT NULL)`);
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS landing_repository_gates (
      repository TEXT PRIMARY KEY, authorization_id TEXT UNIQUE NOT NULL)`);
  }

  recoverIssue(key: string, requestFingerprint: string): LandingAuthorization | undefined {
    const [row] = this.storage.sql
      .exec<{ record: string }>("SELECT record FROM landing_permissions WHERE issue_key = ?", key)
      .toArray();
    if (!row) return undefined;
    const authorization = (JSON.parse(row.record) as LandingRecord).authorization;
    const originalRequest = JSON.stringify([
      authorization.expectedTargetSha,
      authorization.candidateSha,
      authorization.configurationRevision,
    ]);
    if (originalRequest !== requestFingerprint) throw new ExecutionError("IDEMPOTENCY_CONFLICT");
    return authorization;
  }

  issue(
    key: string,
    fingerprint: string,
    authorization: LandingAuthorization,
  ): LandingAuthorization {
    return this.storage.transactionSync(() => {
      const [existing] = this.storage.sql
        .exec<{ fingerprint: string; record: string }>(
          "SELECT fingerprint, record FROM landing_permissions WHERE issue_key = ?",
          key,
        )
        .toArray();
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new ExecutionError("IDEMPOTENCY_CONFLICT");
        return (JSON.parse(existing.record) as LandingRecord).authorization;
      }
      const record: LandingRecord = { authorization, state: "authorized" };
      this.storage.sql.exec(
        "INSERT INTO landing_permissions VALUES (?, ?, ?, ?)",
        authorization.authorizationId,
        key,
        fingerprint,
        JSON.stringify(record),
      );
      return authorization;
    });
  }

  get(id: string, actor: string, runId: string): LandingRecord {
    const [row] = this.storage.sql
      .exec<{ record: string }>("SELECT record FROM landing_permissions WHERE id = ?", id)
      .toArray();
    if (!row) throw new ExecutionError("AUTHORIZATION_NOT_FOUND");
    const record: LandingRecord = JSON.parse(row.record);
    if (record.authorization.actor !== actor || record.authorization.runId !== runId)
      throw new ExecutionError("AUTHORIZATION_NOT_FOUND");
    return record;
  }

  begin(id: string, actor: string, runId: string, now: number): LandingRecord {
    return this.storage.transactionSync(() => {
      const record = this.get(id, actor, runId);
      if (record.state !== "authorized") {
        // Return a receipt rather than executing again, including concurrent replay.
        return {
          ...record,
          result: record.result ?? {
            authorizationId: id,
            status: "uncertain",
            code: "RECONCILIATION_REQUIRED",
          },
        };
      }
      if (record.authorization.expiresAt <= now) throw new ExecutionError("AUTHORIZATION_EXPIRED");
      this.assertRepositoryIdle(record.authorization.repository);
      this.storage.sql.exec(
        "INSERT INTO landing_repository_gates VALUES (?, ?)",
        record.authorization.repository,
        id,
      );
      record.state = "pending";
      this.write(id, record);
      return record;
    });
  }

  finish(id: string, result: LandingResult): void {
    this.storage.transactionSync(() => {
      const [row] = this.storage.sql
        .exec<{ record: string }>("SELECT record FROM landing_permissions WHERE id = ?", id)
        .toArray();
      if (!row) throw new ExecutionError("AUTHORIZATION_NOT_FOUND");
      const record: LandingRecord = JSON.parse(row.record);
      if (result.authorizationId !== id || record.state === "authorized")
        throw new ExecutionError("INVALID_LANDING_RECEIPT");
      if (record.state === "landed" || record.state === "rejected") {
        if (JSON.stringify(record.result) !== JSON.stringify(result))
          throw new ExecutionError("LANDING_ALREADY_FINISHED");
        return;
      }
      record.state = result.status;
      record.result = result;
      this.write(id, record);
      if (result.status !== "uncertain")
        this.storage.sql.exec(
          "DELETE FROM landing_repository_gates WHERE authorization_id = ?",
          id,
        );
    });
  }

  assertRepositoryIdle(repository: string): void {
    const [gate] = this.storage.sql
      .exec(
        "SELECT authorization_id FROM landing_repository_gates WHERE repository = ?",
        repository,
      )
      .toArray();
    if (gate) throw new ExecutionError("REPOSITORY_LANDING_BUSY");
  }

  private write(id: string, record: LandingRecord): void {
    this.storage.sql.exec(
      "UPDATE landing_permissions SET record = ? WHERE id = ?",
      JSON.stringify(record),
      id,
    );
  }
}
