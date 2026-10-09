import type { CrewRole, OrchestrationTrace, TraceNode, TraceStatus } from "@pitcrew/protocol";

const stageOrder = [
  "request",
  "plan",
  "assign",
  "prepare",
  "change",
  "publish",
  "test",
  "explore",
  "review",
  "stop",
  "done",
  "implement",
];

export const stageAction: Record<string, { active: string; done: string }> = {
  request: { active: "Scoping the request", done: "Scoped the request" },
  plan: { active: "Drafting the plan", done: "Drafted the plan" },
  assign: { active: "Assigning the plan", done: "Assigned the plan" },
  prepare: { active: "Preparing the checkout", done: "Prepared the checkout" },
  change: { active: "Implementing the change", done: "Implemented the change" },
  publish: { active: "Publishing the candidate", done: "Published the candidate" },
  test: { active: "Running the pinned checks", done: "Ran the pinned checks" },
  explore: { active: "Running an edge-case probe", done: "Ran an edge-case probe" },
  review: { active: "Reviewing the result", done: "Reviewed the result" },
  stop: { active: "Recording the result", done: "Recorded the result" },
  done: { active: "Recording the result", done: "Recorded the result" },
};

export function actionLabel(node: TraceNode) {
  const copy = stageAction[node.stage];
  if (!copy) return node.stage;
  return node.status === "active" || node.status === "waiting" ? copy.active : copy.done;
}

export function statusLabel(status: TraceStatus, role?: CrewRole) {
  switch (status) {
    case "active":
      return role === "test_runner" || role === "coordinator" ? "Active" : "Thinking";
    case "waiting":
      return "Waiting";
    case "passed":
      return "Passed";
    case "failed":
      return "Failed";
    case "skipped":
      return "Skipped";
    case "stopped":
      return "Stopped";
  }
}

export function orderedSteps(trace: OrchestrationTrace, runId = "") {
  const source = trace.steps?.length ? trace.steps : trace.nodes;
  return [...source]
    .filter((node) => !runId || node.runId === runId)
    .sort(
      (a, b) => a.sequence - b.sequence || stageOrder.indexOf(a.stage) - stageOrder.indexOf(b.stage),
    );
}

export function replayFrame(trace: OrchestrationTrace, steps: number, runId = "") {
  const ordered = orderedSteps(trace, runId);
  const slice = ordered.slice(0, Math.max(0, Math.min(steps, ordered.length)));
  const folded = new Map<string, TraceNode>();
  for (const step of slice) folded.set(step.id, step);
  const nodes = [...folded.values()].sort(
    (a, b) => stageOrder.indexOf(a.stage) - stageOrder.indexOf(b.stage) || a.sequence - b.sequence,
  );
  const ids = new Set(nodes.map((node) => node.id));
  const maxSequence = slice.at(-1)?.sequence ?? 0;
  const exploreVisible = nodes.some((node) => node.stage === "explore");
  return {
    total: ordered.length,
    nodes,
    edges: trace.edges.filter(
      (edge) =>
        (!runId || edge.runId === runId) &&
        edge.sequence <= maxSequence &&
        ids.has(edge.from) &&
        ids.has(edge.to),
    ),
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
