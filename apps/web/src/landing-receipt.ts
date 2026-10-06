import type { LandingResult, Run } from "./api";

export function isLandedReceipt(
  run: Run,
  receipt: LandingResult | undefined,
  backend?: LandingResult["backend"] | null,
): boolean {
  return Boolean(
    receipt &&
    typeof receipt.authorizationId === "string" && receipt.authorizationId.trim() &&
    ["fixture", "artifacts"].includes(receipt.backend) &&
    (!backend || receipt.backend === backend) &&
    (!run.artifactAdmission || receipt.backend === "artifacts") &&
    receipt.status === "landed" &&
    !run.error &&
    run.candidateSha &&
    receipt.landedSha === run.candidateSha,
  );
}

// Proposal generation, review approval and a status label are not landing proof.
export function runDisplayStatus(run: Run): Run["status"] {
  if (run.status === "completed" && run.error) return "failed";
  return run.status === "completed" && !isLandedReceipt(run, run.landing)
    ? "awaiting_review"
    : run.status;
}
