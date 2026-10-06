import { afterEach, expect, it } from "vite-plus/test";
import { landingStateKey, readLandingStates, saveLandingState } from "./landing-storage";
import type { LandingState } from "./LandingControl";
afterEach(() => localStorage.clear());
const state: LandingState = { fingerprint: "binding", key: "approval-key", authorization: {
  authorizationId: "authorization", runId: "run", expectedTargetSha: "base", candidateSha: "candidate",
  configurationRevision: "config", backend: "artifacts", state: "authorized", expiresAt: Date.now() + 300000,
} };
it("isolates recoverable receipts by account, project and run", () => {
  saveLandingState("owner", "project", "run", state);
  expect(readLandingStates("bryan")).toEqual({});
  expect(readLandingStates("owner")[landingStateKey("owner", "other", "run")]).toBeUndefined();
  expect(readLandingStates("owner")[landingStateKey("owner", "project", "run")].authorization).toEqual(state.authorization);
});
it("recovers a pre-request interruption as uncertain rather than replayable", () => {
  saveLandingState("owner", "project", "run", { ...state, busy: true });
  const restored = readLandingStates("owner")[landingStateKey("owner", "project", "run")];
  expect(restored.busy).toBeUndefined();
  expect(restored.result).toMatchObject({ authorizationId: "authorization", status: "uncertain", backend: "artifacts" });
});
it("does not treat a browser-stored success as source landing proof", () => {
  localStorage.setItem("pitcrew.landing.pending.v1:owner", JSON.stringify({
    '["project","run"]': { ...state, result: { authorizationId: "authorization", backend: "artifacts",
      status: "landed", landedSha: "candidate" } },
  }));
  expect(readLandingStates("owner")[landingStateKey("owner", "project", "run")].result?.status).toBe("uncertain");
});
it("removes completed recovery state and preserves an approval retry key", () => {
  saveLandingState("owner", "project", "run", { key: "approval-key", fingerprint: "binding", busy: true });
  expect(readLandingStates("owner")[landingStateKey("owner", "project", "run")].key).toBe("approval-key");
  saveLandingState("owner", "project", "run", { ...state, result: { authorizationId: "authorization",
    backend: "artifacts", status: "landed", landedSha: "candidate" } });
  expect(readLandingStates("owner")).toEqual({});
});
it("ignores malformed recovery data and mismatched run ids", () => {
  localStorage.setItem("pitcrew.landing.pending.v1:owner", JSON.stringify({
    invalid: state,
    '["project","run"]': { ...state, authorization: { ...state.authorization, runId: "another" } },
  }));
  expect(readLandingStates("owner")).toEqual({});
});
