import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ExecutionCoordinator,
  CloudflareExecutionAdapter,
  assertMergeEvidence,
  mergeCandidate,
} from "../src/index.ts";

const baseSha = "a".repeat(40);
const candidateSha = "b".repeat(40);
const input = {
  runId: "run-1",
  projectId: "project",
  repository: "canonical",
  baseSha,
  configurationRevision: "config-1",
};
const command = {
  commandId: "tests",
  argv: ["npm", "test"],
  timeoutMs: 1000,
  maxOutputBytes: 1024,
};
const completed = {
  exitCode: 0,
  stdout: "passed",
  stderr: "",
  truncated: false,
  status: "completed",
};

class Journal {
  records = new Map();
  async claim(key, fingerprint) {
    if (this.records.has(key))
      return { claimed: false, record: structuredClone(this.records.get(key)) };
    const record = { fingerprint, state: "pending" };
    this.records.set(key, record);
    return { claimed: true, record: structuredClone(record) };
  }
  async complete(key, fingerprint, result) {
    assert.equal(this.records.get(key)?.fingerprint, fingerprint);
    this.records.set(key, { fingerprint, state: "complete", result: structuredClone(result) });
  }
}

function fixture() {
  const calls = { forks: [], prepares: [], runs: [], stops: [], publishes: [] };
  const journal = new Journal();
  const transport = {
    prepare: async (workspace) => {
      calls.prepares.push(workspace);
    },
    inspect: async () => ({ sha: candidateSha, clean: true }),
    run: async (workspace, cmd) => {
      calls.runs.push({ workspace, command: cmd });
      return { ...completed };
    },
    publish: async (workspace, sha) => {
      calls.publishes.push({ workspace, sha });
    },
    stop: async (workspace) => {
      calls.stops.push(workspace);
    },
  };
  const forks = {
    fork: async (...args) => {
      calls.forks.push(args);
    },
  };
  const coordinator = new ExecutionCoordinator(forks, transport, journal);
  return { calls, journal, transport, forks, coordinator };
}

test("per-run isolation and exact pinned base; concurrent projects do not collide", async () => {
  const { coordinator, calls } = fixture();
  const [one, two, three] = await Promise.all([
    coordinator.prepare(input),
    coordinator.prepare({ ...input, runId: "run-2" }),
    coordinator.prepare({ ...input, projectId: "project-run", runId: "1" }),
  ]);
  assert.equal(new Set([one.workerId, two.workerId, three.workerId]).size, 3);
  assert.equal(new Set([one.artifactId, two.artifactId, three.artifactId]).size, 3);
  assert.equal(calls.forks.length, 3);
  assert.ok(calls.forks.every(([source, , base]) => source === "canonical" && base === baseSha));
});

test("successful prepare and completed command replay recover without running twice", async () => {
  const { coordinator, calls } = fixture();
  const workspace = await coordinator.prepare(input);
  assert.deepEqual(await coordinator.prepare(input), workspace);
  const evidence = await coordinator.test(workspace, candidateSha, command);
  assert.deepEqual(await coordinator.test(workspace, candidateSha, command), evidence);
  assert.equal(calls.forks.length, 1);
  assert.equal(calls.runs.length, 1);
  assert.equal(evidence.candidateSha, candidateSha);
  assert.equal(evidence.baseSha, baseSha);
  assert.equal(evidence.configurationRevision, "config-1");
});

test("uncertain fork quarantines retries and does not expose raw exception", async () => {
  const { coordinator, forks } = fixture();
  let attempts = 0;
  forks.fork = async () => {
    attempts++;
    throw new Error("account-token-secret");
  };
  await assert.rejects(coordinator.prepare(input), { message: "UNCERTAIN_OPERATION" });
  await assert.rejects(coordinator.prepare(input), { message: "UNCERTAIN_OPERATION" });
  assert.equal(attempts, 1);
});

test("same run ID with changed base/configuration is an idempotency conflict", async () => {
  const { coordinator } = fixture();
  await coordinator.prepare(input);
  await assert.rejects(coordinator.prepare({ ...input, baseSha: candidateSha }), {
    code: "IDEMPOTENCY_CONFLICT",
  });
  await assert.rejects(coordinator.prepare({ ...input, configurationRevision: "config-2" }), {
    code: "IDEMPOTENCY_CONFLICT",
  });
});

test("uncertain command does not replay after restart", async () => {
  const f = fixture();
  const workspace = await f.coordinator.prepare(input);
  let attempts = 0;
  f.transport.run = async () => {
    attempts++;
    throw new Error("lost acknowledgement after mutation");
  };
  await assert.rejects(f.coordinator.test(workspace, candidateSha, command), {
    code: "UNCERTAIN_OPERATION",
  });
  const recovered = new ExecutionCoordinator(f.forks, f.transport, f.journal);
  await assert.rejects(recovered.test(workspace, candidateSha, command), {
    code: "UNCERTAIN_OPERATION",
  });
  assert.equal(attempts, 1);
});

test("lost durable completion acknowledgement can recover completed result", async () => {
  const f = fixture();
  const workspace = await f.coordinator.prepare(input);
  const original = f.journal.complete.bind(f.journal);
  f.journal.complete = async (...args) => {
    await original(...args);
    throw new Error("ack lost");
  };
  await assert.rejects(f.coordinator.test(workspace, candidateSha, command), {
    code: "UNCERTAIN_OPERATION",
  });
  assert.equal((await f.coordinator.test(workspace, candidateSha, command)).exitCode, 0);
  assert.equal(f.calls.runs.length, 1);
});

for (const state of [
  { sha: baseSha, clean: true },
  { sha: candidateSha, clean: false },
]) {
  test(`reject stale or dirty test candidate before execution: ${JSON.stringify(state)}`, async () => {
    const f = fixture();
    const workspace = await f.coordinator.prepare(input);
    f.transport.inspect = async () => state;
    await assert.rejects(f.coordinator.test(workspace, candidateSha, command));
    assert.equal(f.calls.runs.length, 0);
  });
}

test("SHA or working tree changes during tests cannot become successful evidence", async () => {
  const f = fixture();
  const workspace = await f.coordinator.prepare(input);
  let count = 0;
  f.transport.inspect = async () => ({ sha: ++count === 1 ? candidateSha : baseSha, clean: true });
  await assert.rejects(f.coordinator.test(workspace, candidateSha, command));
  assert.equal(f.calls.runs.length, 1);
});

test("forged workspace cannot run or stop another workspace", async () => {
  const f = fixture();
  const workspace = await f.coordinator.prepare(input);
  await assert.rejects(
    f.coordinator.test({ ...workspace, workerId: "another-run" }, candidateSha, command),
  );
  await assert.rejects(f.coordinator.stop({ ...workspace, artifactId: "canonical" }));
  assert.equal(f.calls.runs.length, 0);
  assert.equal(f.calls.stops.length, 0);
});

test("cancellation and invalid bounds reject before command is executed", async () => {
  const f = fixture();
  const workspace = await f.coordinator.prepare(input);
  const signal = AbortSignal.abort();
  await assert.rejects(f.coordinator.test(workspace, candidateSha, command, signal), {
    code: "STOPPED",
  });
  for (const change of [
    { timeoutMs: 0 },
    { timeoutMs: 600001 },
    { maxOutputBytes: 1048577 },
    { argv: [] },
    { argv: ["a\0b"] },
  ])
    await assert.rejects(f.coordinator.test(workspace, candidateSha, { ...command, ...change }), {
      code: "INVALID_COMMAND",
    });
  assert.equal(f.calls.runs.length, 0);
});

function adapterFixture() {
  const f = fixture();
  let applies = 0;
  const worker = {
    apply: async () => {
      applies++;
      return { candidateSha, summary: "Changed source" };
    },
  };
  const reviewer = {
    review: async () => ({
      baseSha,
      candidateSha,
      configurationRevision: input.configurationRevision,
      decision: "approve",
      summary: "Reviewed independently",
      actor: "reviewer",
    }),
  };
  const adapter = new CloudflareExecutionAdapter(
    f.coordinator,
    f.journal,
    worker,
    reviewer,
    command,
  );
  return { ...f, adapter, worker, reviewer, applies: () => applies };
}

test("protocol adapter publishes/tests/reviews exact candidate and stops, with safe recovery", async () => {
  const f = adapterFixture();
  const request = { ...input, threadId: "thread-1", messages: [] };
  const result = await f.adapter.delegate(request);
  assert.equal(result.tests.status, "passed");
  assert.equal(result.tests.candidateSha, candidateSha);
  assert.equal(result.review.candidateSha, candidateSha);
  assert.equal(result.review.baseSha, baseSha);
  assert.equal(f.calls.publishes[0].sha, candidateSha);
  assert.equal(f.calls.stops.length, 1);
  assert.deepEqual(await f.adapter.delegate(request), result);
  assert.equal(f.applies(), 1);
});

test("protocol adapter rejects stale independent reviewer evidence", async () => {
  const f = adapterFixture();
  f.reviewer.review = async () => ({
    baseSha,
    candidateSha: baseSha,
    configurationRevision: input.configurationRevision,
    decision: "approve",
    summary: "stale",
    actor: "reviewer",
  });
  await assert.rejects(f.adapter.delegate({ ...input, threadId: "thread", messages: [] }));
  assert.equal(f.calls.stops.length, 1);
});

test("reviewer cannot approve failed or truncated tests", async () => {
  const f = adapterFixture();
  f.transport.run = async () => ({ ...completed, exitCode: 1 });
  await assert.rejects(f.adapter.delegate({ ...input, threadId: "thread", messages: [] }));
});

test("stop failure prevents successful durable delegation and replay", async () => {
  const f = adapterFixture();
  f.transport.stop = async () => {
    throw new Error("destroy uncertain");
  };
  const request = { ...input, threadId: "thread", messages: [] };
  await assert.rejects(f.adapter.delegate(request));
  await assert.rejects(f.adapter.delegate(request), { code: "UNCERTAIN_OPERATION" });
  assert.equal(f.applies(), 1);
});

test("merge guard rejects stale target/reviewer/test bindings and production merge stays disabled", async () => {
  const f = fixture();
  const workspace = await f.coordinator.prepare(input);
  const evidence = await f.coordinator.test(workspace, candidateSha, command);
  const candidate = {
    workspace,
    candidateSha,
    tests: [evidence],
    review: { baseSha, candidateSha, configurationRevision: "config-1", decision: "approve" },
  };
  assert.doesNotThrow(() => assertMergeEvidence(candidate, baseSha));
  assert.throws(() => assertMergeEvidence(candidate, candidateSha));
  assert.throws(() =>
    assertMergeEvidence({ ...candidate, tests: [{ ...evidence, candidateSha: baseSha }] }, baseSha),
  );
  assert.throws(() =>
    assertMergeEvidence(
      { ...candidate, review: { ...candidate.review, configurationRevision: "old" } },
      baseSha,
    ),
  );
  await assert.rejects(mergeCandidate(candidate), { code: "MERGE_DISABLED" });
});
