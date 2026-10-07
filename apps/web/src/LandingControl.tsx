import { useEffect, useRef, useState } from "react";
import type { RunEvidence } from "@pitcrew/protocol";
import type { Api, Authorization, LandingResult, Run, Review } from "./api";
import { isLandedReceipt } from "./landing-receipt";
import { landingEvidenceEligible, landingApprovalPending } from "./landing-approval";
export type LandingState = {
  key?: string;
  fingerprint?: string;
  authorization?: Authorization;
  result?: LandingResult;
  busy?: boolean;
  error?: string;
  persistenceError?: boolean;
};
export function LandingControl({
  api,
  run,
  evidence,
  reviews,
  enabled,
  backend,
  state = {},
  onStateChange,
}: {
  api: Api;
  run: Run;
  evidence?: RunEvidence;
  reviews: Review[];
  enabled: boolean;
  backend: Authorization["backend"] | null;
  state?: LandingState;
  onStateChange: (state: LandingState) => void | boolean;
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
    backend,
  ]);
  const eligible = landingEvidenceEligible(run, evidence, reviews);
  const authorization = state.authorization;
  const matches = Boolean(
    authorization &&
    authorization.runId === run.id &&
    authorization.expectedTargetSha === run.baseSha &&
    authorization.candidateSha === run.candidateSha &&
    authorization.configurationRevision === run.configurationRevision &&
    authorization.backend === backend,
  );
  const expired = Boolean(
    authorization && (!Number.isFinite(authorization.expiresAt) || authorization.expiresAt <= now),
  );
  const canonical = isLandedReceipt(run, run.landing, backend);
  const receiptResult = canonical ? run.landing : (state.result ?? run.landing);
  const receiptBound =
    canonical ||
    !state.result ||
    ((!state.fingerprint || state.fingerprint === fingerprint) && (!authorization || matches));
  const landed = receiptBound && isLandedReceipt(run, receiptResult, backend);
  const reportedState = receiptResult?.status ?? authorization?.state;
  // A consumed authorization alone cannot prove that the source was updated.
  const receiptState = reportedState === "landed" && !landed ? "uncertain" : reportedState;
  const fixture = (backend ?? receiptResult?.backend ?? authorization?.backend) === "fixture";
  const prefix = fixture ? "Fixture landing" : "Landing";
  const capability = enabled && ["fixture", "artifacts"].includes(backend ?? "");
  const canApprove = landingApprovalPending(run, evidence, reviews, enabled, backend, state);
  const canLand =
    capability &&
    eligible &&
    matches &&
    !expired &&
    receiptState === "authorized" &&
    !state.busy &&
    !state.persistenceError;
  const validAuthorization = (receipt: Authorization) =>
    Boolean(
      receipt &&
      receipt.backend === backend &&
      typeof receipt.authorizationId === "string" &&
      receipt.authorizationId.trim() &&
      Number.isFinite(receipt.expiresAt) &&
      Number.isFinite(new Date(receipt.expiresAt).getTime()) &&
      ["authorized", "pending", "landed", "rejected", "uncertain"].includes(receipt.state) &&
      receipt.runId === run.id &&
      receipt.expectedTargetSha === run.baseSha &&
      receipt.candidateSha === run.candidateSha &&
      receipt.configurationRevision === run.configurationRevision,
    );
  async function approve() {
    if (!canApprove || lock.current) return;
    lock.current = true;
    const key = state.fingerprint === fingerprint && state.key ? state.key : crypto.randomUUID();
    const next = { key, fingerprint, busy: true };
    try {
      if (onStateChange(next) === false) return;
      const receipt = await api.approve(run.id, {
        expectedTargetSha: run.baseSha,
        candidateSha: run.candidateSha!,
        configurationRevision: run.configurationRevision,
        idempotencyKey: key,
      });
      if (!validAuthorization(receipt)) throw new Error("Receipt mismatch");
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
    try {
      if (onStateChange({ ...state, fingerprint, busy: true, error: undefined }) === false) return;
      let result: LandingResult;
      try {
        result = await (reconcile
          ? api.reconcile(run.id, authorizationId)
          : api.land(run.id, authorizationId));
      } catch (error) {
        if (!reconcile || !matches || !state.key || state.fingerprint !== fingerprint) throw error;
        // A crash after saving but before sending may leave permission unconsumed.
        // Recover the original approval receipt; never issue a new key or land
        // automatically. The server's current state controls the next action.
        const recovered = await api.approve(run.id, {
          expectedTargetSha: run.baseSha,
          candidateSha: run.candidateSha!,
          configurationRevision: run.configurationRevision,
          idempotencyKey: state.key,
        });
        if (!validAuthorization(recovered) || recovered.authorizationId !== authorizationId)
          throw Error("Receipt mismatch");
        onStateChange({
          ...state,
          fingerprint,
          busy: false,
          authorization: recovered,
          result: undefined,
          error: undefined,
          persistenceError: false,
        });
        return;
      }
      if (
        result.backend !== backend ||
        !["landed", "rejected", "uncertain"].includes(result.status) ||
        result.authorizationId !== authorizationId ||
        (result.status === "landed" &&
          (!isLandedReceipt(run, result, backend) || (authorization && !matches)))
      )
        throw new Error("Receipt mismatch");
      onStateChange({ ...state, fingerprint, busy: false, result });
    } catch {
      onStateChange({
        ...state,
        fingerprint,
        busy: false,
        result: {
          authorizationId,
          status: "uncertain",
          backend: backend ?? receiptResult?.backend ?? authorization!.backend,
        },
        error: "Receipt response unavailable.",
      });
    } finally {
      lock.current = false;
    }
  }
  return (
    <div className="merge-control" id={`landing-control-${run.id}`}>
      {landed ? null : !capability ? (
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
      {!landed && (
        <button disabled={!canApprove} onClick={() => void approve()}>
          {state.busy && !authorization
            ? "Requesting approval…"
            : state.key && !authorization
              ? "Retry approval receipt"
              : "Approve exact candidate"}
        </button>
      )}
      {authorization && !landed && (
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
          {expired && !landed && <p role="status">Approval expired. Landing is disabled.</p>}
          <button disabled={!canLand} onClick={() => void land()}>
            {fixture ? "Land fixture simulation" : "Land approved candidate"}
          </button>
        </>
      )}
      {receiptState && receiptState !== "authorized" && (
        <p role="status">
          {landed
            ? fixture
              ? `Fixture simulation landed ${receiptResult!.landedSha}. No real repository merge occurred.`
              : `Source repository landed ${receiptResult!.landedSha}.`
            : receiptState === "rejected"
              ? `${prefix} rejected. Review the evidence before requesting another change.`
              : `${prefix} uncertain or pending. Check the receipt before continuing.`}
        </p>
      )}
      {state.error && <p role="alert">{state.error}</p>}
      {(authorization || receiptResult) &&
        ["pending", "uncertain"].includes(receiptState ?? "") && (
          <button
            disabled={
              state.busy || !capability || (authorization && authorization.runId !== run.id)
            }
            onClick={() => void land(true)}
          >
            Check landing receipt
          </button>
        )}
    </div>
  );
}
