import { describe, expect, it } from "vite-plus/test";
import type { Run } from "./api";
import { isLandedReceipt, runDisplayStatus } from "./landing-receipt";
const run: Run = {
  id: "r",
  threadId: "t",
  status: "completed",
  baseSha: "base",
  candidateSha: "candidate",
  configurationRevision: "v1",
};
const receipt = {
  authorizationId: "receipt",
  backend: "artifacts" as const,
  status: "landed" as const,
  landedSha: "candidate",
};
describe("run completion presentation", () => {
  it("requires an exact source receipt rather than a proposal or completed status", () => {
    expect(runDisplayStatus(run)).toBe("awaiting_review");
    expect(runDisplayStatus({ ...run, landing: receipt })).toBe("completed");
    expect(runDisplayStatus({ ...run, status: "awaiting_review", landing: receipt })).toBe(
      "awaiting_review",
    );
  });
  it.each([
    { ...receipt, status: "uncertain" as const },
    { ...receipt, status: "rejected" as const },
    { ...receipt, landedSha: "another" },
    { ...receipt, authorizationId: " " },
    { ...receipt, backend: "unknown" },
    { ...receipt, authorizationId: 42 },
  ])("rejects invalid completion receipt %j", (invalid) => {
    expect(runDisplayStatus({ ...run, landing: invalid as typeof receipt })).toBe(
      "awaiting_review",
    );
  });
  it("rejects fixture receipts for an admitted Artifacts run and fails interrupted work", () => {
    expect(
      isLandedReceipt(
        { ...run, artifactAdmission: {} as Run["artifactAdmission"] },
        { ...receipt, backend: "fixture" },
      ),
    ).toBe(false);
    expect(isLandedReceipt(run, receipt, "fixture")).toBe(false);
    expect(runDisplayStatus({ ...run, landing: receipt, error: "reconciliation_required" })).toBe(
      "failed",
    );
  });
});
