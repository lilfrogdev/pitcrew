import { useEffect, useRef, useState } from "react";
import { ApiError, type Api, type ConversationTurn } from "./api";

export function AgentTurnControls({
  threadId,
  turns,
  stopTurn,
  onAccessLost,
}: {
  threadId: string;
  turns: ConversationTurn[];
  stopTurn: NonNullable<Api["stopTurn"]>;
  onAccessLost: () => void;
}) {
  return turns.map((turn) =>
    turn.status === "failed" && turn.error === "conversation_cancelled" ? (
      <p key={turn.id} role="status">
        Agent reply stopped.
      </p>
    ) : turn.canStop === true && ["queued", "running"].includes(turn.status) ? (
      <StopTurn
        key={turn.id}
        threadId={threadId}
        turn={turn}
        stopTurn={stopTurn}
        onAccessLost={onAccessLost}
      />
    ) : null,
  );
}

function StopTurn({
  threadId,
  turn,
  stopTurn,
  onAccessLost,
}: {
  threadId: string;
  turn: ConversationTurn;
  stopTurn: NonNullable<Api["stopTurn"]>;
  onAccessLost: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const [result, setResult] = useState<ConversationTurn>();
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  async function stop() {
    if (inFlight.current || result) return;
    inFlight.current = true;
    setPending(true);
    setError(false);
    try {
      const stopped = await stopTurn(threadId, turn.id);
      if (mounted.current) setResult(stopped);
    } catch (cause) {
      if (!mounted.current) return;
      if (cause instanceof ApiError && [401, 403, 404].includes(cause.status)) {
        onAccessLost();
      } else {
        setError(true);
      }
    } finally {
      inFlight.current = false;
      if (mounted.current) setPending(false);
    }
  }

  if (result)
    return (
      <p role="status">
        {result.error === "conversation_cancelled"
          ? "Agent reply stopped."
          : result.status === "completed"
            ? "Agent reply already finished."
            : "Agent reply already ended."}
      </p>
    );
  return (
    <div>
      <span role="status">
        {pending
          ? "Stopping agent reply…"
          : turn.status === "queued"
            ? "Agent reply queued."
            : "Agent is replying."}
      </span>{" "}
      <button type="button" onClick={() => void stop()} disabled={pending}>
        Stop agent reply
      </button>
      {error && (
        <p className="composer-error" role="alert">
          Could not confirm whether the agent reply stopped. Retry Stop or wait for its status.
        </p>
      )}
    </div>
  );
}
