import type { OrchestrationTrace, TraceNode } from "@pitcrew/protocol";

const stageOrder = ["request", "plan", "assign", "prepare", "change", "publish", "test", "explore", "review", "stop", "done", "implement"];

export function orderedSteps(trace: OrchestrationTrace, runId = "") {
  return [...trace.nodes]
    .filter((node) => !runId || !node.runId || node.runId === runId)
    .sort((a, b) => a.sequence - b.sequence || stageOrder.indexOf(a.stage) - stageOrder.indexOf(b.stage));
}

export function replayFrame(trace: OrchestrationTrace, steps: number, runId = "") {
  const ordered = orderedSteps(trace, runId);
  const nodes = ordered.slice(0, Math.max(0, Math.min(steps, ordered.length)));
  const ids = new Set(nodes.map((node) => node.id));
  const exploreVisible = nodes.some((node) => node.stage === "explore");
  return {
    total: ordered.length,
    nodes,
    edges: trace.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to)),
    probes: exploreVisible ? trace.probes.filter((probe) => !runId || probe.runId === runId) : [],
  };
}

export function traceView(trace: OrchestrationTrace, cursor: number, runId = "") {
  const nodes = trace.nodes.filter(
    (node) => node.sequence <= cursor && (!runId || node.runId === runId),
  );
  const ids = new Set(nodes.map((node) => node.id));
  return {
    nodes: [...nodes].sort(
      (a, b) => stageOrder.indexOf(a.stage) - stageOrder.indexOf(b.stage) || a.sequence - b.sequence,
    ),
    edges: trace.edges.filter(
      (edge) => edge.sequence <= cursor && ids.has(edge.from) && ids.has(edge.to),
    ),
    probes: trace.probes.filter((probe) => !runId || probe.runId === runId),
  };
}

export function runChoices(nodes: TraceNode[]) {
  return [...new Set(nodes.map((node) => node.runId).filter((id): id is string => !!id))];
}
