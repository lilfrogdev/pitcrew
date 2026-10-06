import { DurableObject } from "cloudflare:workers";
import { ExecutionError } from "../../../packages/execution/src/contracts.ts";
import {
  NativeTrustedPublisher,
  publisherBundleDigest,
  verifyPublisherAuthorization,
  type PublisherInput,
  type PublisherLandingInput,
  type PublisherJournal,
  type PublisherRecord,
  type PublisherRequest,
  type PublisherResult,
} from "../../../packages/execution/src/trusted-publisher.ts";

export interface PublisherAdmissionReceiver extends Rpc.DurableObjectBranded {
  assertPublisherAdmission(input: PublisherRecord["input"]): Promise<void>;
}
export interface TrustedPublisherEnv {
  EXECUTION_MODE: string;
  TRUSTED_PUBLISHER_ENABLED?: string;
  TRUSTED_PUBLISHER_AUTH_KEY?: string;
  ARTIFACTS?: Artifacts;
  REPOSITORY: DurableObjectNamespace<PublisherAdmissionReceiver>;
  TRUSTED_PUBLISHER?: DurableObjectNamespace<TrustedPublisherAgent>;
}

export function assertPublisherObjectIdentity(
  id: DurableObjectId,
  namespace: Pick<DurableObjectNamespace, "idFromName"> | undefined,
  operationId: string,
): void {
  if (
    !namespace ||
    typeof operationId !== "string" ||
    !id.equals(namespace.idFromName(`publisher:${operationId}`))
  )
    throw new ExecutionError("PUBLISHER_OBJECT_IDENTITY_MISMATCH");
}
export interface PublishedBundleIdentity {
  runId: string;
  artifactId: string;
  baseSha: string;
  candidateSha: string;
  bundleDigest: string;
  configurationRevision: string;
}

export class SqlitePublisherJournal implements PublisherJournal {
  constructor(private readonly storage: Pick<DurableObjectStorage, "sql" | "transactionSync">) {
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS publisher_operations(id TEXT PRIMARY KEY,record TEXT NOT NULL)",
    );
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS publisher_bundles(operation_id TEXT NOT NULL,ordinal INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(operation_id,ordinal))",
    );
  }
  async claim(id: string, record: PublisherRecord) {
    return this.storage.transactionSync(() => {
      const existing = this.get(id);
      if (existing) return { claimed: false, record: existing };
      const records = this.storage.sql
        .exec<{ record: string }>("SELECT record FROM publisher_operations")
        .toArray();
      if (records.length) throw new ExecutionError("PUBLISHER_DO_ALREADY_USED");
      this.storage.sql.exec(
        "INSERT INTO publisher_operations VALUES(?,?)",
        id,
        JSON.stringify(record),
      );
      return { claimed: true, record: structuredClone(record) };
    });
  }
  async read(id: string) {
    return this.get(id);
  }
  async update(id: string, fingerprint: string, patch: Partial<PublisherRecord>): Promise<void> {
    this.storage.transactionSync(() => {
      const record = this.get(id);
      if (!record || record.fingerprint !== fingerprint)
        throw new ExecutionError("PUBLISHER_IDENTITY_CONFLICT");
      // Cancellation is a durable tombstone: a late continuation cannot clear it.
      if (patch.cancelled === false && record.cancelled)
        throw new ExecutionError("PUBLISHER_CANCELLED");
      if (patch.fingerprint || patch.input)
        throw new ExecutionError("PUBLISHER_IDENTITY_IMMUTABLE");
      this.storage.sql.exec(
        "UPDATE publisher_operations SET record=? WHERE id=?",
        JSON.stringify({
          ...record,
          ...patch,
          cancelled: record.cancelled || patch.cancelled === true,
        }),
        id,
      );
    });
  }
  storeBundle(id: string, fingerprint: string, encoded: string): void {
    this.storage.transactionSync(() => {
      const existing = this.get(id);
      if (existing && existing.fingerprint !== fingerprint)
        throw new ExecutionError("PUBLISHER_REPLAY_CONFLICT");
      const chunks = this.storage.sql
        .exec<{ ordinal: number; data: string }>(
          "SELECT ordinal,data FROM publisher_bundles WHERE operation_id=? ORDER BY ordinal",
          id,
        )
        .toArray();
      if (chunks.length) {
        if (chunks.map((chunk) => chunk.data).join("") !== encoded)
          throw new ExecutionError("PUBLISHER_REPLAY_CONFLICT");
        return;
      }
      for (let i = 0; i < encoded.length; i += 65_536)
        this.storage.sql.exec(
          "INSERT INTO publisher_bundles VALUES(?,?,?)",
          id,
          i / 65_536,
          encoded.slice(i, i + 65_536),
        );
    });
  }
  bundle(id: string): string {
    const chunks = this.storage.sql
      .exec<{ ordinal: number; data: string }>(
        "SELECT ordinal,data FROM publisher_bundles WHERE operation_id=? ORDER BY ordinal",
        id,
      )
      .toArray();
    if (!chunks.length || chunks.some((chunk, i) => chunk.ordinal !== i))
      throw new ExecutionError("PUBLISHED_BUNDLE_UNAVAILABLE");
    return chunks.map((chunk) => chunk.data).join("");
  }
  private get(id: string): PublisherRecord | undefined {
    const [row] = this.storage.sql
      .exec<{ record: string }>("SELECT record FROM publisher_operations WHERE id=?", id)
      .toArray();
    return row ? (JSON.parse(row.record) as PublisherRecord) : undefined;
  }
}

// No fetch, generic command RPC, TCP proxy, model harness, checkout, task mounts,
// snapshots, or candidate code. Only trusted Worker RPC callers receive this binding.
export class TrustedPublisherAgent extends DurableObject<TrustedPublisherEnv> {
  private readonly journal: SqlitePublisherJournal;
  constructor(ctx: DurableObjectState, env: TrustedPublisherEnv) {
    super(ctx, env);
    this.journal = new SqlitePublisherJournal(ctx.storage);
  }
  private enabled(): void {
    if (
      this.env.EXECUTION_MODE !== "cloud" ||
      this.env.TRUSTED_PUBLISHER_ENABLED !== "true" ||
      !this.env.ARTIFACTS ||
      !this.ctx.container ||
      !this.env.TRUSTED_PUBLISHER_AUTH_KEY
    )
      throw new ExecutionError("TRUSTED_PUBLISHER_DISABLED");
  }
  private publisher() {
    if (!this.ctx.container || !this.env.ARTIFACTS)
      throw new ExecutionError("TRUSTED_PUBLISHER_DISABLED");
    return new NativeTrustedPublisher(
      this.env.ARTIFACTS,
      this.ctx.container,
      this.ctx.container.images.publisher ?? "",
      this.journal,
      async (input) => {
        this.enabled();
        if (input.repositoryAgentName !== "pitcrew")
          throw new ExecutionError("PUBLISHER_UNAUTHORIZED");
        // The repository owner enforces current durable budget, membership, Stop,
        // configuration and source approval; the HMAC authenticates the frozen tuple.
        const stub = this.env.REPOSITORY.get(this.env.REPOSITORY.idFromName("pitcrew"));
        await stub.assertPublisherAdmission(input);
      },
      undefined,
      async (input, fingerprint) => {
        // The native verifier has validated and atomically claimed this single-use
        // DO before payload storage or alarm changes are permitted.
        this.journal.storeBundle(input.operationId, fingerprint, input.bundleBase64);
        await this.ctx.storage.setAlarm(input.deadline);
      },
    );
  }
  private async execute(raw: PublisherRequest): Promise<PublisherResult> {
    const input = structuredClone(raw);
    this.enabled();
    assertPublisherObjectIdentity(this.ctx.id, this.env.TRUSTED_PUBLISHER, input.operationId);
    await verifyPublisherAuthorization(input, this.env.TRUSTED_PUBLISHER_AUTH_KEY!);
    if (input.bundleDigest !== (await publisherBundleDigest(input.bundleBase64)))
      throw new ExecutionError("BUNDLE_DIGEST_MISMATCH");
    return this.publisher().execute(input);
  }
  publish(input: PublisherInput) {
    return this.execute({ ...input, kind: "publish" });
  }
  land(input: PublisherLandingInput) {
    return this.execute({ ...input, kind: "land" });
  }
  async publishedBundle(
    operationId: string,
    expected: PublishedBundleIdentity,
  ): Promise<{
    bundleBase64: string;
    bundleDigest: string;
  }> {
    const record = await this.journal.read(operationId);
    if (
      !record ||
      record.input.kind !== "publish" ||
      record.result?.status !== "published" ||
      !record.result.cleanupVerified ||
      (
        [
          "runId",
          "artifactId",
          "baseSha",
          "candidateSha",
          "bundleDigest",
          "configurationRevision",
        ] as const
      ).some((key) => record.input[key] !== expected[key])
    )
      throw new ExecutionError("PUBLISHED_BUNDLE_UNAVAILABLE");
    // This is inert data access. Landing requires its own fresh signed authority and reservation.
    const bundleBase64 = this.journal.bundle(operationId);
    if ((await publisherBundleDigest(bundleBase64)) !== expected.bundleDigest)
      throw new ExecutionError("BUNDLE_DIGEST_MISMATCH");
    return { bundleBase64, bundleDigest: expected.bundleDigest };
  }
  async cleanup(operationId: string): Promise<boolean> {
    return this.publisher().cleanup(operationId);
  }
  async reconcile(operationId: string): Promise<{
    status: "uncertain";
    head?: string;
    candidatePresent: boolean;
    cleanupVerified: boolean;
  }> {
    const record = await this.journal.read(operationId);
    if (!record || !this.env.ARTIFACTS) throw new ExecutionError("PUBLISHER_NOT_FOUND");
    const stopped = await this.cleanup(operationId);
    using repo = await this.env.ARTIFACTS.get(
      record.input.kind === "publish" ? record.input.artifactId : record.input.sourceId,
    );
    const info = await repo.info();
    const name = record.input.kind === "publish" ? record.input.artifactId : record.input.sourceId;
    const id =
      record.input.kind === "publish"
        ? record.input.artifactRepositoryId
        : record.input.sourceRepositoryId;
    const remote =
      record.input.kind === "publish" ? record.input.artifactRemote : record.input.sourceRemote;
    if (info.name !== name || info.id !== id || info.remote !== remote)
      throw new ExecutionError("DESTINATION_IDENTITY_MISMATCH");
    const targetRef =
      record.input.kind === "publish" ? "refs/heads/candidate" : record.input.targetRef;
    const [head] = await repo.log({ ref: targetRef, limit: 1 });
    return {
      status: "uncertain",
      head: head?.hash,
      candidatePresent: head?.hash === record.input.candidateSha,
      cleanupVerified: stopped,
    };
  }
  async alarm(): Promise<void> {
    const rows = this.ctx.storage.sql
      .exec<{ id: string; record: string }>("SELECT id,record FROM publisher_operations")
      .toArray();
    for (const row of rows) {
      const record: PublisherRecord = JSON.parse(row.record);
      if (
        record.input.deadline <= Date.now() &&
        (record.state === "pending" ||
          record.containerOwned ||
          (record.lease && record.lease.state !== "revoked"))
      )
        await this.cleanup(row.id);
    }
  }
}
