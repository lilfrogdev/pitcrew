import { useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  Controls,
  MarkerType,
  ReactFlow,
  type Edge,
  type NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { Api } from "../api";
import type { OrchestrationTrace, TraceNode } from "@pitcrew/protocol";
import { CrewNode, type CrewFlowNode } from "./CrewNode";
import { actionLabel, replayFrame, runChoices, statusLabel } from "./model";

const empty: OrchestrationTrace = { nodes: [], edges: [], steps: [], probes: [], sequence: 0 };
const nodeTypes = { crew: CrewNode } satisfies NodeTypes;

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
          setTrace({ ...next, steps: next.steps ?? [] });
        })
        .catch(() => undefined);
    };
    load();
    const timer = window.setInterval(load, mode === "live" ? 900 : 5000);
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
  const nodes: CrewFlowNode[] = view.nodes.map((node, index) => ({
    id: node.id,
    type: "crew",
    position: { x: 72, y: index * 148 },
    data: { trace: node, selected: selected === node.id },
    ariaLabel: `${node.title} ${actionLabel(node)} ${statusLabel(node.status, node.role)}`,
  }));
  const edges: Edge[] = view.edges.map((edge) => {
    const target = view.nodes.find((node) => node.id === edge.to);
    const sending = !!target && (target.status === "active" || target.status === "waiting");
    return {
      id: edge.id,
      source: edge.from,
      target: edge.to,
      label: sending ? `Sending to ${target.title}` : edge.label,
      animated: sending && mode === "live",
      markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: "#9aa1ab" },
      style: { stroke: sending ? "#5b6573" : "#c6cad1", strokeWidth: sending ? 2 : 1.5 },
      labelStyle: { fill: "#626772", fontSize: 11, fontWeight: 600 },
      labelBgStyle: { fill: "#f7f7f8", fillOpacity: 0.95 },
      labelBgPadding: [6, 4] as [number, number],
      labelBgBorderRadius: 4,
    };
  });
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
            label={
              stepLabel ? `${stepLabel.title} · ${statusLabel(stepLabel.status, stepLabel.role)}` : ""
            }
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
                {node.title} · {actionLabel(node)} · {statusLabel(node.status, node.role)}
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
            style={{ height: Math.max(520, view.nodes.length * 148 + 96) }}
          >
            {view.nodes.length === 0 && (
              <p className="flow-replay-empty">Move replay position to reveal each handoff.</p>
            )}
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              minZoom={0.55}
              maxZoom={1.5}
              defaultViewport={{ x: 24, y: 16, zoom: 1 }}
              onNodeClick={(_event, node) => setSelected(node.id)}
              nodesDraggable={false}
              nodesConnectable={false}
              proOptions={{ hideAttribution: true }}
            >
              <Background gap={22} size={1.2} color="#d7dae0" />
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
      <p className="flow-details-action">{actionLabel(node)}</p>
      <p className={`flow-details-status status-${node.status}`}>
        {statusLabel(node.status, node.role)}
      </p>
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
