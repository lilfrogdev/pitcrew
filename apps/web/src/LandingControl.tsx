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
  const landed = receiptResult?.status === "landed";
  const uncertain = Boolean(receiptResult && ["pending", "uncertain"].includes(receiptResult.status));
  const stale = Boolean(authorization && !matches);
  const canAccept = enabled && eligible && !state.busy && !landed && !stale;
  async function accept() {
    if (!canAccept || lock.current) return;
    lock.current = true;
    const key =
      !authorization && state.fingerprint === fingerprint && state.key
        ? state.key
        : crypto.randomUUID();
    const next = { ...state, key, fingerprint, busy: true, error: undefined };
    onStateChange(next);
    let knownId = authorization?.authorizationId ?? receiptResult?.authorizationId;
    let accepted = authorization;
    try {
      if (uncertain && knownId) {
        const result = await api.reconcile(run.id, knownId);
        if (
          result.backend !== "fixture" ||
          result.authorizationId !== knownId ||
          !["landed", "rejected", "uncertain"].includes(result.status)
        )
          throw new Error("Receipt mismatch");
        onStateChange({ ...next, busy: false, result });
        return;
      }
      const receipt =
        authorization && matches && !expired
          ? authorization
          : await api.approve(run.id, {
              expectedTargetSha: run.baseSha,
              candidateSha: run.candidateSha!,
              configurationRevision: run.configurationRevision,
              idempotencyKey: key,
            });
      if (
        receipt.backend !== "fixture" ||
        !receipt.authorizationId ||
        !Number.isFinite(new Date(receipt.expiresAt).getTime()) ||
        receipt.expiresAt <= Date.now() ||
        receipt.runId !== run.id ||
        receipt.expectedTargetSha !== run.baseSha ||
        receipt.candidateSha !== run.candidateSha ||
        receipt.configurationRevision !== run.configurationRevision
      )
        throw new Error("Receipt mismatch");
      knownId = receipt.authorizationId;
      accepted = receipt;
      const result = await api.land(run.id, receipt.authorizationId);
      if (
        result.backend !== "fixture" ||
        !["landed", "rejected", "uncertain"].includes(result.status) ||
        result.authorizationId !== receipt.authorizationId ||
        (result.status === "landed" && result.landedSha !== run.candidateSha)
      )
        throw new Error("Receipt mismatch");
      onStateChange({ ...next, busy: false, authorization: receipt, result });
    } catch {
      if (knownId) {
        onStateChange({
          ...next,
          busy: false,
          authorization: accepted,
          result: { authorizationId: knownId, status: "uncertain", backend: "fixture" },
          error:
            "The landing reply was lost. Retry checks this same candidate and does not land it again.",
        });
      } else {
        onStateChange({
          ...next,
          busy: false,
          error: "This candidate could not be accepted. Retry uses the same request.",
        });
      }
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
          Accept candidate <code>{run.candidateSha}</code> as the new baseline in place of{" "}
          <code>{run.baseSha}</code>.
        </p>
      )}
      {stale && (
        <p role="alert">This candidate no longer matches the baseline. Acceptance is refused.</p>
      )}
      {authorization && expired && matches && (
        <p role="status">The previous acceptance expired. Accept this candidate again.</p>
      )}
      <button disabled={!canAccept} onClick={() => void accept()}>
        {state.busy
          ? "Accepting candidate…"
          : uncertain
            ? "Check whether it landed"
            : state.key && !authorization
              ? "Retry accepting this candidate"
              : landed
                ? "Candidate accepted"
                : "Accept this candidate"}
      </button>
      {receiptState && receiptState !== "authorized" && (
        <p role="status">
          {receiptState === "landed"
            ? `Candidate accepted. The local baseline is now ${receiptResult?.landedSha ?? authorization?.candidateSha}. No real repository merge occurred.`
            : receiptState === "rejected"
              ? "This candidate was rejected. Review the evidence before requesting another change."
              : "The landing result is uncertain. Retry checks this same candidate and does not land it again."}
        </p>
      )}
      {state.error && <p role="alert">{state.error}</p>}
    </div>
  );
}
