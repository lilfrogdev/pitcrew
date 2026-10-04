import { assertSha, ExecutionError } from "./contracts.ts";
import type { LandingAuthorization, LandingTransport } from "./landing.ts";

export type LandingGitAccess = "none" | "target-read" | "target-write" | "candidate-read";
export interface TrustedGitSession {
  targetRemote: string;
  candidateRemote: string;
  // Only the trusted landing transport receives this port; no task tool receives
  // its runner or credentials. Every session is a fresh bare repository.
  run(argv: string[], access: LandingGitAccess): Promise<{ exitCode: number; stdout: string }>;
  close(): Promise<void>;
}
export interface TrustedGitSessionFactory {
  open(authorization: LandingAuthorization): Promise<TrustedGitSession>;
}
export function assertTargetRef(ref: string): void {
  if (
    !/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9_./-]{0,127}$/.test(ref) ||
    ref.includes("..") ||
    ref.includes("//") ||
    ref.endsWith("/") ||
    ref.endsWith(".") ||
    ref.split("/").some((part) => part.startsWith(".") || part.endsWith(".lock"))
  )
    throw new ExecutionError("INVALID_TARGET_REF");
}

export class GitLandingTransport implements LandingTransport {
  constructor(private readonly factory: TrustedGitSessionFactory) {}

  async targetHead(authorization: LandingAuthorization): Promise<string> {
    assertTargetRef(authorization.targetRef);
    const session = await this.factory.open(authorization);
    try {
      const result = await session.run(
        ["ls-remote", "--exit-code", "--refs", "--", session.targetRemote, authorization.targetRef],
        "target-read",
      );
      const lines = result.stdout.trim().split("\n");
      const [sha, ref] = lines[0].split("\t");
      if (result.exitCode !== 0 || lines.length !== 1 || ref !== authorization.targetRef)
        throw new ExecutionError("TARGET_UNAVAILABLE");
      assertSha(sha);
      return sha;
    } finally {
      await session.close();
    }
  }

  async land(
    authorization: LandingAuthorization,
  ): Promise<{ status: "landed" | "rejected" | "uncertain"; code?: string }> {
    assertSha(authorization.expectedTargetSha);
    assertSha(authorization.candidateSha);
    assertTargetRef(authorization.targetRef);
    const session = await this.factory.open(authorization);
    let pushing = false;
    try {
      const fetchBase = await session.run(
        [
          "fetch",
          "--no-tags",
          "--no-recurse-submodules",
          "--",
          session.targetRemote,
          authorization.targetRef,
        ],
        "target-read",
      );
      const head = await session.run(["rev-parse", "FETCH_HEAD"], "none");
      if (fetchBase.exitCode !== 0 || head.exitCode !== 0)
        throw new ExecutionError("TARGET_UNAVAILABLE");
      if (head.stdout.trim() !== authorization.expectedTargetSha)
        throw new ExecutionError("STALE_TARGET");
      if (authorization.candidateSha === authorization.expectedTargetSha)
        throw new ExecutionError("NO_CHANGE");
      const fetchCandidate = await session.run(
        [
          "fetch",
          "--no-tags",
          "--no-recurse-submodules",
          "--",
          session.candidateRemote,
          "refs/heads/candidate",
        ],
        "candidate-read",
      );
      const type = await session.run(["cat-file", "-t", authorization.candidateSha], "none");
      if (fetchCandidate.exitCode !== 0 || type.exitCode !== 0 || type.stdout.trim() !== "commit")
        throw new ExecutionError("CANDIDATE_UNAVAILABLE");
      const ancestor = await session.run(
        [
          "merge-base",
          "--is-ancestor",
          authorization.expectedTargetSha,
          authorization.candidateSha,
        ],
        "none",
      );
      if (ancestor.exitCode !== 0) throw new ExecutionError("NON_FAST_FORWARD");
      // Git's fully specified lease is the conditional ref guard; this is NOT an
      // Artifacts CAS method. A single ref needs no multi-ref --atomic capability.
      // No force rewrite is allowed: ancestry was checked above.
      // https://git-scm.com/docs/git-push#Documentation/git-push.txt---force-with-leaseltrefnamegtltexpectgt
      pushing = true;
      const push = await session.run(
        [
          "push",
          "--porcelain",
          "--no-verify",
          "--no-signed",
          "--no-recurse-submodules",
          `--force-with-lease=${authorization.targetRef}:${authorization.expectedTargetSha}`,
          "--",
          session.targetRemote,
          `${authorization.candidateSha}:${authorization.targetRef}`,
        ],
        "target-write",
      );
      const updates = push.stdout.split("\n").filter((line) => /^[ =!*+-]\t/.test(line));
      // Only a successful fast-forward receipt counts. Up-to-date can bypass a
      // lease check, so '=' must never be interpreted as a guarded update.
      if (
        push.exitCode !== 0 ||
        updates.length !== 1 ||
        !updates[0].startsWith(" \t") ||
        updates[0].split("\t")[1] !== `${authorization.candidateSha}:${authorization.targetRef}`
      )
        return { status: "uncertain", code: "RECONCILIATION_REQUIRED" };
      return { status: "landed" };
    } catch (error) {
      return {
        status: pushing ? "uncertain" : "rejected",
        code:
          error instanceof ExecutionError
            ? error.code
            : pushing
              ? "RECONCILIATION_REQUIRED"
              : "GIT_VALIDATION_FAILED",
      };
    } finally {
      await session.close();
    }
  }
}

// For a future, separately authorized provider validation. Implementations must
// use disposable repositories and control a competing write during receive-pack.
// This module never creates repositories or invokes this probe automatically.
export interface LandingConformanceFixture {
  transport: LandingTransport;
  authorization: LandingAuthorization;
  competingSha: string;
  divergentSha: string;
  resetTarget(sha: string): Promise<void>;
  publishCandidate(sha: string): Promise<void>;
  raceDuringPush(sha: string): Promise<void>;
  targetTree(): Promise<string>;
  candidateTree(): Promise<string>;
}
export async function verifyLandingConformance(fixture: LandingConformanceFixture): Promise<void> {
  const { authorization: a, transport: t } = fixture;
  await fixture.resetTarget(fixture.competingSha);
  if ((await t.land(a)).status === "landed" || (await t.targetHead(a)) !== fixture.competingSha)
    throw new ExecutionError("CONFORMANCE_STALE_TARGET_FAILED");
  await fixture.resetTarget(a.expectedTargetSha);
  await fixture.publishCandidate(fixture.divergentSha);
  if (
    (await t.land({ ...a, candidateSha: fixture.divergentSha })).status === "landed" ||
    (await t.targetHead(a)) !== a.expectedTargetSha
  )
    throw new ExecutionError("CONFORMANCE_NO_REWRITE_FAILED");
  await fixture.publishCandidate(a.candidateSha);
  await fixture.raceDuringPush(fixture.competingSha);
  if ((await t.land(a)).status === "landed" || (await t.targetHead(a)) !== fixture.competingSha)
    throw new ExecutionError("CONFORMANCE_TARGET_RACE_FAILED");
  await fixture.resetTarget(a.expectedTargetSha);
  if (
    (await t.land(a)).status !== "landed" ||
    (await t.targetHead(a)) !== a.candidateSha ||
    (await fixture.targetTree()) !== (await fixture.candidateTree())
  )
    throw new ExecutionError("CONFORMANCE_EXACT_TREE_FAILED");
}
