import { expect, it } from "vite-plus/test";
import { actionLabel, replayFrame, statusLabel } from "./model";
import type { OrchestrationTrace } from "@pitcrew/protocol";

const trace: OrchestrationTrace = {
  sequence: 4,
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
      sequence: 2,
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
      sequence: 4,
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
      sequence: 5,
      createdAt: "now",
      updatedAt: "now",
    },
  ],
  steps: [
    {
      id: "request",
      threadId: "t",
      role: "repository",
      stage: "request",
      status: "active",
      title: "Repository agent",
      summary: "scoping",
      sequence: 1,
      createdAt: "now",
      updatedAt: "now",
    },
    {
      id: "request",
      threadId: "t",
      role: "repository",
      stage: "request",
      status: "passed",
      title: "Repository agent",
      summary: "scoped",
      sequence: 2,
      createdAt: "now",
      updatedAt: "now",
    },
    {
      id: "plan",
      threadId: "t",
      role: "planner",
      stage: "plan",
      status: "active",
      title: "Planner",
      summary: "drafting",
      sequence: 3,
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
      sequence: 4,
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
      sequence: 5,
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
      sequence: 3,
      createdAt: "now",
    },
    {
      id: "plan->implement",
      threadId: "t",
      from: "plan",
      to: "implement",
      label: "Approved",
      sequence: 5,
      createdAt: "now",
    },
  ],
};

it("replays thinking and completion as separate steps for the same stage", () => {
  expect(replayFrame(trace, 0).nodes).toEqual([]);
  expect(replayFrame(trace, 1).nodes.map((node) => node.status)).toEqual(["active"]);
  expect(actionLabel(replayFrame(trace, 1).nodes[0]!)).toBe("Scoping the request");
  expect(statusLabel(replayFrame(trace, 1).nodes[0]!.status)).toBe("Thinking");
  expect(replayFrame(trace, 2).nodes.map((node) => node.status)).toEqual(["passed"]);
  expect(replayFrame(trace, 3).nodes.map((node) => `${node.id}:${node.status}`)).toEqual([
    "request:passed",
    "plan:active",
  ]);
  expect(replayFrame(trace, 3).edges.map((edge) => edge.label)).toEqual(["Draft plan"]);
  expect(replayFrame(trace, 5).nodes.map((node) => node.id)).toEqual([
    "request",
    "plan",
    "implement",
  ]);
  expect(replayFrame(trace, 5, "run-2").nodes.map((node) => node.role)).toEqual(["implementer"]);
});
