import { useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  Controls,
  ReactFlow,
  type Edge,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { Api } from "../api";
import type { OrchestrationTrace, TraceNode } from "@pitcrew/protocol";
import { replayFrame, runChoices } from "./model";

const empty: OrchestrationTrace = { nodes: [], edges: [], probes: [], sequence: 0 };
const stageCaption: Record<string, string> = {
  request: "Scoped the request",
  plan: "Drafted the plan",
  assign: "Assigned the plan",
  prepare: "Prepared the checkout",
  change: "Implemented the change",
  publish: "Published the candidate",
  test: "Ran the pinned checks",
  explore: "Ran an edge-case probe",
  review: "Reviewed the result",
  stop: "Recorded the result",
  done: "Recorded the result",
};

export function FlowBoard({ api, threadId }: { api: Api; threadId: string }) {
  const [trace, setTrace] = useState<OrchestrationTrace>(empty);
  const [mode, setMode] = useState<"live" | "replay">("live");
  const [cursor, setCursor] = useState(0);
  const [runId, setRunId] = useState("");
  const [selected, setSelected] = useState<string>("");
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      void api
        .trace(threadId, 0)
        .then((next) => {
          if (cancelled) return;
          setTrace(next);
        })
        .catch(() => undefined);
    };
    load();
    const timer = window.setInterval(load, mode === "live" ? 1200 : 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [api, threadId, mode]);
  const view = useMemo(
    () => replayFrame(trace, mode === "live" ? Number.POSITIVE_INFINITY : cursor, runId),
    [trace, cursor, runId, mode],
  );
  const runs = runChoices(trace.nodes);
  const nodes: Node[] = view.nodes.map((node, index) => ({
    id: node.id,
    position: { x: 48, y: index * 128 },
    data: { label: `${node.title}\n${stageCaption[node.stage] ?? node.stage}\n${node.status}` },
    style: {
      width: 280,
      whiteSpace: "pre-wrap",
      fontSize: 14,
      lineHeight: 1.35,
      border: selected === node.id ? "2px solid #111" : "1px solid #ccc",
      borderRadius: 10,
      padding: 12,
      background: node.status === "failed" ? "#fde8e8" : node.status === "active" ? "#e8f1ff" : "#fff",
    },
    ariaLabel: `${node.title} ${node.status}`,
  }));
  const edges: Edge[] = view.edges.map((edge) => ({
    id: edge.id,
    source: edge.from,
    target: edge.to,
    label: edge.label === "Approved" || edge.label === "Draft plan" ? edge.label : undefined,
    animated: mode === "live" && view.nodes.some((node) => node.id === edge.to && node.status === "active"),
  }));
  const current = view.nodes.find((node) => node.id === selected);
  const stepLabel = view.nodes.at(-1);
  return (
    <div className="flow-board">
      <div className="flow-toolbar">
        <button type="button" aria-pressed={mode === "live"} onClick={() => setMode("live")}>
          Live
        </button>
        <button
          type="button"
          aria-pressed={mode === "replay"}
          onClick={() => {
            setMode("replay");
            setCursor(0);
            setSelected("");
          }}
        >
          Replay
        </button>
        {runs.length > 0 && (
          <label>
            Run
            <select value={runId} onChange={(event) => setRunId(event.target.value)}>
              <option value="">All attempts</option>
              {runs.map((id) => (
                <option key={id} value={id}>
                  {id.slice(0, 8)}
                </option>
              ))}
            </select>
          </label>
        )}
        {mode === "replay" && (
          <ReplayScrubber
            total={view.total}
            value={Math.min(cursor, view.total)}
            label={stepLabel?.title ?? ""}
            onChange={(step) => {
              setCursor((current) => (current === step ? current : step));
              setSelected("");
            }}
          />
        )}
      </div>
      {trace.nodes.length === 0 ? (
        <div className="workspace-empty">
          <h2>Flow</h2>
          <p>Agent handoffs appear here as the crew works, and stay available to replay.</p>
        </div>
      ) : typeof ResizeObserver === "undefined" ? (
        <ol aria-label="Agent flow">
          {view.nodes.map((node) => (
            <li key={node.id}>
              <button type="button" onClick={() => setSelected(node.id)}>
                {node.title} {node.status}
              </button>
            </li>
          ))}
          <FlowDetails node={current} probes={view.probes} />
        </ol>
      ) : (
        <div className="flow-layout">
          <div
            className="flow-canvas"
            aria-label="Agent flow"
            style={{ height: Math.max(520, view.total * 128 + 80) }}
          >
            {view.nodes.length === 0 && (
              <p className="flow-replay-empty">Move replay position to reveal each handoff.</p>
            )}
            <ReactFlow
              nodes={nodes}
              edges={edges}
              minZoom={0.6}
              maxZoom={1.5}
              defaultViewport={{ x: 16, y: 12, zoom: 1 }}
              onNodeClick={(_event, node) => setSelected(node.id)}
              nodesDraggable={false}
              nodesConnectable={false}
              proOptions={{ hideAttribution: true }}
            >
              <Background />
              <Controls showInteractive={false} position="top-right" />
            </ReactFlow>
          </div>
          {current && <FlowDetails node={current} probes={view.probes} />}
        </div>
      )}
    </div>
  );
}

function ReplayScrubber({
  total,
  value,
  label,
  onChange,
}: {
  total: number;
  value: number;
  label: string;
  onChange: (step: number) => void;
}) {
  const track = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const choose = (clientX: number) => {
    const rect = track.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    onChange(Math.round(ratio * total));
  };
  useEffect(() => {
    const element = track.current;
    if (!element) return;
    const ignoreScroll = (event: WheelEvent) => event.preventDefault();
    element.addEventListener("wheel", ignoreScroll, { passive: false });
    return () => element.removeEventListener("wheel", ignoreScroll);
  }, []);
  return (
    <div className="replay-scrubber">
      <div className="replay-controls">
        <span id="replay-position-label">Replay position</span>
        <button type="button" aria-label="Previous handoff" onClick={() => onChange(Math.max(0, value - 1))}>
          −
        </button>
        <button type="button" aria-label="Next handoff" onClick={() => onChange(Math.min(total, value + 1))}>
          +
        </button>
        <span className="replay-readout">
          {value} of {total}
          {label ? ` · ${label}` : ""}
        </span>
      </div>
      <div
        ref={track}
        className="replay-track"
        role="slider"
        aria-labelledby="replay-position-label"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={value}
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === "ArrowRight" || event.key === "ArrowUp")
            onChange(Math.min(total, value + 1));
          if (event.key === "ArrowLeft" || event.key === "ArrowDown")
            onChange(Math.max(0, value - 1));
        }}
        onPointerDown={(event) => {
          dragging.current = true;
          event.currentTarget.setPointerCapture(event.pointerId);
          choose(event.clientX);
        }}
        onPointerMove={(event) => {
          if (dragging.current) choose(event.clientX);
        }}
        onPointerUp={() => {
          dragging.current = false;
        }}
        onPointerCancel={() => {
          dragging.current = false;
        }}
      >
        <div className="replay-fill" style={{ width: `${total ? (value / total) * 100 : 0}%` }} />
      </div>
    </div>
  );
}

function FlowDetails({
  node,
  probes,
}: {
  node?: TraceNode;
  probes: OrchestrationTrace["probes"];
}) {
  if (!node) return null;
  const related = node.stage === "explore" ? probes : [];
  return (
    <aside className="flow-details" aria-label="Flow details">
      <p className="eyebrow">{node.title}</p>
      <p>{node.status}</p>
      <p>{node.summary}</p>
      {node.revision && <p>Revision {node.revision.slice(0, 12)}</p>}
      {node.candidateSha && <p>Candidate {node.candidateSha.slice(0, 12)}</p>}
      {related.map((probe) => (
        <section key={probe.id}>
          <h3>{probe.blocking ? "Blocking probe" : "Advisory probe"}</h3>
          <p>{probe.purpose}</p>
          <p>
            Exit {probe.exitCode ?? "none"} · {probe.reproducible ? "reproducible" : "not reproducible"}
          </p>
          {probe.stdout && <pre>{probe.stdout.slice(0, 1200)}</pre>}
        </section>
      ))}
    </aside>
  );
}
