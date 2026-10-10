import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import type { CrewRole, TraceNode, TraceStatus } from "@pitcrew/protocol";
import { actionLabel, statusLabel } from "./model";

export type CrewFlowNode = Node<
  {
    trace: TraceNode;
    selected: boolean;
  },
  "crew"
>;

const roleMark: Record<CrewRole, string> = {
  repository: "R",
  planner: "P",
  coordinator: "C",
  implementer: "I",
  test_runner: "T",
  test_agent: "E",
  reviewer: "V",
};

function chipClass(status: TraceStatus) {
  if (status === "active" || status === "waiting") return "flow-status is-active";
  if (status === "passed") return "flow-status is-passed";
  if (status === "failed" || status === "stopped") return "flow-status is-failed";
  return "flow-status is-muted";
}

export function CrewNode({ data }: NodeProps<CrewFlowNode>) {
  const { trace, selected } = data;
  const live = trace.status === "active" || trace.status === "waiting";
  return (
    <div
      className={`crew-flow-node role-${trace.role}${selected ? " is-selected" : ""}${live ? " is-live" : ""}`}
      data-status={trace.status}
    >
      <Handle type="target" position={Position.Top} />
      <div className="crew-flow-head">
        <span className="crew-flow-mark" aria-hidden="true">
          {roleMark[trace.role]}
        </span>
        <span className="crew-flow-role">{trace.title}</span>
      </div>
      <p className="crew-flow-action">{actionLabel(trace)}</p>
      <span className={chipClass(trace.status)}>
        {live && <span className="flow-status-pulse" aria-hidden="true" />}
        {statusLabel(trace.status, trace.role)}
      </span>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}
