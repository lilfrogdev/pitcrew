import { expect, it } from "vite-plus/test";
import {
  InfrastructureAdmission,
  boundedCleanupRpc,
  type AdmissionState,
  type AdmissionStore,
} from "./infrastructure-admission";
function fixture() {
  let state: AdmissionState | undefined;
  let timestamp = Date.parse("2026-10-05T00:00:00Z");
  const store: AdmissionStore = {
    transaction: (fn) => fn(),
    read: () => state && structuredClone(state),
    write: (next) => {
      state = structuredClone(next);
    },
  };
  return {
    create: () => new InfrastructureAdmission(store, () => timestamp),
    advance: (ms: number) => {
      timestamp += ms;
    },
  };
}
it("serializes shared reservations across restarts and preserves uncertain ownership", () => {
  const f = fixture(),
    first = f.create();
  expect(first.reserve("run1", "fp1", false).allowed).toBe(false);
  expect(first.reserve("run1", "fp1", true).allowed).toBe(true);
  const recovered = f.create();
  expect(recovered.reserve("run1", "fp1", true).allowed).toBe(true);
  expect(() => recovered.reserve("run1", "changed", true)).toThrow("admission_identity_conflict");
  expect(recovered.reserve("run2", "fp2", true)).toMatchObject({ allowed: false, reason: "busy" });
  expect(() => recovered.release("run1", false)).toThrow("cleanup_not_verified");
  f.advance(31 * 24 * 60 * 60 * 1000);
  expect(recovered.reserve("run2", "fp2", true).allowed).toBe(false);
  expect(recovered.stopRequired("run1", true)).toBe(true);
  recovered.release("run1", true);
  expect(recovered.reserve("run2", "fp2", true).allowed).toBe(true);
});
it("never refunds reservations on completion and fails closed at monthly threshold", () => {
  const admission = fixture().create();
  for (let i = 0; i < 15; i++) {
    expect(admission.reserve(`run${i}`, `fp${i}`, true).allowed).toBe(true);
    admission.release(`run${i}`, true);
  }
  expect(admission.reserve("run16", "fp16", true)).toMatchObject({
    allowed: false,
    reason: "monthly_reservations_exhausted",
  });
  expect(admission.reserve("run0", "fp0", true).allowed).toBe(false);
});
it("disabled execution, deadline and durable pause request stop without freeing a slot", () => {
  const f = fixture(),
    admission = f.create();
  admission.reserve("run", "fp", true);
  expect(admission.stopRequired("run", false)).toBe(true);
  expect(f.create().reserve("other", "fp2", true).allowed).toBe(false);
  admission.release("run", true);
  admission.reserve("next", "fp3", true);
  f.advance(600000);
  expect(admission.reserve("next", "fp3", true).allowed).toBe(false);
  expect(admission.stopRequired("next", true)).toBe(true);
  admission.pause();
  admission.release("next", true);
  expect(f.create().reserve("later", "fp4", true)).toMatchObject({
    allowed: false,
    reason: "paused",
  });
});
it("bounds cleanup retries, parks uncertain work and keeps its concurrency slot", () => {
  const admission = fixture().create();
  admission.reserve("run", "fp", true);
  admission.stopRequired("run", false);
  for (let i = 0; i < 12; i++) expect(admission.beginCleanupAttempt("run")).toBe(true);
  expect(admission.beginCleanupAttempt("run")).toBe(false);
  expect(admission.monitored()).toEqual([]);
  expect(admission.active()).toMatchObject([{ state: "quarantined", cleanupAttempts: 12 }]);
  expect(admission.reserve("new", "fp2", true)).toMatchObject({
    allowed: false,
    reason: "reconciliation_required",
  });
});
it("bounds local observation of a hung cleanup RPC without reporting remote cleanup", async () => {
  await expect(boundedCleanupRpc(new Promise(() => {}), 5)).rejects.toThrow("cleanup_rpc_timeout");
  await expect(boundedCleanupRpc(Promise.resolve("verified"), 5)).resolves.toBe("verified");
});
it("binds source landing to a cleaned worker, exact actor and one distinct durable operation", () => {
  const f = fixture(), gate = f.create();
  const worker = gate.reserve("worker", "worker-fingerprint", true);
  expect(worker.allowed).toBe(true);
  expect(() => gate.reserveLanding("land:approval", "landing-fingerprint", true,
    { owningRunId: "worker", authorizationId: "approval", actor: "owner" }))
    .toThrow("worker_cleanup_not_verified");
  gate.release("worker", true);
  const landing = gate.reserveLanding("land:approval", "landing-fingerprint", true,
    { owningRunId: "worker", authorizationId: "approval", actor: "owner" });
  expect(landing).toMatchObject({ allowed: true, reservation: { kind: "landing", owningRunId: "worker", actor: "owner" } });
  expect(() => gate.reserveLanding("land:approval", "landing-fingerprint", true,
    { owningRunId: "worker", authorizationId: "approval", actor: "forged" })).toThrow("admission_identity_conflict");
  if (!landing.allowed) throw Error("expected admission");
  expect(() => gate.assertActive("land:approval", "landing-fingerprint", landing.reservation.deadline)).not.toThrow();
  gate.pause();
  expect(() => gate.assertActive("land:approval", "landing-fingerprint", landing.reservation.deadline)).toThrow("publisher_admission_revoked");
  expect(() => gate.release("land:approval", false)).toThrow("cleanup_not_verified");
  expect(gate.active()).toHaveLength(1);
});
