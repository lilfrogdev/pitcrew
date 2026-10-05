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
it("parks failed cleanup after twelve attempts without replaying paid work", async () => {
  const f = fixture(),
    runner = new DurableChangePipeline(f.store);
  runner.start(input);
  await runner.advance(f.ports);
  runner.requestStop(input.runId);
  let stops = 0;
  const ports = {
    ...f.ports,
    stop: async () => {
      stops++;
      throw Error("unavailable");
    },
  };
  for (let i = 0; i < 20; i++) await new DurableChangePipeline(f.store).advance(ports);
  expect(stops).toBe(12);
  expect(f.store.read()).toMatchObject({
    stage: "blocked",
    cleanupPending: true,
    cleanupParked: true,
    error: "reconciliation_required",
  });
  expect(f.calls).toEqual(["prepare"]);
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
it("persists verification failures without turning an independent approval into a passing check", async () => {
  const { pinPlan, executePlan } = await import("../../../packages/verification/src/index.ts");
  const initial = await pinPlan({
    projectId: "p",
    changeId: "c",
    baseSha: base,
    candidateSha: base,
    configurationRevision: "1",
    profile: {
      projectId: "p",
      revision: "v1",
      checks: [
        {
          id: "behavior",
          kind: "command",
          command: { argv: ["fixture"], timeoutMs: 1000, maxOutputBytes: 1024 },
        },
      ],
    },
    acceptance: {
      revision: "a1",
      criteria: [{ id: "accept", text: "Behavior works", checkIds: ["behavior"] }],
    },
    reproduceBaseline: false,
  });
  const f = fixture();
  f.ports.verify = async (workspace) => {
    const { fingerprint: _fingerprint, ...spec } = initial;
    const plan = await pinPlan({ ...spec, candidateSha: candidate });
    return {
      plan,
      outcomes: await executePlan(plan, "candidate", workspace, {
        inspect: async () => ({ sha: candidate, clean: true }),
        run: async () => ({
          status: "completed",
          exitCode: 1,
          stdout: "",
          stderr: "assertion failed",
          truncated: false,
        }),
      }),
    };
  };
  const runner = new DurableChangePipeline(f.store);
  runner.start({ ...input, changeId: "c", verificationPlan: initial });
  for (let i = 0; i < 6; i++) await runner.advance(f.ports);
  expect(f.store.read()!.result!.verification!.outcomes[0].status).toBe("failed");
  expect(f.store.read()!.result!.review!.decision).toBe("request_changes");
  expect(
    (await f.ports.review(f.store.read()!.workspace!, f.store.read()!.evidence!))!.decision,
  ).toBe("approve");
});

it("persists cleanup intent before a failed stop and retries only cleanup across restart", async () => {
  const f = fixture();
  const runner = new DurableChangePipeline(f.store);
  runner.start(input);
  await runner.advance(f.ports);
  let stops = 0;
  const ports = {
    ...f.ports,
    change: async () => {
      throw Error("failed");
    },
    stop: async () => {
      expect(f.store.read()).toMatchObject({ stage: "blocked", cleanupPending: true });
      if (++stops === 1) throw Error("stop failed");
    },
  };
  await runner.advance(ports);
  expect(f.store.read()!.cleanupPending).toBe(true);
  await new DurableChangePipeline(f.store).advance(ports);
  await new DurableChangePipeline(f.store).advance(ports);
  expect(stops).toBe(2);
  expect(f.store.read()!.cleanupPending).toBe(false);
  expect(f.calls).toEqual(["prepare"]);
});
it("Stop during prepare retains the late workspace for cleanup and never advances it", async () => {
  const f = fixture();
  const runner = new DurableChangePipeline(f.store);
  runner.start(input);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = runner.advance({
    ...f.ports,
    prepare: async () => {
      await gate;
      return f.ports.prepare(input);
    },
  });
  runner.requestStop(input.runId);
  expect(f.store.read()!.stopRequested).toBe(true);
  release();
  await pending;
  await new DurableChangePipeline(f.store).advance(f.ports);
  expect(f.store.read()).toMatchObject({
    stage: "blocked",
    stopRequested: true,
    cleanupPending: false,
  });
  expect(f.calls).toEqual(["prepare", "stop"]);
});
it("separates persisted result from coordinator acknowledgement and preserves terminal results on Stop", async () => {
  const f = fixture();
  const runner = new DurableChangePipeline(f.store);
  runner.start(input);
  expect(() => runner.acknowledge(input.runId)).toThrow("result_not_ready");
  for (let i = 0; i < 6; i++) await runner.advance(f.ports);
  expect(f.store.read()!.resultAcknowledged).toBeUndefined();
  const result = f.store.read()!.result;
  new DurableChangePipeline(f.store).requestStop(input.runId);
  new DurableChangePipeline(f.store).acknowledge(input.runId);
  new DurableChangePipeline(f.store).acknowledge(input.runId);
  expect(f.store.read()).toMatchObject({ stage: "done", resultAcknowledged: true, result });
  expect(() => runner.acknowledge("later-run")).toThrow("result_not_ready");
});

it("preserves Stop arriving while failed-effect cleanup is in flight", async () => {
  const f = fixture();
  const runner = new DurableChangePipeline(f.store);
  runner.start(input);
  await runner.advance(f.ports);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let cleaning!: () => void;
  const ready = new Promise<void>((resolve) => {
    cleaning = resolve;
  });
  const pending = runner.advance({
    ...f.ports,
    change: async () => {
      throw Error("failed");
    },
    stop: async () => {
      cleaning();
      await gate;
    },
  });
  await ready;
  runner.requestStop(input.runId);
  release();
  await pending;
  expect(f.store.read()).toMatchObject({
    stage: "blocked",
    stopRequested: true,
    cleanupPending: false,
  });
});

it("propagates ownership read failures before dispatch instead of treating them as supersession", async () => {
  const f = fixture();
  new DurableChangePipeline(f.store).start(input);
  const runner = new DurableChangePipeline({
    ...f.store,
    read: () => {
      throw Error("storage_read_failed");
    },
  });
  await expect(runner.advance(f.ports)).rejects.toThrow("storage_read_failed");
  expect(f.calls).toEqual([]);
  expect(f.store.read()!.stage).toBe("prepare");
});
