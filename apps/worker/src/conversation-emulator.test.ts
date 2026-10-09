import { localHeaders } from "../test/local-session";
import { expect, it } from "vite-plus/test";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
it("executes a durable repo Pi conversation through the real DO lifecycle and survives restart", async () => {
  const bundle = await build({
    entryPoints: [new URL("./index.ts", import.meta.url).pathname],
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
    },
    durableObjects: {
      REPOSITORY: { className: "RepositoryAgent", useSQLite: true },
      CONVERSATION: { className: "RepoConversationAgent", useSQLite: true },
    },
    resourcePersistencePath: `/tmp/pitcrew-conversation-${crypto.randomUUID()}`,
  };
  const mf = new Miniflare(convertV4MiniflareOptions(options));
  const get = async (path: string) =>
    (await mf.dispatchFetch(`http://localhost/api${path}`)).json() as Promise<any>;
  const post = async (path: string, body: unknown) =>
    mf.dispatchFetch(`http://localhost/api${path}`, {
      method: "POST",
      headers: await localHeaders(mf),
      body: JSON.stringify(body),
    });
  try {
    const thread = (await (
      await post("/projects/pitcrew/threads", { title: "Conversation", idempotencyKey: "thread" })
    ).json()) as any;
    const receipt = (await (
      await post(`/threads/${thread.id}/messages`, {
        destination: "agent",
        content: "Explain the architecture",
        idempotencyKey: "question",
      })
    ).json()) as any;
    expect(receipt.run).toBeUndefined();
    expect(receipt.turn.status).toBe("queued");
    let turns: any[] = [];
    for (let attempt = 0; attempt < 60; attempt++) {
      turns = await get(`/threads/${thread.id}/turns`);
      if (["completed", "failed"].includes(turns[0].status)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(turns[0].status).toBe("completed");
    expect(await get(`/threads/${thread.id}/runs`)).toEqual([]);
    const messages = await get(`/threads/${thread.id}/messages`);
    expect(messages).toHaveLength(2);
    expect(messages[1].role).toBe("coordinator");
    await mf.setOptions(
      convertV4MiniflareOptions({
        ...options,
        script: options.script + "\n// reload conversation",
      }),
    );
    expect(await get(`/threads/${thread.id}/messages`)).toEqual(messages);
    const replay = (await (
      await post(`/threads/${thread.id}/messages`, {
        destination: "agent",
        content: "Explain the architecture",
        idempotencyKey: "question",
      })
    ).json()) as any;
    expect(replay.turn.id).toBe(receipt.turn.id);
    expect(await get(`/threads/${thread.id}/messages`)).toEqual(messages);
  } finally {
    await mf.dispose();
  }
}, 20000);
