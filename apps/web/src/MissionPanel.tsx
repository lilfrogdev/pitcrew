import { useEffect, useState } from "react";
import type { Mission, RunEvidence } from "@pitcrew/protocol";
import type { Api } from "./api";

export function MissionPanel({
  api,
  projectId,
  threadId,
  evidence,
  executionEnabled,
}: {
  api: Api;
  projectId: string;
  threadId: string;
  evidence: RunEvidence[];
  executionEnabled: boolean;
}) {
  const [mission, setMission] = useState<Mission | null>(null);
  const [request, setRequest] = useState("");
  const [answer, setAnswer] = useState("");
  const [summary, setSummary] = useState("");
  const [affectedArea, setAffectedArea] = useState("src");
  const [criterion, setCriterion] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setMission(null);
    setError("");
    void api.missions
      .current(threadId)
      .then((next) => {
        if (!cancelled) setMission(next);
      })
      .catch((cause: unknown) => {
        if (!cancelled)
          setError(cause instanceof Error ? cause.message : "Could not load the mission.");
      });
    return () => {
      cancelled = true;
    };
  }, [api, threadId]);
  useEffect(() => {
    if (!mission?.proposal) return;
    setSummary(mission.proposal.summary);
    setAffectedArea(mission.proposal.affectedArea);
    setCriterion(mission.proposal.acceptance.criteria[0]?.text ?? "");
  }, [mission]);
  const run = async (work: () => Promise<Mission | null>) => {
    setBusy(true);
    setError("");
    try {
      setMission(await work());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The mission could not be updated.");
    } finally {
      setBusy(false);
    }
  };
  const linked = evidence.find((item) => item.run.id === mission?.runId);
  return (
    <section className="mission-panel" aria-label="Mission">
      <div className="mission-heading">
        <h2>Mission</h2>
        {mission && (
          <span className={`status ${mission.status}`}>{mission.status.replaceAll("_", " ")}</span>
        )}
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {!mission && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              const created = await api.missions.create(
                projectId,
                threadId,
                request,
                crypto.randomUUID(),
              );
              setRequest("");
              return created;
            });
          }}
        >
          <label htmlFor="mission-request">Describe the feature</label>
          <textarea
            id="mission-request"
            value={request}
            maxLength={8000}
            required
            disabled={busy}
            onChange={(event) => setRequest(event.target.value)}
          />
          <button type="submit" disabled={busy || !request.trim()}>
            Request a plan
          </button>
        </form>
      )}
      {mission?.status === "clarifying" &&
        mission.questions.map((question) => (
          <form
            key={question.id}
            onSubmit={(event) => {
              event.preventDefault();
              void run(() =>
                api.missions.answer(mission.id, question.id, answer, crypto.randomUUID()),
              );
            }}
          >
            <label htmlFor={`mission-${question.id}`}>{question.prompt}</label>
            <textarea
              id={`mission-${question.id}`}
              value={question.answer ?? answer}
              required
              disabled={busy || !!question.answer}
              onChange={(event) => setAnswer(event.target.value)}
            />
            {!question.answer && (
              <button type="submit" disabled={busy || !answer.trim()}>
                Save answer
              </button>
            )}
          </form>
        ))}
      {mission?.proposal && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void run(() =>
              api.missions.revise(
                mission.id,
                { summary, affectedArea, criterion },
                crypto.randomUUID(),
              ),
            );
          }}
        >
          <p>
            Contract <code>{mission.proposal.revision.slice(0, 12)}</code>
          </p>
          <label htmlFor="mission-summary">Summary</label>
          <textarea
            id="mission-summary"
            value={summary}
            disabled={busy || !["proposed", "approved"].includes(mission.status)}
            onChange={(event) => setSummary(event.target.value)}
          />
          <label htmlFor="mission-area">Affected area</label>
          <input
            id="mission-area"
            value={affectedArea}
            disabled={busy || !["proposed", "approved"].includes(mission.status)}
            onChange={(event) => setAffectedArea(event.target.value)}
          />
          <label htmlFor="mission-criterion">Acceptance criterion</label>
          <textarea
            id="mission-criterion"
            value={criterion}
            disabled={busy || !["proposed", "approved"].includes(mission.status)}
            onChange={(event) => setCriterion(event.target.value)}
          />
          <ul>
            {mission.proposal.checks.map((check) => (
              <li key={check.id}>
                {check.id}: {check.kind === "command" ? check.command.argv.join(" ") : check.kind}
              </li>
            ))}
          </ul>
          {["proposed", "approved"].includes(mission.status) && (
            <button type="submit" disabled={busy}>
              Update proposal
            </button>
          )}
        </form>
      )}
      {mission?.status === "proposed" && mission.proposal && (
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void run(() =>
              api.missions.approve(mission.id, mission.proposal!.revision, crypto.randomUUID()),
            )
          }
        >
          Approve this revision
        </button>
      )}
      {mission?.status === "approved" && (
        <>
          {!executionEnabled && <p role="status">Runs are disabled by the server.</p>}
          <button
            type="button"
            disabled={busy || !executionEnabled}
            onClick={() =>
              void run(
                async () => (await api.missions.start(mission.id, crypto.randomUUID())).mission,
              )
            }
          >
            Start implementation
          </button>
        </>
      )}
      {linked && (
        <div className="mission-evidence">
          <p>
            {linked.run.candidateSha
              ? `Candidate ${linked.run.candidateSha}`
              : `Run ${linked.run.status}`}
          </p>
          {linked.tests && (
            <p>
              Tests {linked.tests.status}
              {linked.tests.argv.length ? `: ${linked.tests.argv.join(" ")}` : ""}
            </p>
          )}
          {linked.reviews[0] && (
            <p>
              Review {linked.reviews[0].decision}: {linked.reviews[0].summary}
            </p>
          )}
          {mission?.contract && (
            <p>
              Snapshot <code>{mission.contract.digest.slice(0, 12)}</code>
            </p>
          )}
        </div>
      )}
    </section>
  );
}
