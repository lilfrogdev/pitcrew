import { expect, it } from "vite-plus/test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RepoMemory, type RepoMemoryAccess, type RepoMemorySource } from "./repo-memory";
import type { KnowledgeSql } from "./knowledge-outbox";
import { Coordinator, initialState } from "./coordinator";
import { memoryAccess, memoryAuthorizer } from "./repo-memory-orchestration";
import { resolveCatalog } from "./model-selection";
import { pinPlan, pendingOutcomes } from "../../../packages/verification/src/index";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

function store(db: DatabaseSync) {
  const sql: KnowledgeSql = {
    exec: (query, ...args) => {
      const rows = db.prepare(query).all(...args);
      return { toArray: () => rows as never };
    },
  };
  return new RepoMemory(sql, (work) => {
    db.exec("BEGIN");
    try {
      const result = work();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  });
}
const access: RepoMemoryAccess = {
  projectId: "project",
  repository: "repository",
  threadId: "thread",
  actor: "alice",
  allowedThreadIds: ["thread"],
  revision: "configuration-1",
};
function source(
  sourceId: string,
  text: string,
  overrides: Partial<RepoMemorySource> = {},
): RepoMemorySource {
  return {
    sourceId,
    text,
    projectId: access.projectId,
    repository: access.repository,
    threadId: access.threadId,
    kind: "message:user",
    date: "2026-10-09T00:00:00Z",
    ...overrides,
  };
}
const allow = () => true;

it("isolates colliding source identifiers across project, repository and private thread scopes", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const memory = store(db);
    memory.append(source("collision", "allowed"));
    const foreign = [
      memory.append(source("collision", "other-project-secret", { projectId: "other-project" })),
      memory.append(
        source("collision", "other-repository-secret", { repository: "other-repository" }),
      ),
      memory.append(source("collision", "other-thread-secret", { threadId: "other-thread" })),
    ];
    memory.beginTurn("turn", access);
    expect(memory.view("turn", "view", access, allow).items.map((item) => item.text)).toEqual([
      "allowed",
    ]);
    foreign.forEach((node, index) =>
      expect(() =>
        memory.zoom("turn", `foreign-${index}`, access, allow, { nodeId: node.nodeId }),
      ).toThrow("memory_access_denied"),
    );
    expect(memory.search("turn", "search", access, allow, { query: "secret" }).items).toEqual([]);
    expect(() => memory.append(source("collision", "rewrite"))).toThrow("memory_source_conflict");
    expect(() =>
      db
        .prepare("UPDATE repo_memory_sources SET body=? WHERE source_id=?")
        .run("rewrite", "collision"),
    ).toThrow("memory_source_immutable");
    expect(() =>
      db.prepare("DELETE FROM repo_memory_sources WHERE source_id=?").run("collision"),
    ).toThrow("memory_source_immutable");
    expect(db.prepare("SELECT count(*) AS n FROM repo_memory_sources").get()).toMatchObject({
      n: 4,
    });
  } finally {
    db.close();
  }
});

it("fences every descendant of summaries and cached read receipts after access revocation", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const memory = store(db);
    for (let i = 0; i < 34; i++) memory.append(source(`source-${i}`, `alpha-${i}`));
    memory.beginTurn("turn", access);
    let revoked = false;
    const authorize = (ref: { sourceId: string }) => !(revoked && ref.sourceId === "source-1");
    const page = memory.view("turn", "cached", access, authorize, { limit: 1 });
    expect(page.items[0].sourceRefs[0]).toMatchObject({ first: 0, last: 2 });
    revoked = true;
    expect(() => memory.view("turn", "cached", access, authorize, { limit: 1 })).toThrow(
      "memory_access_denied",
    );
    expect(() =>
      memory.zoom("turn", "zoom", access, authorize, { nodeId: page.items[0].nodeId }),
    ).toThrow("memory_access_denied");
    expect(() => memory.assertReferences(access, authorize, page.items[0].sourceRefs)).toThrow(
      "memory_access_denied",
    );
    const search = memory.search("turn", "search", access, authorize, {
      query: "alpha-1",
      limit: 32,
    });
    expect(
      search.items.some((item) => item.sourceRefs.some((ref) => ref.sourceId === "source-1")),
    ).toBe(false);
  } finally {
    db.close();
  }
});

it("rejects malformed and nonshrinking summaries while leaving immutable source bytes intact", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    const memory = store(db);
    const original = source("original", "Incident evidence ".repeat(80));
    memory.append(original);
    const before = db.prepare("SELECT body FROM repo_memory_sources").get();
    memory.beginTurn("turn", access);
    const claim = (await memory.nextCompression("turn", "compression", access, allow))!;
    for (const text of ["", "  ", "\u0000hidden", "\ud800", "😀".repeat(129)]) {
      expect(() =>
        memory.acceptSummary("turn", "compression", access, allow, { ...claim, text }),
      ).toThrow("invalid_memory_summary");
    }
    expect(() =>
      memory.acceptSummary("turn", "compression", access, allow, {
        ...claim,
        inputId: "forged",
        text: "summary",
      }),
    ).toThrow("invalid_memory_claim");
    memory.acceptSummary("turn", "compression", access, allow, {
      ...claim,
      text: "Incident evidence",
    });
    memory.acceptSummary("turn", "compression", access, allow, {
      ...claim,
      text: "Incident evidence",
    });
    expect(() =>
      memory.acceptSummary("turn", "compression", access, allow, { ...claim, text: "Rewritten" }),
    ).toThrow("memory_summary_conflict");
    expect(db.prepare("SELECT body FROM repo_memory_sources").get()).toEqual(before);
    expect(
      memory.zoom("turn", "raw", access, allow, { nodeId: claim.nodeId, limit: 2048 }).items[0]
        .text,
    ).toBe(original.text);
    const small = memory.append(source("nonshrinking", "\u0000abc"));
    memory.beginTurn("small-turn", access);
    const smallClaim = (await memory.nextCompression("small-turn", "small", access, allow))!;
    expect(smallClaim.nodeId).toBe(small.nodeId);
    expect(() =>
      memory.acceptSummary("small-turn", "small", access, allow, { ...smallClaim, text: "abcd" }),
    ).toThrow("memory_summary_conflict");
  } finally {
    db.close();
  }
});

it("keeps tool and compression caps spent across SQLite restart and rejects changed pinned limits", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pitcrew-memory-security-"));
  const path = join(directory, "memory.sqlite");
  let db = new DatabaseSync(path);
  try {
    let memory = store(db);
    memory.append(source("pending", "reference ".repeat(100)));
    memory.beginTurn("read-turn", access, { maxToolCalls: 1 });
    const first = memory.view("read-turn", "receipt", access, allow);
    memory.beginTurn("compression-turn", access, { maxCompressions: 1 });
    const claim = await memory.nextCompression("compression-turn", "dispatch", access, allow);
    expect(claim).toBeDefined();
    db.close();
    db = new DatabaseSync(path);
    memory = store(db);
    expect(memory.view("read-turn", "receipt", access, allow)).toEqual(first);
    expect(() => memory.view("read-turn", "new-call", access, allow)).toThrow("memory_turn_budget");
    expect(() => memory.beginTurn("read-turn", access, { maxToolCalls: 2 })).toThrow(
      "memory_turn_conflict",
    );
    expect(() =>
      memory.beginTurn(
        "read-turn",
        { ...access, revision: "configuration-2" },
        { maxToolCalls: 1 },
      ),
    ).toThrow("memory_turn_conflict");
    expect(
      await memory.nextCompression("compression-turn", "dispatch", access, allow),
    ).toBeUndefined();
    await expect(
      memory.nextCompression("compression-turn", "new-dispatch", access, allow),
    ).rejects.toThrow("memory_turn_budget");
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it("requires every destination recipient to retain source access even when the invoking actor still has it", () => {
  const core = new Coordinator(
    initialState({ id: access.projectId, repository: access.repository }),
    () => {},
  );
  const privateThread = core.createThread("Private", "private"),
    sharedThread = core.createThread("Shared", "shared");
  const alice = { actor: "alice", email: "alice@fixture.example", role: "owner" as const };
  const bob = { actor: "bob", email: "bob@fixture.example", role: "editor" as const };
  core.state.collaboration = {
    projectMembers: { alice, bob },
    threadMembers: { [privateThread.id]: { alice }, [sharedThread.id]: { alice, bob } },
    invitations: {},
  };
  expect(memoryAccess(core, "alice", sharedThread.id).allowedThreadIds).toEqual([sharedThread.id]);
  core.state.collaboration.threadMembers[privateThread.id].bob = bob;
  const admitted = memoryAccess(core, "alice", sharedThread.id);
  expect(admitted.allowedThreadIds).toContain(privateThread.id);
  delete core.state.collaboration.threadMembers[privateThread.id].bob;
  expect(
    memoryAuthorizer(core)(source("secret", "private", { threadId: privateThread.id }), admitted),
  ).toBe(false);
  delete core.state.collaboration.projectMembers.alice;
  expect(() => memoryAccess(core, "alice", sharedThread.id)).toThrow("memory_access_revoked");
});

it("rechecks authorization after an asynchronous compression hash and before accepting its output", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    const memory = store(db);
    memory.append(source("pending", "long reference ".repeat(100)));
    memory.beginTurn("turn", access);
    let revoked = false;
    const authorize = () => !revoked;
    const pending = memory.nextCompression("turn", "revoked-dispatch", access, authorize);
    revoked = true;
    await expect(pending).rejects.toThrow("memory_access_denied");
    expect(db.prepare("SELECT count(*) AS n FROM repo_memory_calls").get()).toMatchObject({ n: 0 });
    revoked = false;
    const claim = (await memory.nextCompression("turn", "allowed-dispatch", access, authorize))!;
    revoked = true;
    expect(() =>
      memory.acceptSummary("turn", "allowed-dispatch", access, authorize, {
        ...claim,
        text: "brief",
      }),
    ).toThrow("memory_access_denied");
    expect(
      db.prepare("SELECT ready FROM repo_memory_nodes WHERE id=?").get(claim.nodeId),
    ).toMatchObject({ ready: 0 });
  } finally {
    db.close();
  }
});

it("enforces byte caps without returning a partial payload and remembers read failures", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    const memory = store(db);
    memory.append(source("large", "large reference ".repeat(100)));
    memory.beginTurn("output-turn", access, { maxOutputBytes: 32 });
    expect(() => memory.view("output-turn", "view", access, allow)).toThrow("memory_turn_budget");
    memory.beginTurn("input-turn", access, { maxInputBytes: 32 });
    await expect(memory.nextCompression("input-turn", "dispatch", access, allow)).rejects.toThrow(
      "memory_turn_budget",
    );
    expect(db.prepare("SELECT result FROM repo_memory_calls").all()).toEqual([
      { result: JSON.stringify({ error: "memory_turn_budget" }) },
    ]);
    expect(() => memory.view("output-turn", "view", access, allow)).toThrow("memory_turn_budget");
    expect(db.prepare("SELECT sum(tools) AS tools FROM repo_memory_turns").get()).toMatchObject({
      tools: 1,
    });
  } finally {
    db.close();
  }
});

it("freezes eligible sources across late appends, mixed summary nodes and SQLite restart", () => {
  const directory = mkdtempSync(join(tmpdir(), "pitcrew-memory-cutoff-"));
  const path = join(directory, "memory.sqlite");
  let db = new DatabaseSync(path);
  try {
    let memory = store(db);
    for (let i = 0; i < 63; i++) memory.append(source(`past-${i}`, `past preference ${i}`));
    memory.beginTurn("frozen", access);
    const later = memory.append(source("future-request", "future implementation request"));
    for (let i = 64; i < 100; i++) memory.append(source(`future-${i}`, `future ${i}`));
    db.close();
    db = new DatabaseSync(path);
    memory = store(db);
    const view = memory.view("frozen", "view", access, allow, { limit: 32 });
    expect(view.items.length).toBeGreaterThan(0);
    expect(view.items.every((item) => item.sourceRefs.every((ref) => ref.last <= 63))).toBe(true);
    expect(view.items.some((item) => item.text.includes("future"))).toBe(false);
    expect(memory.search("frozen", "search", access, allow, { query: "future" }).items).toEqual([]);
    expect(() =>
      memory.zoom("frozen", "future-zoom", access, allow, { nodeId: later.nodeId }),
    ).toThrow("memory_access_denied");
    expect(() =>
      memory.assertTurnReferences("frozen", access, allow, [
        {
          scopeId: JSON.stringify([access.projectId, access.repository, access.threadId]),
          first: 63,
          last: 64,
        },
      ]),
    ).toThrow("memory_access_denied");
    expect(db.prepare("SELECT count(*) AS n FROM repo_memory_sources").get()).toMatchObject({
      n: 100,
    });
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it("rejects a previously completed worker receipt when its source is revoked during verification awaits", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    const memory = store(db);
    memory.append(source("history", "private design history"));
    memory.beginTurn("memory-origin", access);
    const refs = memory
      .view("memory-origin", "brief", access, allow)
      .items.flatMap((item) => item.sourceRefs);
    const core = new Coordinator(initialState(), () => {});
    const thread = core.createThread("Implementation", "thread");
    const queued = core.queueTurn(
      thread.id,
      "Implement the requested button",
      "current",
      "alice",
      resolveCatalog({ EXECUTION_MODE: "fake" }),
    );
    core.beginConversation(queued.turn.id);
    const run = core.delegateConversation(queued.turn.id);
    const input = core.begin(run.id)!;
    let revoked = false;
    core.memoryRunFence = () =>
      memory.assertTurnReferences("memory-origin", access, () => !revoked, refs);
    const planInput = {
      projectId: input.projectId,
      changeId: input.changeId!,
      baseSha: input.baseSha,
      candidateSha: input.baseSha,
      configurationRevision: input.configurationRevision,
      profile: {
        projectId: input.projectId,
        revision: "fixture",
        checks: [
          {
            id: "runtime",
            kind: "runtime" as const,
            capability: "fixture",
            description: "Local verification fixture",
          },
        ],
      },
      acceptance: {
        revision: "fixture",
        criteria: [
          { id: "button", text: "Button matches explicit request", checkIds: ["runtime"] },
        ],
      },
      reproduceBaseline: false,
    };
    const expected = await pinPlan(planInput);
    (core.state.plans ??= {})[run.id] = expected;
    const candidateSha = "b".repeat(40),
      artifactId = "fixture-artifact";
    const actual = await pinPlan({ ...planInput, candidateSha });
    const completion = core.completeVerified(run.id, {
      workerId: "fixture-worker",
      artifactId,
      baseSha: input.baseSha,
      candidateSha,
      summary: "fixture result",
      tests: {
        baseSha: input.baseSha,
        candidateSha,
        configurationRevision: input.configurationRevision,
        status: "not_run",
        argv: [],
        exitCode: null,
        stdout: "",
        stderr: "",
        truncated: false,
      },
      verification: {
        plan: actual,
        outcomes: pendingOutcomes(actual).map((slot) => ({
          ...slot,
          status: "blocked" as const,
          reason: "fixture",
          runId: run.id,
          artifactId,
        })),
      },
    });
    revoked = true;
    await expect(completion).rejects.toThrow("memory_access_denied");
    expect(core.evidence(run.id).run.candidateSha).toBeUndefined();
    expect(core.state.evidence[run.id]).toBeUndefined();
    expect(core.state.reviews).toEqual([]);
    expect(core.evidence(run.id).run.status).toBe("running");
  } finally {
    db.close();
  }
});

it("preserves the original frozen memory admission for authorized reruns and denies them after source revocation or restart", async () => {
  const fixturePath = new URL("../test/repo-memory-worker.ts", import.meta.url).pathname;
  const script = `
    import { MemoryRepositoryFixture, HeldMemoryConversation } from ${JSON.stringify(fixturePath)};
    export { HeldMemoryConversation };
    export class RetryMemoryFixture extends MemoryRepositoryFixture {
      async seedRetry(actor = "alice") {
        const origin = await this.seedMemory(true);
        const original = await this.frozenWorkerBrief(origin.turnId);
        const core = this.getCoordinator();
        core.fail(original.runId);
        core.completeConversation(origin.turnId, "Original explicit request delegated.");
        const retry = core.retryChange(original.changeId, "retry", undefined, actor);
        const input = core.begin(retry.id);
        return { ...origin, actor, credentialActor: input.credentialActor,
          runId: retry.id, originalRunId: original.runId,
          briefUnchanged: JSON.stringify(input.memoryBrief) === JSON.stringify(original.memoryBrief),
          originalTurnRunId: core.conversationTurn(origin.turnId).runId };
      }
      auditRetry(runId) {
        const core = this.getCoordinator(), input = core.state.requests[runId];
        let workerAllowed = true;
        try { this.assertWorkerMemory(input.knowledgeContext, input.memoryBrief); }
        catch { workerAllowed = false; }
        return { authorized: core.runAuthorized(runId), workerAllowed };
      }
    }
    export default { async fetch(request, env) {
      const body = await request.json();
      const stub = env.REPOSITORY.get(env.REPOSITORY.idFromName("retry-fixture-" + (body.actor ?? "alice")));
      if (body.operation === "seed") return Response.json(await stub.seedRetry(body.actor));
      if (body.operation === "revoke") await stub.setMemoryMembership(body.sourceId, false);
      return Response.json(await stub.auditRetry(body.runId));
    } };
  `;
  const bundle = await build({
    stdin: { contents: script, resolveDir: new URL("..", import.meta.url).pathname, loader: "js" },
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    conditions: ["workerd", "worker", "browser"],
    external: ["cloudflare:*", "node:*"],
    alias: { path: "node:path" },
  });
  const options = {
    telemetry: { enabled: false },
    cf: false,
    modules: true,
    script: bundle.outputFiles[0].text,
    compatibilityDate: "2026-10-03",
    compatibilityFlags: ["nodejs_compat"],
    bindings: {
      ENVIRONMENT: "development",
      EXECUTION_MODE: "fake",
      REPO_MEMORY_ENABLED: "true",
    },
    durableObjects: {
      REPOSITORY: { className: "RetryMemoryFixture", useSQLite: true },
      CONVERSATION: { className: "HeldMemoryConversation", useSQLite: true },
    },
    outboundService: () => {
      throw Error("unexpected_external_request");
    },
  };
  const mf = new Miniflare(convertV4MiniflareOptions(options));
  const call = async (body: object) => {
    const response = await mf.dispatchFetch("http://fixture/retry", {
      method: "POST",
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    return response.json() as Promise<any>;
  };
  try {
    const origin = await call({ operation: "seed" });
    expect(origin.runId).not.toBe(origin.originalRunId);
    expect(origin.originalTurnRunId).toBe(origin.originalRunId);
    expect(origin.briefUnchanged).toBe(true);
    expect(await call({ operation: "audit", ...origin })).toEqual({
      authorized: true,
      workerAllowed: true,
    });
    await mf.setOptions(
      convertV4MiniflareOptions({ ...options, script: options.script + "\n// restart" }),
    );
    expect(await call({ operation: "audit", ...origin })).toEqual({
      authorized: true,
      workerAllowed: true,
    });
    expect(await call({ operation: "revoke", ...origin })).toEqual({
      authorized: false,
      workerAllowed: false,
    });
    await mf.setOptions(
      convertV4MiniflareOptions({ ...options, script: options.script + "\n// revoked restart" }),
    );
    expect(await call({ operation: "audit", ...origin })).toEqual({
      authorized: false,
      workerAllowed: false,
    });
    const recipientRetry = await call({ operation: "seed", actor: "bob" });
    expect(recipientRetry.briefUnchanged).toBe(true);
    expect(recipientRetry.credentialActor).toBe("bob");
    expect(await call({ operation: "audit", ...recipientRetry })).toEqual({
      authorized: true,
      workerAllowed: true,
    });
    await mf.setOptions(
      convertV4MiniflareOptions({ ...options, script: options.script + "\n// recipient restart" }),
    );
    expect(await call({ operation: "audit", ...recipientRetry })).toEqual({
      authorized: true,
      workerAllowed: true,
    });
    expect(await call({ operation: "revoke", ...recipientRetry })).toEqual({
      authorized: false,
      workerAllowed: false,
    });
  } finally {
    await mf.dispose();
  }
}, 30000);
