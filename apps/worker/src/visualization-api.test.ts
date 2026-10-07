import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { VisualizationStore, type VisualizationSql } from "./visualization-store";
import {
  publishVisualization,
  visualizationRequest,
  type VisualizationAuthority,
  type VisualizationPrincipal,
} from "./visualization-api";
import {
  VisualizationError,
  VISUALIZATION_LIMITS,
} from "../../../packages/protocol/src/visualizations";
import { Collaboration } from "./collaboration";
import { Coordinator, initialState } from "./coordinator";
import { visualizationTools } from "./visualization-tools";
const content = {
  kind: "bars",
  title: "Capacity",
  summary: "Two categories",
  height: 320,
  points: [{ label: "First", value: 2 }],
};
const context = {
  actor: "account:owner",
  repositoryId: "pitcrew",
  threadId: "thread",
  turnId: "turn",
  invocationId: "call",
};
function fixture() {
  const db = new DatabaseSync(":memory:");
  const sql: VisualizationSql = {
    exec(query, ...args) {
      const statement = db.prepare(query),
        rows = /^SELECT/i.test(query) ? statement.all(...args) : (statement.run(...args), []);
      return { toArray: () => rows };
    },
  };
  const store = new VisualizationStore(sql, (work) => {
    db.exec("BEGIN");
    try {
      const value = work();
      db.exec("COMMIT");
      return value;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  });
  let principal: VisualizationPrincipal | undefined = {
      actor: context.actor,
      accessEpoch: "epoch",
      expiresAt: Date.now() + 60000,
    },
    permitted = true;
  const authority: VisualizationAuthority = {
    session: async () => principal,
    requireThread(c) {
      if (!permitted || c.repositoryId !== context.repositoryId || c.threadId !== context.threadId)
        throw new VisualizationError("not_found", 404);
    },
  };
  const path = `https://pitcrew.test/api/projects/${context.repositoryId}/threads/${context.threadId}/visualizations`;
  const read = () => visualizationRequest(new Request(path), store, authority);
  const create = (invocationId = "call", value: unknown = content) =>
    publishVisualization(
      store,
      { ...context, invocationId },
      value,
      async () => {
        if (!principal) throw new VisualizationError("unauthorized", 401);
      },
      () => authority.requireThread(context),
    );
  return {
    db,
    store,
    authority,
    create,
    read,
    path,
    setPrincipal: (v: VisualizationPrincipal | undefined) => {
      principal = v;
    },
    revoke: () => {
      permitted = false;
    },
  };
}
describe("private visualization admission", () => {
  it("rejects authenticated same-origin HTTP creation and leaves immutable capacity untouched", async () => {
    const f = fixture();
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const result = await visualizationRequest(
        new Request(f.path, {
          method,
          headers: { origin: "https://pitcrew.test", "content-type": "application/json" },
          body: JSON.stringify({ content, key: "manual" }),
        }),
        f.store,
        f.authority,
      );
      expect(result?.status).toBe(405);
    }
    expect(f.store.list("pitcrew", "thread")).toEqual([]);
    expect(
      (
        await visualizationRequest(
          new Request(f.path, {
            method: "POST",
            body: "x".repeat(VISUALIZATION_LIMITS.requestBytes + 1),
          }),
          f.store,
          f.authority,
        )
      )?.status,
    ).toBe(405);
  });
  it("stores immutable trusted provenance and scoped JSON; invocation retries are idempotent", async () => {
    const f = fixture(),
      stored = await f.create();
    expect(stored).toMatchObject({
      creatorActor: context.actor,
      turnId: context.turnId,
      invocationId: context.invocationId,
    });
    stored.content.title = "mutated";
    expect(f.store.get("pitcrew", "thread", stored.id)?.content.title).toBe("Capacity");
    expect(f.store.get("other", "thread", stored.id)).toBeUndefined();
    expect(f.store.get("pitcrew", "other", stored.id)).toBeUndefined();
    expect((await f.create()).id).toBe(stored.id);
    await expect(f.create("call", { ...content, title: "Different" })).rejects.toThrow(
      "visualization_replay_conflict",
    );
    await expect(
      f.create("spoof", { ...content, actor: "other", turnId: "other" }),
    ).rejects.toThrow("invalid_visualization");
    const read = await f.read();
    expect(read?.headers.get("cache-control")).toBe("private, no-store");
    expect(read?.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await read!.json()).toMatchObject({
      accountId: context.actor,
      artifacts: [{ creatorActor: context.actor, turnId: "turn", invocationId: "call" }],
    });
  });
  it("denies missing, expired, replaced sessions, cross-site fetches and navigation", async () => {
    const f = fixture();
    f.setPrincipal(undefined);
    expect((await f.read())?.status).toBe(401);
    f.setPrincipal({ actor: context.actor, accessEpoch: "epoch", expiresAt: Date.now() - 1 });
    expect((await f.read())?.status).toBe(401);
    for (const [key, value] of [
      ["sec-fetch-mode", "navigate"],
      ["sec-fetch-site", "cross-site"],
    ])
      expect(
        (
          await visualizationRequest(
            new Request(f.path, { headers: { [key]: value } }),
            f.store,
            f.authority,
          )
        )?.status,
      ).toBe(403);
    let reads = 0;
    f.authority.session = async () => ({
      actor: context.actor,
      accessEpoch: ++reads === 1 ? "first" : "replacement",
      expiresAt: Date.now() + 60000,
    });
    expect((await f.read())?.status).toBe(401);
  });
  it.each(["membership", "session"])(
    "rechecks %s after suspended publisher authority",
    async (which) => {
      const f = fixture();
      let release!: () => void;
      const pending = publishVisualization(
        f.store,
        context,
        content,
        async () => {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          if (which === "session") throw new VisualizationError("unauthorized", 401);
        },
        () => f.authority.requireThread(context),
      );
      if (which === "membership") f.revoke();
      release();
      await expect(pending).rejects.toThrow(which === "membership" ? "not_found" : "unauthorized");
      expect(f.store.list("pitcrew", "thread")).toEqual([]);
    },
  );
  it("fences authority inside synchronous commit, after digest and before read disclosure", async () => {
    const f = fixture();
    let checks = 0;
    await expect(
      publishVisualization(
        f.store,
        context,
        content,
        async () => {},
        () => {
          if (++checks === 4) throw new VisualizationError("forbidden", 403);
        },
      ),
    ).rejects.toThrow("forbidden");
    expect(f.store.list("pitcrew", "thread")).toEqual([]);
    let fresh = 0;
    await expect(
      publishVisualization(
        f.store,
        context,
        content,
        async () => {
          if (++fresh === 2) throw new VisualizationError("unauthorized", 401);
        },
        () => {},
      ),
    ).rejects.toThrow("unauthorized");
    expect(f.store.list("pitcrew", "thread")).toEqual([]);
    await f.create();
    const list = f.store.list.bind(f.store);
    f.store.list = (...args) => {
      const value = list(...args);
      f.setPrincipal(undefined);
      return value;
    };
    expect((await f.read())?.status).toBe(401);
  });
  it("uses real project AND thread membership; creator identity never becomes collaborator ACL", async () => {
    const f = fixture(),
      core = new Coordinator(initialState(), () => {}),
      thread = core.createThread("Private", "private");
    const owner = { actor: context.actor, email: "dev@lilfrogdev.com" },
      colleague = { actor: "account:colleague", email: "colleague@example.com" };
    const access = new Collaboration(core, owner, owner.email);
    access.bootstrap();
    await publishVisualization(
      f.store,
      { ...context, threadId: thread.id },
      content,
      async () => {},
      () => {},
    );
    core.updateCollaboration((state) => {
      state.collaboration!.projectMembers[colleague.actor] = { ...colleague, role: "editor" };
    });
    const auth: VisualizationAuthority = {
      session: async () => ({
        actor: colleague.actor,
        accessEpoch: "colleague-epoch",
        expiresAt: Date.now() + 60000,
      }),
      requireThread(c) {
        const current = new Collaboration(core, colleague, owner.email);
        current.requireProject(c.repositoryId);
        current.requireThread(c.threadId);
      },
    };
    const req = () =>
      new Request(`https://pitcrew.test/api/projects/pitcrew/threads/${thread.id}/visualizations`);
    expect((await visualizationRequest(req(), f.store, auth))?.status).toBe(404);
    core.updateCollaboration((state) => {
      state.collaboration!.threadMembers[thread.id][colleague.actor] = {
        ...colleague,
        role: "editor",
      };
    });
    expect((await visualizationRequest(req(), f.store, auth))?.status).toBe(200);
    access.remove("thread", thread.id, colleague.actor);
    expect((await visualizationRequest(req(), f.store, auth))?.status).toBe(404);
  });
  it("atomically bounds concurrent count, repository totals and Unicode encoded bytes", async () => {
    const f = fixture(),
      results = await Promise.allSettled(
        Array.from({ length: 20 }, (_, i) => f.create(`call-${i}`)),
      );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(10);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(10);
    const g = fixture(),
      large = {
        kind: "document",
        title: "Large",
        summary: "Unicode",
        height: 320,
        nodes: [{ text: "😀".repeat(14000) }],
      };
    for (let i = 0; i < 9; i++) await g.create(`unicode-${i}`, large);
    await expect(g.create("unicode-over", large)).rejects.toThrow("visualization_capacity");
    const h = fixture();
    for (let i = 0; i < 100; i++)
      await publishVisualization(
        h.store,
        { ...context, threadId: `thread-${Math.floor(i / 10)}`, invocationId: `call-${i}` },
        content,
        async () => {},
        () => {},
      );
    await expect(
      publishVisualization(
        h.store,
        { ...context, threadId: "another" },
        content,
        async () => {},
        () => {},
      ),
    ).rejects.toThrow("visualization_capacity");
  });
  it("requires admitted turn and invocation, partitions retries and deletes only scoped data", async () => {
    const f = fixture();
    for (const missing of [
      { ...context, turnId: undefined },
      { ...context, invocationId: undefined },
    ])
      await expect(
        publishVisualization(
          f.store,
          missing as never,
          content,
          async () => {},
          () => {},
        ),
      ).rejects.toThrow("invalid_visualization");
    const a = await f.create(),
      b = await publishVisualization(
        f.store,
        { ...context, turnId: "different-turn" },
        content,
        async () => {},
        () => {},
      );
    expect(b.id).not.toBe(a.id);
    f.store.deleteThread("wrong", "thread");
    expect(f.store.get("pitcrew", "thread", a.id)).toBeDefined();
    f.store.deleteThread("pitcrew", "thread");
    expect(f.store.list("pitcrew", "thread")).toEqual([]);
  });
  it("captures runtime call identity, returns a tool receipt and rejects revoked active turns", async () => {
    const f = fixture();
    let active = true;
    const frozen = {
      actor: context.actor,
      repositoryId: "pitcrew",
      threadId: "thread",
      turnId: "active-turn",
    };
    const tools = visualizationTools(
      f.store,
      frozen,
      async () => {},
      () => {
        if (!active) throw new VisualizationError("visualization_authority_revoked", 403);
      },
    );
    frozen.threadId = "mutated";
    const execute = tools.tools[0].execute,
      api = { callId: "runtime-call" } as never;
    const result = await execute({ content }, api, {} as never);
    expect(JSON.parse((result!.content![0] as { text: string }).text)).toMatchObject({
      repositoryId: "pitcrew",
      threadId: "thread",
      turnId: "active-turn",
      invocationId: "runtime-call",
    });
    expect(f.store.list("pitcrew", "thread")[0].creatorActor).toBe(context.actor);
    expect((await execute({ content }, api, {} as never))?.content).toEqual(result?.content);
    active = false;
    await expect(execute({ content }, { callId: "revoked" } as never, {} as never)).rejects.toThrow(
      "visualization_authority_revoked",
    );
    expect(f.store.list("pitcrew", "thread")).toHaveLength(1);
  });
});
