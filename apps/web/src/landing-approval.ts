import type { RunEvidence } from "@pitcrew/protocol";
import type { Authorization, Run, Review } from "./api";
import type { LandingState } from "./LandingControl";
export function landingEvidenceEligible(
  run: Run,
  evidence: RunEvidence | undefined,
  reviews: Review[],
) {
  const bound = (item: { baseSha: string; candidateSha: string; configurationRevision: string }) =>
    item.baseSha === run.baseSha &&
    item.candidateSha === run.candidateSha &&
    evidence?.run.id === run.id &&
    item.configurationRevision === run.configurationRevision;
  const tests = evidence?.tests;
  return Boolean(
    run.candidateSha &&
    !run.error &&
    ["awaiting_review", "waiting_user", "completed"].includes(run.status) &&
    tests?.status === "passed" &&
    tests.exitCode === 0 &&
    !tests.truncated &&
    tests.argv.length > 0 &&
    bound(tests) &&
    reviews.some(
      (review) =>
        review.runId === run.id &&
        review.decision === "approve" &&
        Boolean(review.actor.trim()) &&
        bound(review),
    ) &&
    !reviews.some((review) => review.decision === "request_changes" && bound(review)),
  );
}
export function landingApprovalPending(
  run: Run,
  evidence: RunEvidence | undefined,
  reviews: Review[],
  enabled: boolean,
  backend: Authorization["backend"] | null,
  state: LandingState = {},
) {
  return (
    enabled &&
    ["fixture", "artifacts"].includes(backend ?? "") &&
    landingEvidenceEligible(run, evidence, reviews) &&
    !state.busy &&
    !state.authorization &&
    !state.result &&
    !run.landing
  );
}
