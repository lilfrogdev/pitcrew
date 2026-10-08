import type { ProbeEvidence } from "@pitcrew/protocol";
import type { CommandResult, Workspace } from "../../../packages/execution/src/contracts";

export const defaultProbeSource = `import test from "node:test";
import assert from "node:assert/strict";

test("edge: greet stays a non-empty string when the module exists", async () => {
  try {
    const mod = await import("../src/greet.js");
    if (typeof mod.greet !== "function") return;
    const value = mod.greet();
    assert.equal(typeof value, "string");
    assert.notEqual(value.trim(), "");
  } catch (error) {
    if (error && error.code === "ERR_MODULE_NOT_FOUND") return;
    throw error;
  }
});
`;

export function sanitizeProbeSource(source: string) {
  const text = source.trim();
  if (!text || text.length > 6000) throw Error("invalid_probe");
  if (
    /child_process|worker_threads|process\.binding|node:fs|node:child_process|\beval\s*\(|new Function\(/.test(
      text,
    )
  )
    throw Error("invalid_probe");
  if (!text.includes("node:test") || !text.includes("node:assert")) throw Error("invalid_probe");
  return text;
}

export function blockingProbe(probe: Pick<ProbeEvidence, "exitCode" | "reproducible" | "truncated">) {
  return probe.reproducible && !probe.truncated && probe.exitCode !== 0;
}

export interface ProbeWorkspace {
  duplicate(source: Workspace, target: Workspace): Promise<void>;
  writeFile(workspace: Workspace, path: string, content: string): Promise<void>;
  run(
    workspace: Workspace,
    command: { commandId: string; argv: string[]; timeoutMs: number; maxOutputBytes: number },
  ): Promise<CommandResult>;
  discard(workspace: Workspace): Promise<void>;
}

export async function runDisposableProbe(
  sourceWorkspace: Workspace,
  transport: ProbeWorkspace,
  source = defaultProbeSource,
): Promise<ProbeEvidence> {
  const text = sanitizeProbeSource(source);
  const target: Workspace = {
    ...sourceWorkspace,
    artifactId: `${sourceWorkspace.artifactId}-probe`,
    workerId: `${sourceWorkspace.workerId}-probe`,
  };
  let discarded = false;
  const discard = async () => {
    if (discarded) return;
    discarded = true;
    await transport.discard(target);
  };
  try {
    await transport.duplicate(sourceWorkspace, target);
    await transport.writeFile(target, ".pitcrew-probes/edge.test.mjs", text);
    const command = {
      argv: ["node", "--test", ".pitcrew-probes/edge.test.mjs"],
      timeoutMs: 15000,
      maxOutputBytes: 4096,
    };
    const first = await transport.run(target, { ...command, commandId: "probe-once" });
    const second = await transport.run(target, { ...command, commandId: "probe-twice" });
    const same =
      first.status === second.status &&
      first.exitCode === second.exitCode &&
      first.truncated === second.truncated;
    const probe: ProbeEvidence = {
      id: `${sourceWorkspace.runId}:edge`,
      threadId: "",
      runId: sourceWorkspace.runId,
      purpose: "Check overlooked edge behavior in a disposable checkout",
      command: command.argv,
      candidateSha: sourceWorkspace.baseSha,
      exitCode: first.exitCode,
      stdout: first.stdout,
      stderr: first.stderr,
      truncated: first.truncated || second.truncated,
      reproducible: same,
      blocking: false,
    };
    probe.blocking = blockingProbe(probe);
    return probe;
  } finally {
    await discard();
  }
}
