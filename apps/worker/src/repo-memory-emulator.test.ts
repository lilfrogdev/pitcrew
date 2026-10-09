import { expect, it } from "vite-plus/test";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { localHeaders } from "../test/local-session";

/** A valid 1px PNG with an ancillary text chunk, safely above the text context cap. */
function largeSyntheticPng() {
  const original = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
    "base64",
  );
  const data = Buffer.concat([Buffer.from("fixture\0"), Buffer.alloc(262144, 120)]);
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length);
  chunk.write("tEXt", 4);
  data.copy(chunk, 8);
  let crc = 0xffffffff;
  for (const byte of chunk.subarray(4, -4)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4);
  return Buffer.concat([original.subarray(0, -12), chunk, original.subarray(-12)]).toString(
    "base64",
  );
}

async function emulator(memoryEnabled = true, held = true) {
  const bundle = await build({
    entryPoints: [new URL("../test/repo-memory-worker.ts", import.meta.url).pathname],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    conditions: ["workerd", "worker", "browser"],
    external: ["cloudflare:*", "node:*"],
    plugins: [
      {
        name: "node-path",
        setup(build) {
          build.onResolve({ filter: /^path$/ }, () => ({
            path: "path",
            namespace: "node-builtins",
          }));
          build.onLoad({ filter: /.*/, namespace: "node-builtins" }, () => ({
            contents: "export * from 'node:path';",
          }));
        },
      },
    ],
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
      FIXTURE_IDENTITY: "lilfrogdev",
      ...(memoryEnabled ? { REPO_MEMORY_ENABLED: "true" } : {}),
    },
    durableObjects: {
      REPOSITORY: { className: "MemoryRepositoryFixture", useSQLite: true },
      CONVERSATION: {
        className: held ? "HeldMemoryConversation" : "RepoConversationAgent",
        useSQLite: true,
      },
    },
    resourcePersistencePath: `/tmp/pitcrew-repo-memory-${crypto.randomUUID()}`,
  };
  const mf = new Miniflare(convertV4MiniflareOptions(options));
  const call = async (operation: string, extra: Record<string, unknown> = {}) => {
    const response = await mf.dispatchFetch("http://localhost/fixture/memory", {
      method: "POST",
      body: JSON.stringify({ operation, ...extra }),
    });
    const parsed = (await response.json()) as any;
    return { status: response.status, result: parsed.result, error: parsed.error };
  };
  let reloads = 0;
  const reload = async () =>
    mf.setOptions(
      convertV4MiniflareOptions({
        ...options,
        script: options.script + `\n// memory restart ${++reloads}`,
      }),
    );
  return { mf, call, reload };
}

it("uses current destination ACLs for persisted main memory, cached tools and frozen worker briefs across restart", async () => {
  const { mf, call, reload } = await emulator();
  try {
    const seeded = await call("seed", { shared: true });
    expect(seeded.status).toBe(200);
    const identity = seeded.result;
    const fresh = await call("fresh", identity);
    expect(fresh.status).toBe(200);
    expect(JSON.stringify(fresh.result.memoryBrief)).toContain("duplicate billing");
    const cached = await call("search", {
      ...identity,
      callId: "private-source",
      query: "duplicate billing",
    });
    expect(cached.status).toBe(200);
    expect(JSON.stringify(cached.result)).toContain("duplicate billing");
    const original = await call("snapshot");
    await call("sync", identity);
    expect((await call("snapshot")).result.repo_memory_sources).toEqual(
      original.result.repo_memory_sources,
    );
    const brief = await call("brief", identity);
    expect(brief.status).toBe(200);
    expect(JSON.stringify(brief.result.memoryBrief)).toContain("duplicate billing");
    await reload();
    expect((await call("snapshot")).result.repo_memory_sources).toEqual(
      original.result.repo_memory_sources,
    );
    const replay = await call("search", {
      ...identity,
      callId: "private-source",
      query: "duplicate billing",
    });
    expect(replay.result).toEqual(cached.result);
    const changed = await call("search", {
      ...identity,
      callId: "private-source",
      query: "Cancel",
    });
    expect(changed.status).toBe(409);
    await call("membership", { ...identity, bobCanRead: false });
    for (const operation of ["fresh", "brief", "search"]) {
      const denied = await call(operation, {
        ...identity,
        callId: "private-source",
        query: "duplicate billing",
      });
      expect(JSON.stringify(denied)).not.toContain("duplicate billing");
      expect(denied.status).toBe(409);
    }
    await reload();
    const deniedAfterRestart = await call("fresh", identity);
    expect(deniedAfterRestart.status).toBe(409);
    expect(JSON.stringify(deniedAfterRestart)).not.toContain("duplicate billing");
    expect((await call("snapshot")).result.repo_memory_sources).toEqual(
      original.result.repo_memory_sources,
    );
  } finally {
    await mf.dispose();
  }
}, 30000);

it("excludes private sources from a shared destination and persists model/tool budgets across restart", async () => {
  const { mf, call, reload } = await emulator();
  try {
    const seeded = await call("seed", { shared: false });
    expect(seeded.status).toBe(200);
    const identity = seeded.result;
    const fresh = await call("fresh", identity);
    expect(fresh.status).toBe(200);
    expect(JSON.stringify(fresh.result.memoryBrief)).not.toContain("duplicate billing");
    const seen = await call("view", { ...identity, callId: "view-one" });
    expect(seen.status).toBe(200);
    expect(JSON.stringify(seen.result)).not.toContain("duplicate billing");
    const beforeReplay = (await call("snapshot")).result.repo_memory_turns;
    await reload();
    expect((await call("view", { ...identity, callId: "view-one" })).result).toEqual(seen.result);
    expect((await call("snapshot")).result.repo_memory_turns).toEqual(beforeReplay);
    let tools = 0;
    for (; tools < 40; tools++) {
      const result = await call("view", { ...identity, callId: `bounded-${tools}` });
      if (result.status === 409) break;
    }
    expect(tools).toBeLessThan(32);
    expect(tools).toBeGreaterThan(0);
    await reload();
    expect((await call("view", { ...identity, callId: "after-tool-budget" })).status).toBe(409);
    let dispatches = 0;
    for (; dispatches < 20; dispatches++) {
      if ((await call("authorize", identity)).status === 409) break;
    }
    expect(dispatches).toBe(16);
    await reload();
    expect((await call("authorize", identity)).status).toBe(409);
  } finally {
    await mf.dispose();
  }
}, 30000);

it("runs the actual main Pi lifecycle with bounded historical context and keeps its raw journal through restart", async () => {
  const { mf, call, reload } = await emulator(true, false);
  const post = async (path: string, body: unknown) =>
    mf.dispatchFetch(`http://localhost/api${path}`, {
      method: "POST",
      headers: await localHeaders(mf),
      body: JSON.stringify(body),
    });
  const get = async (path: string) =>
    (await mf.dispatchFetch(`http://localhost/api${path}`)).json() as Promise<any>;
  try {
    const seeded = await call("long-history");
    expect(seeded.status).toBe(200);
    const threadId = seeded.result.threadId;
    const input = {
      destination: "agent",
      content: "Explain safe import retry behavior",
      idempotencyKey: "bounded-turn",
    };
    const response = await post(`/threads/${threadId}/messages`, input);
    expect(response.status).toBe(201);
    const queued = (await response.json()) as any;
    let turns: any[] = [];
    for (let attempt = 0; attempt < 100; attempt++) {
      turns = await get(`/threads/${threadId}/turns`);
      if (["completed", "failed"].includes(turns[0].status)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(turns[0].status).toBe("completed");
    const admitted = (await call("admitted", { turnId: queued.turn.id })).result;
    expect(admitted.messages).toHaveLength(1);
    expect(admitted.messages[0].content).toBe(input.content);
    expect(admitted.memoryBrief.items.length).toBeGreaterThan(0);
    expect(await get(`/threads/${threadId}/runs`)).toEqual([]);
    const messages = await get(`/threads/${threadId}/messages`);
    expect(messages).toHaveLength(42);
    expect(messages[0].content).toContain("Incident 0");
    expect(messages[39].content).toContain("Incident 39");
    const snapshot = (await call("snapshot")).result;
    expect(snapshot.repo_memory_sources.length).toBeGreaterThanOrEqual(41);
    const raw = JSON.stringify(snapshot.repo_memory_sources);
    expect(raw).toContain("Incident 0");
    expect(raw).toContain("Incident 39");
    await reload();
    expect(await get(`/threads/${threadId}/messages`)).toEqual(messages);
    expect((await call("snapshot")).result.repo_memory_sources).toEqual(
      snapshot.repo_memory_sources,
    );
    const replay = (await (await post(`/threads/${threadId}/messages`, input)).json()) as any;
    expect(replay.turn.id).toBe(queued.turn.id);
    expect(await get(`/threads/${threadId}/messages`)).toEqual(messages);
    const second = (await (
      await post(`/threads/${threadId}/messages`, {
        destination: "agent",
        content: "Use the earlier retry discussion to explain its impact",
        idempotencyKey: "continuation",
      })
    ).json()) as any;
    for (let attempt = 0; attempt < 100; attempt++) {
      turns = await get(`/threads/${threadId}/turns`);
      if (["completed", "failed"].includes(turns[1].status)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(turns[1].status).toBe("completed");
    const continued = (await call("admitted", { turnId: second.turn.id })).result;
    expect(continued.messages).toHaveLength(1);
    const continuedRaw = JSON.stringify((await call("snapshot")).result.repo_memory_sources);
    expect(continuedRaw).toContain("Explain safe import retry behavior");
    expect(continuedRaw).toContain("Development fixture");
    expect(await get(`/threads/${threadId}/messages`)).toHaveLength(44);
  } finally {
    await mf.dispose();
  }
}, 30000);

it("delivers a large admitted native image without charging its base64 as memory text and preserves its budget through restart", async () => {
  const { mf, call, reload } = await emulator(true, false);
  try {
    const seeded = await call("long-history");
    const threadId = seeded.result.threadId;
    const image = largeSyntheticPng();
    const input = {
      destination: "agent",
      content: "Explain this synthetic image and the earlier retry incidents",
      idempotencyKey: "native-image",
      attachments: [
        { id: "large-image", name: "synthetic.png", mediaType: "image/png", data: image },
      ],
    };
    const post = async () =>
      mf.dispatchFetch(`http://localhost/api/threads/${threadId}/messages`, {
        method: "POST",
        headers: await localHeaders(mf),
        body: JSON.stringify(input),
      });
    const response = await post();
    expect(response.status).toBe(201);
    const queued = (await response.json()) as any;
    let turns: any[] = [];
    for (let attempt = 0; attempt < 100; attempt++) {
      turns = (await (
        await mf.dispatchFetch(`http://localhost/api/threads/${threadId}/turns`)
      ).json()) as any[];
      if (["completed", "failed"].includes(turns[0].status)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(turns[0].status).toBe("completed");
    const snapshot = (await call("snapshot")).result;
    const budget = snapshot.repo_memory_turn_context.find(
      (row: any) => row.turn_id === queued.turn.id,
    );
    expect(budget.native_input_bytes).toBeGreaterThan(196608);
    expect(budget.input_bytes).toBeLessThan(196608);
    const raw = JSON.stringify(snapshot.repo_memory_sources);
    expect(raw).toContain("large-image");
    expect(raw).not.toContain(image);
    await reload();
    const replay = await post();
    expect(replay.status).toBe(201);
    expect(((await replay.json()) as any).turn.id).toBe(queued.turn.id);
    const restarted = (await call("snapshot")).result;
    expect(restarted.repo_memory_sources).toEqual(snapshot.repo_memory_sources);
    expect(restarted.repo_memory_turn_context).toEqual(snapshot.repo_memory_turn_context);
  } finally {
    await mf.dispose();
  }
}, 30000);

it("retains ordinary full-history admission when the memory gate is absent", async () => {
  const { mf, call } = await emulator(false, false);
  try {
    const seeded = await call("long-history");
    const response = await mf.dispatchFetch(
      `http://localhost/api/threads/${seeded.result.threadId}/messages`,
      {
        method: "POST",
        headers: await localHeaders(mf),
        body: JSON.stringify({
          destination: "agent",
          content: "Explain import retries",
          idempotencyKey: "memory-off",
        }),
      },
    );
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: "conversation_context_limit" });
    const snapshot = (await call("snapshot")).result;
    expect(snapshot.repo_memory_sources ?? []).toEqual([]);
  } finally {
    await mf.dispose();
  }
}, 30000);

it("reauthorizes change retries against the original frozen memory and current source ACLs across restart", async () => {
  const { mf, call, reload } = await emulator();
  try {
    const seeded = await call("seed", { shared: true });
    const identity = seeded.result;
    const original = await call("brief", identity);
    expect(original.status).toBe(200);
    const retry = await call("retry", { ...identity, callId: "authorized-retry" });
    expect(retry.status).toBe(200);
    expect(retry.result.memoryBrief).toEqual(original.result.memoryBrief);
    expect(retry.result.runId).not.toBe(original.result.runId);
    await reload();
    const resumed = await call("retry", {
      ...identity,
      callId: "authorized-after-restart",
      retryActor: "bob",
    });
    expect(resumed.status).toBe(200);
    expect(resumed.result.memoryBrief).toEqual(original.result.memoryBrief);
    expect(resumed.result.credentialActor).toBe("bob");
    await call("membership", { ...identity, bobCanRead: false });
    const denied = await call("retry", { ...identity, callId: "revoked-retry" });
    expect(denied.status).toBe(409);
    expect(JSON.stringify(denied)).not.toContain("duplicate billing");
    await reload();
    const deniedAfterRestart = await call("retry", { ...identity, callId: "revoked-retry" });
    expect(deniedAfterRestart.status).toBe(409);
    expect(JSON.stringify(deniedAfterRestart)).not.toContain("duplicate billing");
  } finally {
    await mf.dispose();
  }
}, 30000);

it("fences later queued requests out of the current main turn memory", async () => {
  const { mf, call, reload } = await emulator();
  try {
    const seeded = await call("seed", { shared: true, queuedFuture: true });
    expect(seeded.status).toBe(200);
    const identity = seeded.result;
    const fresh = await call("fresh", identity);
    expect(fresh.status).toBe(200);
    expect(JSON.stringify(fresh.result)).not.toContain("FUTURE_ONLY_B_COMMAND");
    const found = await call("search", {
      ...identity,
      callId: "future-fence",
      query: "FUTURE_ONLY_B_COMMAND",
    });
    expect(found.status).toBe(200);
    expect(found.result.items).toEqual([]);
    await reload();
    const replay = await call("search", {
      ...identity,
      callId: "future-fence",
      query: "FUTURE_ONLY_B_COMMAND",
    });
    expect(replay.status).toBe(200);
    expect(replay.result.items).toEqual([]);
  } finally {
    await mf.dispose();
  }
}, 30000);
