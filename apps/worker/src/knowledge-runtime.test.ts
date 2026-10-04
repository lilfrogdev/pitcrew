import { expect, it } from "vite-plus/test";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
async function fixtureOptions(bindings: Record<string, string>) {
  const bundle = await build({
    entryPoints: [new URL("../test/knowledge-worker.ts", import.meta.url).pathname],
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
  const script = bundle.outputFiles[0].text;
  const options = {
    telemetry: { enabled: false },
    cf: false,
    modules: true,
    script,
    compatibilityDate: "2026-10-03",
    compatibilityFlags: ["nodejs_compat"],
    bindings,
    durableObjects: {
      FIXTURE: { className: "KnowledgeChangeAgent", useSQLite: true },
      REPOSITORY: { className: "KnowledgeReceiver", useSQLite: true },
    },
    resourcePersistencePath: `/tmp/pitcrew-knowledge-runtime-${crypto.randomUUID()}`,
  };
  return options;
}
interface Row {
  id: string;
  body: string;
  ack?: string | null;
  attempts?: number;
  recorded?: { knowledge: { status: string; actor: { kind: string } } }[];
  current?: { status: string }[];
}
it("recovers actual ChangeAgent delivery jobs after remote commit/lost ack and repeated DO SQLite restart", async () => {
  const options = await fixtureOptions({
    PAUSE_ACK: "1",
    MODEL_CONFIGURATION: '{"provider":"fake"}',
    EXECUTION_MODE: "fake",
  });
  const mf = new Miniflare(convertV4MiniflareOptions(options));
  const rows = async (path: string) =>
    (await (await mf.dispatchFetch(`http://fixture/${path}`)).json()) as Row[];
  const waitFor = async (path: string, accept: (rows: Row[]) => boolean) => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const result = await rows(path);
      if (accept(result)) return result;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw Error("fixture_timeout");
  };
  try {
    const queued = await mf.dispatchFetch("http://fixture/queue");
    expect(queued.status).toBe(200);
    expect(await queued.json()).toMatchObject({
      queued: true,
      checkpoint: {
        status: "current",
        currentKnowledge: {
          entries: expect.arrayContaining([
            expect.objectContaining({ id: "concurrent-constraint", status: "accepted" }),
          ]),
        },
      },
    });
    const committed = await waitFor("receiver", (rows) => (rows[0]?.attempts ?? 0) > 0);
    expect(await rows("worker")).toMatchObject([{ id: committed[0].id, ack: null }]);
    expect(committed[0].recorded).toHaveLength(1);
    expect(committed[0].recorded![0].knowledge).toMatchObject({
      status: "proposed",
      actor: { kind: "worker" },
    });
    expect(committed[0].current).toMatchObject([{ status: "proposed" }]);
    for (let restart = 1; restart <= 2; restart++) {
      const previous = (await rows("receiver"))[0].attempts!;
      await mf.setOptions(
        convertV4MiniflareOptions({
          ...options,
          script: options.script + `\n// restart ${restart}`,
        }),
      );
      await rows("worker"); // Wake the recreated owner so lifecycle recovery can drain its durable outbox.
      const recovered = await waitFor("receiver", (rows) => (rows[0]?.attempts ?? 0) > previous);
      expect(recovered).toHaveLength(1);
      expect(recovered[0].body).toBe(committed[0].body);
      expect((await rows("worker"))[0].ack).toBeNull();
    }
    await mf.setOptions(
      convertV4MiniflareOptions({
        ...options,
        bindings: { MODEL_CONFIGURATION: '{"provider":"fake"}', EXECUTION_MODE: "fake" },
        script: options.script + "\n// ack restored",
      }),
    );
    const acknowledged = await waitFor("worker", (rows) => !!rows[0]?.ack);
    expect(JSON.parse(acknowledged[0].ack!)).toEqual({
      eventId: committed[0].id,
      status: "duplicate",
    });
    const count = (await rows("receiver"))[0].attempts!;
    await mf.setOptions(
      convertV4MiniflareOptions({
        ...options,
        bindings: { MODEL_CONFIGURATION: '{"provider":"fake"}', EXECUTION_MODE: "fake" },
        script: options.script + "\n// acknowledged restart",
      }),
    );
    expect((await rows("worker"))[0].ack).toBe(acknowledged[0].ack);
    expect((await rows("receiver"))[0].attempts).toBe(count);
  } finally {
    await mf.dispose();
  }
}, 30000);
