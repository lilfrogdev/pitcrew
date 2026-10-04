import type { Review, TestEvidence } from "../../protocol/src/index.ts";
import { assertSha, ExecutionError } from "./contracts.ts";

export interface LandingEvidence {
  runId: string;
  projectId: string;
  repository: string;
  artifactId: string;
  targetRef: string;
  baseSha: string;
  candidateSha: string;
  configurationRevision: string;
  currentConfigurationRevision: string;
  tests: TestEvidence[];
  review: Review;
}
export interface LandingEvidenceSource {
  // Read trusted persisted evidence, never client-supplied summaries. Configuration
  // mutations must share the LandingStore repository gate during this read/push.
  read(runId: string): Promise<LandingEvidence>;
}
export interface LandingApproval {
  runId: string;
  actor: string; // supplied by the authenticated server route
  expectedTargetSha: string;
  candidateSha: string;
  configurationRevision: string;
  idempotencyKey: string;
}
export interface LandingAuthorization extends Omit<LandingApproval, "idempotencyKey"> {
  authorizationId: string;
  projectId: string;
  repository: string;
  artifactId: string;
  targetRef: string;
  expiresAt: number;
}
export interface LandingResult {
  authorizationId: string;
  status: "landed" | "rejected" | "uncertain";
  landedSha?: string;
  code?: string;
}
export interface LandingRecord {
  authorization: LandingAuthorization;
  state: "authorized" | "pending" | "landed" | "rejected" | "uncertain";
  result?: LandingResult;
}
export interface LandingStore {
  issue(
    key: string,
    fingerprint: string,
    authorization: LandingAuthorization,
  ): LandingAuthorization;
  // Atomically validate actor/run/expiry, consume permission and acquire repository
  // gate. No expiring mutex: pending/uncertain gates survive process interruption.
  begin(id: string, actor: string, runId: string, now: number): LandingRecord;
  get(id: string, actor: string, runId: string): LandingRecord;
  finish(id: string, result: LandingResult): void;
  assertRepositoryIdle(repository: string): void;
}
export interface LandingTransport {
  targetHead(authorization: LandingAuthorization): Promise<string>;
  land(
    authorization: LandingAuthorization,
  ): Promise<{ status: "landed" | "rejected" | "uncertain"; code?: string }>;
}

export function assertLandingEvidence(
  evidence: LandingEvidence,
  authorization: LandingAuthorization,
): void {
  const { review, tests } = evidence;
  if (
    evidence.runId !== authorization.runId ||
    evidence.projectId !== authorization.projectId ||
    evidence.repository !== authorization.repository ||
    evidence.artifactId !== authorization.artifactId ||
    evidence.targetRef !== authorization.targetRef ||
    evidence.baseSha !== authorization.expectedTargetSha ||
    evidence.candidateSha !== authorization.candidateSha ||
    evidence.configurationRevision !== authorization.configurationRevision ||
    evidence.currentConfigurationRevision !== authorization.configurationRevision ||
    review.runId !== evidence.runId ||
    !review.actor ||
    review.decision !== "approve" ||
    review.baseSha !== evidence.baseSha ||
    review.candidateSha !== evidence.candidateSha ||
    review.configurationRevision !== evidence.configurationRevision ||
    !tests.length ||
    tests.some(
      (test) =>
        test.status !== "passed" ||
        test.exitCode !== 0 ||
        test.truncated ||
        !test.argv.length ||
        test.baseSha !== evidence.baseSha ||
        test.candidateSha !== evidence.candidateSha ||
        test.configurationRevision !== evidence.configurationRevision,
    )
  )
    throw new ExecutionError("LANDING_EVIDENCE_REJECTED");
}

export class TrustedLandingService {
  constructor(
    private readonly source: LandingEvidenceSource,
    private readonly store: LandingStore,
    private readonly transport: LandingTransport,
    private readonly now = () => Date.now(),
    private readonly newId = () => crypto.randomUUID(),
  ) {}

  async authorize(approval: LandingApproval): Promise<LandingAuthorization> {
    assertSha(approval.expectedTargetSha);
    assertSha(approval.candidateSha);
    if (
      !approval.actor ||
      !approval.runId ||
      !approval.configurationRevision ||
      !approval.idempotencyKey ||
      approval.idempotencyKey.length > 128 ||
      approval.actor.length > 256 ||
      approval.runId.length > 128
    )
      throw new ExecutionError("INVALID_LANDING_APPROVAL");
    const evidence = await this.source.read(approval.runId);
    const authorization: LandingAuthorization = {
      authorizationId: this.newId(),
      runId: approval.runId,
      actor: approval.actor,
      projectId: evidence.projectId,
      repository: evidence.repository,
      artifactId: evidence.artifactId,
      targetRef: evidence.targetRef,
      expectedTargetSha: approval.expectedTargetSha,
      candidateSha: approval.candidateSha,
      configurationRevision: approval.configurationRevision,
      expiresAt: this.now() + 300_000,
    };
    assertLandingEvidence(evidence, authorization);
    this.store.assertRepositoryIdle(authorization.repository);
    if ((await this.transport.targetHead(authorization)) !== authorization.expectedTargetSha)
      throw new ExecutionError("STALE_TARGET");
    const key = JSON.stringify([approval.actor, approval.runId, approval.idempotencyKey]);
    const fingerprint = JSON.stringify([
      approval.expectedTargetSha,
      approval.candidateSha,
      approval.configurationRevision,
      authorization.projectId,
      authorization.repository,
      authorization.artifactId,
      authorization.targetRef,
    ]);
    return this.store.issue(key, fingerprint, authorization);
  }

  async land(input: {
    authorizationId: string;
    runId: string;
    actor: string;
  }): Promise<LandingResult> {
    // begin synchronously consumes permission and serializes only canonical landing.
    const record = this.store.begin(input.authorizationId, input.actor, input.runId, this.now());
    if (record.state !== "pending" || record.result)
      return (
        record.result ?? {
          authorizationId: input.authorizationId,
          status: "uncertain",
          code: "RECONCILIATION_REQUIRED",
        }
      );
    const authorization = record.authorization;
    let attempted = false;
    let result: LandingResult;
    try {
      const evidence = await this.source.read(authorization.runId);
      assertLandingEvidence(evidence, authorization);
      if ((await this.transport.targetHead(authorization)) !== authorization.expectedTargetSha)
        throw new ExecutionError("STALE_TARGET");
      attempted = true;
      const landed = await this.transport.land(authorization);
      result = {
        authorizationId: authorization.authorizationId,
        ...landed,
        ...(landed.status === "landed" ? { landedSha: authorization.candidateSha } : {}),
      };
    } catch (error) {
      result = {
        authorizationId: authorization.authorizationId,
        status: attempted ? "uncertain" : "rejected",
        code:
          error instanceof ExecutionError
            ? error.code
            : attempted
              ? "LANDING_UNCERTAIN"
              : "LANDING_VALIDATION_FAILED",
      };
    }
    try {
      this.store.finish(authorization.authorizationId, result);
    } catch {
      return {
        authorizationId: authorization.authorizationId,
        status: "uncertain",
        code: "RECONCILIATION_REQUIRED",
      };
    }
    return result;
  }

  async reconcile(input: {
    authorizationId: string;
    runId: string;
    actor: string;
  }): Promise<LandingResult> {
    const record = this.store.get(input.authorizationId, input.actor, input.runId);
    if (record.state === "authorized") throw new ExecutionError("LANDING_NOT_STARTED");
    if (record.state === "landed" || record.state === "rejected") return record.result!;
    // Read only. A target equal to the candidate establishes the desired landing
    // outcome, not who wrote it. Any other target remains quarantined: an old
    // request can still be in flight, so observing the base cannot justify retry.
    const head = await this.transport.targetHead(record.authorization);
    if (head !== record.authorization.candidateSha)
      return {
        authorizationId: input.authorizationId,
        status: "uncertain",
        code: "RECONCILIATION_REQUIRED",
      };
    const result: LandingResult = {
      authorizationId: input.authorizationId,
      status: "landed",
      landedSha: head,
      code: "RECONCILED_TARGET",
    };
    this.store.finish(input.authorizationId, result);
    return result;
  }
}
