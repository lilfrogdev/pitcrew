import { useEffect, useMemo, useState } from "react";
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
import { runChoices, traceView } from "./model";

const empty: OrchestrationTrace = { nodes: [], edges: [], probes: [], sequence: 0 };

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
          if (mode === "live") setCursor(next.sequence || next.nodes.at(-1)?.sequence || 0);
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
  const view = useMemo(() => traceView(trace, cursor || trace.sequence, runId), [trace, cursor, runId]);
  const runs = runChoices(trace.nodes);
  const nodes: Node[] = view.nodes.map((node, index) => ({
    id: node.id,
    position: { x: 40, y: index * 110 },
    data: { label: `${node.title}\n${node.status}` },
    style: {
      width: 220,
      whiteSpace: "pre-wrap",
      border: selected === node.id ? "2px solid #111" : "1px solid #ccc",
      borderRadius: 8,
      padding: 8,
      background: node.status === "failed" ? "#fde8e8" : node.status === "active" ? "#e8f1ff" : "#fff",
    },
    ariaLabel: `${node.title} ${node.status}`,
  }));
  const edges: Edge[] = view.edges.map((edge) => ({
    id: edge.id,
    source: edge.from,
    target: edge.to,
    label: edge.label,
    animated: mode === "live" && view.nodes.some((node) => node.id === edge.to && node.status === "active"),
  }));
  const current = view.nodes.find((node) => node.id === selected) ?? view.nodes.at(-1);
  const max = trace.sequence || trace.nodes.at(-1)?.sequence || 0;
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
            setCursor(max);
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
          <label>
            Replay position
            <input
              aria-label="Replay position"
              type="range"
              min={0}
              max={max}
              value={cursor}
              onChange={(event) => setCursor(Number(event.target.value))}
            />
          </label>
        )}
      </div>
      {view.nodes.length === 0 ? (
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
          <div className="flow-canvas" aria-label="Agent flow">
            <ReactFlow
              nodes={nodes}
              edges={edges}
              fitView
              onNodeClick={(_event, node) => setSelected(node.id)}
              nodesDraggable={false}
              proOptions={{ hideAttribution: true }}
            >
              <Background />
              <Controls showInteractive={false} />
            </ReactFlow>
          </div>
          <FlowDetails node={current} probes={view.probes} />
        </div>
      )}
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
