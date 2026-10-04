import { expect, it } from "vite-plus/test";
import { DurableChangePipeline, type PipelineState, type PipelinePorts } from "./durable-pipeline";
import { ExecutionError } from "../../../packages/execution/src/contracts";
const base = "a".repeat(40),
  candidate = "b".repeat(40);
const input = {
  runId: "r",
  threadId: "t",
  projectId: "p",
  repository: "artifact",
  baseSha: base,
  configurationRevision: "1",
  messages: [],
};
function fixture() {
  let saved: PipelineState | undefined;
  const calls: string[] = [];
  let failWrite = false;
  const operations = new Map<string, unknown>();
  const once = async <T>(key: string, operation: () => T): Promise<T> => {
    if (operations.has(key)) return operations.get(key) as T;
    calls.push(key);
    const value = operation();
    operations.set(key, value);
    return value;
  };
  const store = {
    read: () => (saved ? structuredClone(saved) : undefined),
    write: (state: PipelineState) => {
      if (failWrite) {
        failWrite = false;
        throw Error("lost_stage_ack");
      }
      saved = structuredClone(state);
    },
  };
  const ports: PipelinePorts = {
    prepare: () => once("prepare", () => ({ ...input, workerId: "worker", artifactId: "fork" })),
    change: () => once("pi-receipt", () => ({ candidateSha: candidate, summary: "fixture" })),
    publish: () => once("publish", () => undefined),
    test: () =>
      once("test", () => ({
        runId: "r",
        commandId: "test",
        baseSha: base,
        candidateSha: candidate,
        configurationRevision: "1",
        argv: ["fake"],
        status: "completed",
        exitCode: 0,
        stdout: "passed",
        stderr: "",
        truncated: false,
      })),
    review: () =>
      once("review-receipt", () => ({
        baseSha: base,
        candidateSha: candidate,
        configurationRevision: "1",
        decision: "approve",
        actor: "reviewer",
        summary: "checked",
      })),
    stop: async () => {
      calls.push("stop");
    },
  };
  return { store, ports, calls, dropAck: () => (failWrite = true) };
}
it("recreates pipeline after every persisted stage and completes exact attributed evidence", async () => {
  const f = fixture();
  new DurableChangePipeline(f.store).start(input);
  for (let i = 0; i < 6; i++) await new DurableChangePipeline(f.store).advance(f.ports);
  expect(f.store.read()).toMatchObject({
    stage: "done",
    result: {
      candidateSha: candidate,
      tests: { status: "passed" },
      review: { candidateSha: candidate },
    },
  });
  expect(f.calls).toEqual(["prepare", "pi-receipt", "publish", "test", "review-receipt", "stop"]);
});
it("recovers lost publication stage acknowledgement without repeating native publish", async () => {
  const f = fixture(),
    runner = new DurableChangePipeline(f.store);
  runner.start(input);
  await runner.advance(f.ports);
  await runner.advance(f.ports);
  f.dropAck();
  await expect(runner.advance(f.ports)).rejects.toThrow("lost_stage_ack");
  expect(f.store.read()!.stage).toBe("publish");
  await new DurableChangePipeline(f.store).advance(f.ports);
  expect(f.store.read()!.stage).toBe("test");
  expect(f.calls.filter((c) => c === "publish")).toHaveLength(1);
});
it("waits on durable model/review receipts without advancing native mutations", async () => {
  const f = fixture(),
    runner = new DurableChangePipeline(f.store);
  runner.start(input);
  await runner.advance(f.ports);
  await runner.advance({ ...f.ports, change: async () => undefined });
  expect(f.store.read()!.stage).toBe("change");
  expect(f.calls).toEqual(["prepare"]);
});
it("quarantines uncertain native preparation and never replays it", async () => {
  const f = fixture(),
    runner = new DurableChangePipeline(f.store);
  runner.start(input);
  let calls = 0;
  const ports = {
    ...f.ports,
    prepare: async () => {
      calls++;
      throw new ExecutionError("UNCERTAIN_OPERATION");
    },
  };
  await runner.advance(ports);
  await new DurableChangePipeline(f.store).advance(ports);
  expect(f.store.read()).toMatchObject({ stage: "blocked", error: "reconciliation_required" });
  expect(calls).toBe(1);
});
it("rejects stale reviewer evidence and bounds total pipeline lifetime", async () => {
  const f = fixture(),
    runner = new DurableChangePipeline(f.store);
  runner.start(input);
  for (let i = 0; i < 4; i++) await runner.advance(f.ports);
  await runner.advance({
    ...f.ports,
    review: async () => ({
      ...(await f.ports.review(f.store.read()!.workspace!, f.store.read()!.evidence!))!,
      candidateSha: base,
    }),
  });
  expect(f.store.read()!.stage).toBe("blocked");
  const g = fixture();
  new DurableChangePipeline(g.store, () => 0).start(input);
  await new DurableChangePipeline(g.store, () => 31 * 60 * 1000).advance(g.ports);
  expect(g.store.read()!.error).toBe("deadline_exceeded");
  expect(g.calls).toHaveLength(0);
});
it("binds idempotency to the exact configuration and original work brief", () => {
  const f = fixture(),
    runner = new DurableChangePipeline(f.store);
  runner.start(input);
  expect(() => runner.start({ ...input, configurationRevision: "2" })).toThrow(
    "idempotency_conflict",
  );
});
