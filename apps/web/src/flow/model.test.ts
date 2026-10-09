import { expect, it } from "vite-plus/test";
import { replayFrame, traceView } from "./model";
import type { OrchestrationTrace } from "@pitcrew/protocol";

const trace: OrchestrationTrace = {
  sequence: 3,
  probes: [],
  nodes: [
    {
      id: "request",
      threadId: "t",
      role: "repository",
      stage: "request",
      status: "passed",
      title: "Repository agent",
      summary: "scoped",
      sequence: 1,
      createdAt: "now",
      updatedAt: "now",
    },
    {
      id: "plan",
      threadId: "t",
      role: "planner",
      stage: "plan",
      status: "passed",
      title: "Planner",
      summary: "drafted",
      sequence: 2,
      createdAt: "now",
      updatedAt: "now",
    },
    {
      id: "implement",
      threadId: "t",
      runId: "run-2",
      role: "implementer",
      stage: "change",
      status: "active",
      title: "Change worker",
      summary: "editing",
      sequence: 3,
      createdAt: "now",
      updatedAt: "now",
    },
  ],
  edges: [
    {
      id: "request->plan",
      threadId: "t",
      from: "request",
      to: "plan",
      label: "Draft plan",
      sequence: 2,
      createdAt: "now",
    },
    {
      id: "plan->implement",
      threadId: "t",
      from: "plan",
      to: "implement",
      label: "Approved",
      sequence: 3,
      createdAt: "now",
    },
  ],
};

it("replays the crew graph up to the selected handoff and can isolate a run", () => {
  expect(traceView(trace, 2).nodes.map((node) => node.id)).toEqual(["request", "plan"]);
  expect(traceView(trace, 2).edges.map((edge) => edge.label)).toEqual(["Draft plan"]);
  expect(traceView(trace, 3, "run-2").nodes.map((node) => node.role)).toEqual(["implementer"]);
  expect(replayFrame(trace, 0).nodes).toEqual([]);
  expect(replayFrame(trace, 1).nodes.map((node) => node.id)).toEqual(["request"]);
  expect(replayFrame(trace, 2).edges.map((edge) => edge.label)).toEqual(["Draft plan"]);
  expect(replayFrame(trace, 3).nodes.map((node) => node.id)).toEqual(["request", "plan", "implement"]);
});
