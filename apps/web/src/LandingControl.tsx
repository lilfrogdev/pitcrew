import { useEffect, useRef, useState } from "react";
import type { RunEvidence } from "@pitcrew/protocol";
import type { Api, Authorization, LandingResult, Run, Review } from "./api";
export type LandingState = {
  key?: string;
  fingerprint?: string;
  authorization?: Authorization;
  result?: LandingResult;
  busy?: boolean;
  error?: string;
};
export function LandingControl({
  api,
  run,
  evidence,
  reviews,
  enabled,
  state = {},
  onStateChange,
}: {
  api: Api;
  run: Run;
  evidence?: RunEvidence;
  reviews: Review[];
  enabled: boolean;
  state?: LandingState;
  onStateChange: (state: LandingState) => void;
}) {
  const lock = useRef(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const fingerprint = JSON.stringify([
    run.id,
    run.baseSha,
    run.candidateSha,
    run.configurationRevision,
  ]);
  const bound = (item: { baseSha: string; candidateSha: string; configurationRevision: string }) =>
    item.baseSha === run.baseSha &&
    item.candidateSha === run.candidateSha &&
    evidence?.run.id === run.id &&
    item.configurationRevision === run.configurationRevision;
  const tests = evidence?.tests;
  const eligible = Boolean(
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
  const authorization = state.authorization;
  const matches = Boolean(
    authorization &&
    authorization.runId === run.id &&
    authorization.expectedTargetSha === run.baseSha &&
    authorization.candidateSha === run.candidateSha &&
    authorization.configurationRevision === run.configurationRevision &&
    authorization.backend === "fixture",
  );
  const expired = Boolean(
    authorization && (!Number.isFinite(authorization.expiresAt) || authorization.expiresAt <= now),
  );
  const receiptResult = state.result ?? run.landing;
  const receiptState = receiptResult?.status ?? authorization?.state;
  const canApprove = enabled && eligible && !state.busy && !authorization && !receiptResult;
  const canLand =
    enabled && eligible && matches && !expired && receiptState === "authorized" && !state.busy;
  async function approve() {
    if (!canApprove || lock.current) return;
    lock.current = true;
    const key = state.fingerprint === fingerprint && state.key ? state.key : crypto.randomUUID();
    const next = { key, fingerprint, busy: true };
    onStateChange(next);
    try {
      const receipt = await api.approve(run.id, {
        expectedTargetSha: run.baseSha,
        candidateSha: run.candidateSha!,
        configurationRevision: run.configurationRevision,
        idempotencyKey: key,
      });
      if (
        receipt.backend !== "fixture" ||
        !receipt.authorizationId ||
        !Number.isFinite(new Date(receipt.expiresAt).getTime()) ||
        !["authorized", "pending", "landed", "rejected", "uncertain"].includes(receipt.state) ||
        receipt.runId !== run.id ||
        receipt.expectedTargetSha !== run.baseSha ||
        receipt.candidateSha !== run.candidateSha ||
        receipt.configurationRevision !== run.configurationRevision
      )
        throw new Error("Receipt mismatch");
      onStateChange({ ...next, busy: false, authorization: receipt });
    } catch {
      onStateChange({
        ...next,
        busy: false,
        error:
          "Approval receipt unavailable. Retry retrieves the same request; landing remains disabled.",
      });
    } finally {
      lock.current = false;
    }
  }
  async function land(reconcile = false) {
    const authorizationId = authorization?.authorizationId ?? receiptResult?.authorizationId;
    if (!authorizationId || lock.current || state.busy || (!reconcile && !canLand)) return;
    lock.current = true;
    onStateChange({ ...state, busy: true, error: undefined });
    try {
      const result = await (reconcile
        ? api.reconcile(run.id, authorizationId)
        : api.land(run.id, authorizationId));
      if (
        result.backend !== "fixture" ||
        !["landed", "rejected", "uncertain"].includes(result.status) ||
        result.authorizationId !== authorizationId ||
        (result.status === "landed" &&
          result.landedSha !== (authorization?.candidateSha ?? run.candidateSha))
      )
        throw new Error("Receipt mismatch");
      onStateChange({ ...state, busy: false, result });
    } catch {
      onStateChange({
        ...state,
        busy: false,
        result: {
          authorizationId,
          status: "uncertain",
          backend: "fixture",
        },
        error:
          "Landing receipt unavailable. Check the receipt to reconcile; no landing will be replayed.",
      });
    } finally {
      lock.current = false;
    }
  }
  return (
    <div className="merge-control">
      {!enabled ? (
        <p>Landing is unavailable.</p>
      ) : !eligible ? (
        <p>
          Requires passing tests and an approving review bound to this run’s exact base, candidate,
          and configuration.
        </p>
      ) : (
        <p>
          Approve candidate <code>{run.candidateSha}</code> against target{" "}
          <code>{run.baseSha}</code> with configuration <code>{run.configurationRevision}</code>.
        </p>
      )}
      <button disabled={!canApprove} onClick={() => void approve()}>
        {state.busy && !authorization
          ? "Requesting approval…"
          : state.key && !authorization
            ? "Retry approval receipt"
            : "Approve exact candidate"}
      </button>
      {authorization && (
        <>
          <p>
            Authorization <code>{authorization.authorizationId}</code> · expires{" "}
            <time dateTime={new Date(authorization.expiresAt).toISOString()}>
              {new Date(authorization.expiresAt).toLocaleTimeString()}
            </time>
          </p>
          {!matches && (
            <p role="alert">Approval is stale. Landing is disabled for the changed candidate.</p>
          )}
          {expired && <p role="status">Approval expired. Landing is disabled.</p>}
          <button disabled={!canLand} onClick={() => void land()}>
            Land fixture simulation
          </button>
        </>
      )}
      {receiptState && receiptState !== "authorized" && (
        <p role="status">
          {receiptState === "landed"
            ? `Fixture simulation landed ${receiptResult?.landedSha ?? authorization?.candidateSha}. No real repository merge occurred.`
            : receiptState === "rejected"
              ? "Fixture landing rejected. Review the evidence before requesting another change."
              : "Fixture landing uncertain or pending. Reconciliation is required; no landing is replayed."}
        </p>
      )}
      {state.error && <p role="alert">{state.error}</p>}
      {(authorization || receiptResult) &&
        ["pending", "uncertain"].includes(receiptState ?? "") && (
          <button disabled={state.busy || !enabled} onClick={() => void land(true)}>
            Check landing receipt
          </button>
        )}
    </div>
  );
}
