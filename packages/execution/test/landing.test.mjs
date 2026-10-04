import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { SqliteLandingStore, TrustedLandingService } from "../src/index.ts";

const baseSha = "a".repeat(40),
  candidateSha = "b".repeat(40);
function sqliteStorage() {
  const db = new DatabaseSync(":memory:");
  return {
    db,
    sql: {
      exec(sql, ...args) {
        const statement = db.prepare(sql);
        let rows = [];
        if (statement.columns().length) rows = statement.all(...args);
        else statement.run(...args);
        return { toArray: () => rows };
      },
    },
    transactionSync(action) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = action();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}
function fixture() {
  const storage = sqliteStorage(),
    store = new SqliteLandingStore(storage);
  let time = 1000,
    nextId = 0,
    head = baseSha,
    pushes = 0;
  const evidence = {
    runId: "run-1",
    projectId: "project",
    repository: "canonical",
    artifactId: "fork",
    targetRef: "refs/heads/main",
    baseSha,
    candidateSha,
    configurationRevision: "revision-1",
    currentConfigurationRevision: "revision-1",
    tests: [
      {
        status: "passed",
        exitCode: 0,
        truncated: false,
        argv: ["npm", "test"],
        stdout: "",
        stderr: "",
        baseSha,
        candidateSha,
        configurationRevision: "revision-1",
      },
    ],
    review: {
      id: "review",
      runId: "run-1",
      actor: "independent-reviewer",
      decision: "approve",
      summary: "Reviewed",
      baseSha,
      candidateSha,
      configurationRevision: "revision-1",
    },
  };
  const source = { read: async () => structuredClone(evidence) };
  const transport = {
    targetHead: async () => head,
    land: async (authorization) => {
      pushes++;
      head = authorization.candidateSha;
      return { status: "landed" };
    },
  };
  const service = new TrustedLandingService(
    source,
    store,
    transport,
    () => time,
    () => `auth-${++nextId}`,
  );
  const approval = {
    runId: "run-1",
    actor: "human",
    expectedTargetSha: baseSha,
    candidateSha,
    configurationRevision: "revision-1",
    idempotencyKey: "action-1",
  };
  return {
    storage,
    store,
    evidence,
    source,
    transport,
    service,
    approval,
    pushCount: () => pushes,
    setHead: (value) => {
      head = value;
    },
    setTime: (value) => {
      time = value;
    },
  };
}
const request = (authorization) => ({
  authorizationId: authorization.authorizationId,
  actor: authorization.actor,
  runId: authorization.runId,
});

test("review approval alone cannot land; separate permission and action required", async () => {
  const f = fixture();
  await assert.rejects(
    f.service.land({ authorizationId: "review", actor: "human", runId: "run-1" }),
    { code: "AUTHORIZATION_NOT_FOUND" },
  );
  const authorization = await f.service.authorize(f.approval);
  assert.equal(f.pushCount(), 0);
  const result = await f.service.land(request(authorization));
  assert.equal(result.status, "landed");
  assert.equal(result.landedSha, candidateSha);
  assert.equal(f.pushCount(), 1);
});

test("one-use permission returns durable receipt on replay without a second push", async () => {
  const f = fixture(),
    authorization = await f.service.authorize(f.approval);
  const result = await f.service.land(request(authorization));
  const restarted = new TrustedLandingService(
    f.source,
    new SqliteLandingStore(f.storage),
    f.transport,
  );
  assert.deepEqual(await restarted.land(request(authorization)), result);
  assert.equal(f.pushCount(), 1);
});

test("authorization issuance is idempotent but hash/revision/key reuse conflicts", async () => {
  const f = fixture(),
    authorization = await f.service.authorize(f.approval);
  assert.deepEqual(await f.service.authorize(f.approval), authorization);
  const changed = { ...authorization, candidateSha: "c".repeat(40), authorizationId: "different" };
  assert.throws(
    () => f.store.issue(JSON.stringify(["human", "run-1", "action-1"]), "changed", changed),
    { code: "IDEMPOTENCY_CONFLICT" },
  );
});

test("permission bound to authenticated actor, run and expiry", async () => {
  const f = fixture(),
    authorization = await f.service.authorize(f.approval);
  await assert.rejects(f.service.land({ ...request(authorization), actor: "another-human" }), {
    code: "AUTHORIZATION_NOT_FOUND",
  });
  await assert.rejects(f.service.land({ ...request(authorization), runId: "another-run" }), {
    code: "AUTHORIZATION_NOT_FOUND",
  });
  f.setTime(authorization.expiresAt);
  await assert.rejects(f.service.land(request(authorization)), { code: "AUTHORIZATION_EXPIRED" });
  assert.equal(f.pushCount(), 0);
});

test("stale target at authorization is rejected with no permission", async () => {
  const f = fixture();
  f.setHead("c".repeat(40));
  await assert.rejects(f.service.authorize(f.approval), { code: "STALE_TARGET" });
  assert.equal(f.storage.db.prepare("SELECT count(*) n FROM landing_permissions").get().n, 0);
});

for (const mutation of ["target", "configuration", "review", "tests", "candidate", "artifact"]) {
  test(`landing rereads exact trusted evidence and rejects changed ${mutation}`, async () => {
    const f = fixture(),
      authorization = await f.service.authorize(f.approval);
    if (mutation === "target") f.setHead("c".repeat(40));
    if (mutation === "configuration") f.evidence.currentConfigurationRevision = "revision-2";
    if (mutation === "review") f.evidence.review.candidateSha = baseSha;
    if (mutation === "tests") f.evidence.tests[0].truncated = true;
    if (mutation === "candidate") f.evidence.candidateSha = baseSha;
    if (mutation === "artifact") f.evidence.artifactId = "different-fork";
    assert.equal((await f.service.land(request(authorization))).status, "rejected");
    assert.equal((await f.service.land(request(authorization))).status, "rejected");
    assert.equal(f.pushCount(), 0);
    assert.doesNotThrow(() => f.store.assertRepositoryIdle("canonical"));
  });
}

test("concurrent replay sees pending receipt and does not invoke duplicate landing", async () => {
  const f = fixture(),
    authorization = await f.service.authorize(f.approval);
  let unblock,
    attempts = 0;
  f.transport.land = async () => {
    attempts++;
    return new Promise((resolve) => {
      unblock = resolve;
    });
  };
  const first = f.service.land(request(authorization));
  while (!unblock) await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await f.service.land(request(authorization))).status, "uncertain");
  assert.equal(attempts, 1);
  unblock({ status: "landed" });
  assert.equal((await first).status, "landed");
});

test("repository serialization covers two permissions and configuration changes only", async () => {
  const f = fixture(),
    one = await f.service.authorize(f.approval);
  const two = await f.service.authorize({ ...f.approval, idempotencyKey: "action-2" });
  f.store.begin(one.authorizationId, "human", "run-1", 1000);
  await assert.rejects(f.service.land(request(two)), { code: "REPOSITORY_LANDING_BUSY" });
  assert.equal(f.store.get(two.authorizationId, "human", "run-1").state, "authorized");
  assert.throws(() => f.store.assertRepositoryIdle("canonical"), {
    code: "REPOSITORY_LANDING_BUSY",
  });
  assert.doesNotThrow(() => f.store.assertRepositoryIdle("another-repository"));
});

test("crash after consuming permission leaves durable gate; restart never pushes", async () => {
  const f = fixture(),
    authorization = await f.service.authorize(f.approval);
  f.store.begin(authorization.authorizationId, "human", "run-1", 1000);
  const restarted = new TrustedLandingService(
    f.source,
    new SqliteLandingStore(f.storage),
    f.transport,
  );
  assert.equal((await restarted.land(request(authorization))).status, "uncertain");
  assert.equal(f.pushCount(), 0);
  assert.throws(() => f.store.assertRepositoryIdle("canonical"));
});

test("uncertain push cannot be replayed or unlocked by observing unchanged base", async () => {
  const f = fixture(),
    authorization = await f.service.authorize(f.approval);
  let attempts = 0;
  f.transport.land = async () => {
    attempts++;
    throw new Error("canonical credential should not leak");
  };
  const result = await f.service.land(request(authorization));
  assert.equal(result.status, "uncertain");
  assert.equal(result.code, "LANDING_UNCERTAIN");
  assert.equal((await f.service.reconcile(request(authorization))).status, "uncertain");
  assert.equal((await f.service.land(request(authorization))).status, "uncertain");
  assert.throws(() => f.store.assertRepositoryIdle("canonical"));
  assert.equal(attempts, 1);
});

test("lost push acknowledgement reconciles exact target read only and preserves consumed receipt", async () => {
  const f = fixture(),
    authorization = await f.service.authorize(f.approval);
  let attempts = 0;
  f.transport.land = async () => {
    attempts++;
    f.setHead(candidateSha);
    throw new Error("response lost");
  };
  assert.equal((await f.service.land(request(authorization))).status, "uncertain");
  const result = await f.service.reconcile(request(authorization));
  assert.equal(result.status, "landed");
  assert.equal(result.code, "RECONCILED_TARGET");
  assert.doesNotThrow(() => f.store.assertRepositoryIdle("canonical"));
  assert.deepEqual(await f.service.land(request(authorization)), result);
  assert.equal(attempts, 1);
});

test("lost SQLite finish acknowledgement returns uncertain then recovers persisted success", async () => {
  const f = fixture(),
    authorization = await f.service.authorize(f.approval);
  const finish = f.store.finish.bind(f.store);
  f.store.finish = (...args) => {
    finish(...args);
    throw new Error("ack lost");
  };
  assert.equal((await f.service.land(request(authorization))).status, "uncertain");
  assert.equal((await f.service.land(request(authorization))).status, "landed");
  assert.equal(f.pushCount(), 1);
});

test("transaction failure rolls back consumption and repository lock together", async () => {
  const f = fixture(),
    authorization = await f.service.authorize(f.approval);
  f.storage.db.exec(
    `CREATE TRIGGER prevent_consumption BEFORE UPDATE ON landing_permissions BEGIN SELECT RAISE(ABORT, 'fixture failure'); END`,
  );
  await assert.rejects(f.service.land(request(authorization)));
  assert.equal(f.store.get(authorization.authorizationId, "human", "run-1").state, "authorized");
  assert.doesNotThrow(() => f.store.assertRepositoryIdle("canonical"));
  assert.equal(f.pushCount(), 0);
});
