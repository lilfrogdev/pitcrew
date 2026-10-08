import type { OrchestrationTrace, TraceNode } from "@pitcrew/protocol";

const stageOrder = ["request", "plan", "assign", "prepare", "change", "publish", "test", "explore", "review", "stop", "done", "implement"];

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
