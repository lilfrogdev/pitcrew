import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  pinPlan,
  assertPinned,
  evidenceIsCurrent,
  pendingOutcomes,
  executePlan,
  verificationGaps,
  recordGapReview,
  verificationMetrics,
  pinContract,
  contractDocument,
  assertContractDocument,
  materializeContract,
  assertMaterializedContract,
  CONTRACT_PATH,
} from "../src/index.ts";
const baseSha = "a".repeat(40),
  candidateSha = "b".repeat(40);
const input = () => ({
  projectId: "project",
  changeId: "change",
  baseSha,
  candidateSha,
  configurationRevision: "config-1",
  reproduceBaseline: true,
  profile: {
    projectId: "project",
    revision: "profile-1",
    checks: [
      {
        id: "tests",
        kind: "command",
        command: {
          argv: ["node", "-e", 'process.stdout.write("verified")'],
          timeoutMs: 1000,
          maxOutputBytes: 1024,
        },
      },
    ],
  },
  acceptance: {
    revision: "acceptance-1",
    criteria: [{ id: "works", text: "Check succeeds", checkIds: ["tests"] }],
  },
});
const workspace = {
  projectId: "project",
  runId: "run",
  repository: "repo",
  baseSha,
  configurationRevision: "config-1",
  artifactId: "artifact",
  workerId: "worker",
};
const completed = { status: "completed", exitCode: 0, stdout: "ok", stderr: "", truncated: false };
const fake = (overrides = {}) => ({
  inspect: async () => ({ sha: candidateSha, clean: true }),
  run: async () => completed,
  ...overrides,
});

test("profile reuse produces immutable per-change pins; every relevant input invalidates evidence", async () => {
  const source = input(),
    plan = await pinPlan(source);
  source.profile.checks[0].command.argv.push("changed");
  assert.deepEqual(plan.profile.checks[0].command.argv, input().profile.checks[0].command.argv);
  assert.ok(Object.isFrozen(plan.profile.checks[0].command.argv));
  assert.equal(await evidenceIsCurrent(plan, input()), true);
  for (const mutate of [
    (i) => (i.candidateSha = "c".repeat(40)),
    (i) => (i.baseSha = "d".repeat(40)),
    (i) => (i.configurationRevision = "config-2"),
    (i) => (i.profile.revision = "profile-2"),
    (i) => (i.acceptance.revision = "acceptance-2"),
    (i) => (i.acceptance.criteria[0].text = "new requirement"),
    (i) => (i.profile.checks[0].command.timeoutMs = 2),
    (i) => (i.changeId = "other"),
  ]) {
    const next = input();
    mutate(next);
    assert.equal(await evidenceIsCurrent(plan, next), false);
  }
  const tampered = structuredClone(plan);
  tampered.profile.checks[0].command.argv = ["true"];
  await assert.rejects(assertPinned(tampered), /PLAN_CHANGED/);
  const outcomes = await executePlan(plan, "candidate", workspace, fake());
  await assert.rejects(verificationGaps(tampered, outcomes), /PLAN_CHANGED/);
});
test("invalid bounds, duplicate IDs and missing criterion checks are rejected", async () => {
  for (const mutate of [
    (i) => (i.profile.checks[0].command.timeoutMs = 600001),
    (i) => i.profile.checks.push(i.profile.checks[0]),
    (i) => (i.acceptance.criteria[0].checkIds = ["missing"]),
    (i) => (i.acceptance.criteria = []),
    (i) => (i.profile.projectId = "other"),
  ]) {
    const next = input();
    mutate(next);
    await assert.rejects(pinPlan(next));
  }
});
test("not-run, unsupported runtime, cancellation and transport errors are explicit", async () => {
  const source = input();
  source.profile.checks.push({
    id: "browser",
    kind: "runtime",
    capability: "browser",
    description: "Inspect UI",
  });
  const plan = await pinPlan(source);
  assert.equal(pendingOutcomes(plan).length, 4);
  assert.ok(pendingOutcomes(plan).every((o) => o.status === "not_run"));
  const results = await executePlan(plan, "candidate", workspace, fake());
  assert.deepEqual(
    results.map((o) => o.status),
    ["passed", "blocked"],
  );
  assert.equal(results[1].reason, "unsupported_capability:browser");
  assert.deepEqual(await verificationGaps(plan, results), ["browser"]);
  const controller = new AbortController();
  controller.abort();
  assert.ok(
    (await executePlan(plan, "candidate", workspace, fake(), controller.signal)).every(
      (o) => o.status === "not_run",
    ),
  );
  const failed = await executePlan(
    plan,
    "candidate",
    workspace,
    fake({
      run: async () => {
        throw new Error("private transport data");
      },
    }),
  );
  assert.equal(failed[0].reason, "execution_unavailable");
  assert.ok(!JSON.stringify(failed).includes("private transport data"));
});
test("exact workspace bindings and post-check identity prevent false passes", async () => {
  const plan = await pinPlan(input());
  await assert.rejects(
    executePlan(plan, "candidate", { ...workspace, projectId: "other" }, fake()),
    /WORKSPACE_MISMATCH/,
  );
  let calls = 0;
  const stale = await executePlan(
    plan,
    "candidate",
    workspace,
    fake({
      inspect: async () => ({ sha: baseSha, clean: true }),
      run: async () => {
        calls++;
        return completed;
      },
    }),
  );
  assert.equal(calls, 0);
  assert.equal(stale[0].reason, "stale_workspace");
  let inspections = 0;
  const changed = await executePlan(
    plan,
    "candidate",
    workspace,
    fake({ inspect: async () => ({ sha: candidateSha, clean: ++inspections === 1 }) }),
  );
  assert.equal(changed[0].reason, "workspace_changed");
  for (const result of [
    { ...completed, truncated: true },
    { ...completed, status: "timed_out" },
    { ...completed, exitCode: 1 },
  ]) {
    assert.equal(
      (await executePlan(plan, "candidate", workspace, fake({ run: async () => result })))[0]
        .status,
      "failed",
    );
  }
});
test("baseline reproduction is distinct and cannot satisfy candidate verification", async () => {
  const plan = await pinPlan(input());
  const baseline = await executePlan(
    plan,
    "baseline",
    workspace,
    fake({
      inspect: async () => ({ sha: baseSha, clean: true }),
      run: async () => ({ ...completed, exitCode: 1 }),
    }),
  );
  assert.equal(baseline[0].status, "failed");
  assert.equal(baseline[0].checkedSha, baseSha);
  assert.deepEqual(await verificationGaps(plan, baseline), ["tests"]);
  const passed = await executePlan(plan, "candidate", workspace, fake());
  assert.deepEqual(await verificationGaps(plan, [...baseline, ...passed]), []);
  assert.deepEqual(await verificationGaps(plan, [...passed, ...passed]), ["tests"]);
  const next = await pinPlan({ ...input(), reproduceBaseline: false });
  await assert.rejects(executePlan(next, "baseline", workspace, fake()), /WORKSPACE_MISMATCH/);
});
test("independent reviewer records gaps without altering evidence or passing checks", async () => {
  const plan = await pinPlan(input()),
    outcomes = pendingOutcomes(plan);
  assert.throws(
    () => recordGapReview(plan, "worker", "worker", [], "Looks good"),
    /INVALID_REVIEWER/,
  );
  const review = recordGapReview(
    plan,
    "worker",
    "reviewer",
    ["tests"],
    "No executed candidate check",
  );
  assert.deepEqual(review.gaps, ["tests"]);
  assert.deepEqual(await verificationGaps(plan, outcomes), ["tests"]);
});
test("metrics count real deduplicated events and measured durations, acceptance remains unknown", () => {
  const event = {
    sequence: 1,
    projectId: "project",
    type: "run.completed",
    entityId: "run",
    createdAt: "2026-10-04T00:00:00Z",
  };
  const review = { id: "review", runId: "run", decision: "request_changes" };
  const outcome = {
    runId: "run",
    planFingerprint: "pin",
    checkId: "tests",
    phase: "candidate",
    durationMs: 12,
  };
  assert.deepEqual(verificationMetrics([event, event], [review, review], [outcome, outcome]), {
    completedRuns: 1,
    approvedRuns: 0,
    reworkReviews: 1,
    acceptedChanges: null,
    measuredChecks: 1,
    checkDurationMs: 12,
  });
});
// Test-only local executor: fixed Node executable, argv without shell, bounded output and timeout.
function localRun(_workspace, command, signal) {
  assert.equal(command.argv[0], "node");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, command.argv.slice(1), { shell: false, signal });
    let stdout = "",
      stderr = "",
      size = 0,
      status = "completed",
      truncated = false;
    const timer = setTimeout(() => {
      status = "timed_out";
      child.kill();
    }, command.timeoutMs);
    function append(chunk, stream) {
      const room = command.maxOutputBytes - size;
      const part = chunk.subarray(0, Math.max(room, 0)).toString();
      size += chunk.length;
      if (stream === "stdout") stdout += part;
      else stderr += part;
      if (size > command.maxOutputBytes) {
        truncated = true;
        status = "output_limit";
        child.kill();
      }
    }
    child.stdout.on("data", (chunk) => append(chunk, "stdout"));
    child.stderr.on("data", (chunk) => append(chunk, "stderr"));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ status, exitCode, stdout, stderr, truncated });
    });
  });
}
test("real local bounded Node executor produces artifact-bound candidate evidence", async () => {
  const plan = await pinPlan(input());
  const result = await executePlan(plan, "candidate", workspace, fake({ run: localRun }));
  assert.equal(result[0].status, "passed");
  assert.equal(result[0].result.stdout, "verified");
  assert.equal(result[0].artifactId, "artifact");
  assert.ok(result[0].durationMs >= 0);
  assert.deepEqual(await verificationGaps(plan, result), []);
});
test("real executor enforces timeout and output limits", async () => {
  for (const command of [
    { argv: ["node", "-e", "setTimeout(()=>{},10000)"], timeoutMs: 30, maxOutputBytes: 1024 },
    {
      argv: ["node", "-e", 'process.stdout.write("x".repeat(10000))'],
      timeoutMs: 1000,
      maxOutputBytes: 16,
    },
  ]) {
    const source = input();
    source.profile.checks[0].command = command;
    const result = await executePlan(
      await pinPlan(source),
      "candidate",
      workspace,
      fake({ run: localRun }),
    );
    assert.equal(result[0].status, "failed");
  }
});
test("contract snapshots exclude the candidate SHA and reject tampering", async () => {
  const source = input();
  const snapshot = await pinContract({
    projectId: source.projectId,
    missionId: "mission",
    baseSha,
    configurationRevision: source.configurationRevision,
    proposalRevision: "proposal",
    checks: source.profile.checks,
    acceptance: source.acceptance,
  });
  assert.equal(JSON.stringify(snapshot).includes(candidateSha), false);
  const again = await pinContract({
    projectId: source.projectId,
    missionId: "mission",
    baseSha,
    configurationRevision: source.configurationRevision,
    proposalRevision: "proposal",
    checks: source.profile.checks,
    acceptance: source.acceptance,
  });
  assert.equal(again.digest, snapshot.digest);
  const files = new Map();
  const transport = {
    async writeFile(_workspace, path, content) {
      files.set(path, content);
    },
    async readFile(_workspace, path) {
      return files.get(path);
    },
  };
  await materializeContract(snapshot, workspace, transport);
  await assertMaterializedContract(snapshot, workspace, transport);
  assert.equal(files.has(CONTRACT_PATH), true);
  const tampered = JSON.parse(contractDocument(snapshot));
  tampered.acceptance.criteria[0].text = "changed";
  await assert.rejects(
    () => assertContractDocument(snapshot, JSON.stringify(tampered)),
    /CONTRACT_TAMPERED/,
  );
  files.set(CONTRACT_PATH, JSON.stringify(tampered));
  await assert.rejects(
    () => assertMaterializedContract(snapshot, workspace, transport),
    /CONTRACT_TAMPERED/,
  );
});
