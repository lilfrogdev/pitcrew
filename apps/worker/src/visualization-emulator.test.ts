import { expect, it } from "vite-plus/test";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
it("enforces private scoped SQLite capacity and persists immutable records across Cloudflare runtime reload", async () => {
  const bundle = await build({
    entryPoints: [new URL("../test/visualization-worker.ts", import.meta.url).pathname],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    external: ["cloudflare:*"],
  });
  const options = {
    modules: true as const,
    script: bundle.outputFiles[0].text,
    compatibilityDate: "2026-10-03",
    cf: false,
    durableObjects: { VISUALIZATIONS: { className: "VisualizationFixture", useSQLite: true } },
  };
  const mf = new Miniflare(convertV4MiniflareOptions(options));
  const url = "http://fixture/api/projects/repo/threads/thread/visualizations";
  const content = {
    kind: "bars",
    title: "Chart",
    summary: "Two values",
    height: 320,
    points: [{ label: "A", value: 2 }],
  };
  const headers = {
    "x-fixture-actor": "viewer",
    origin: "http://fixture",
    "content-type": "application/json",
  };
  try {
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        mf.dispatchFetch(`http://fixture/fixture/publish/${i}`, {
          method: "POST",
          headers,
          body: JSON.stringify({ key: `key-${i}`, content }),
        }),
      ),
    );
    expect(results.filter((result) => result.status === 201)).toHaveLength(10);
    expect(results.filter((result) => result.status === 429)).toHaveLength(2);
    const before = await (await mf.dispatchFetch(url, { headers })).json();
    await mf.setOptions(
      convertV4MiniflareOptions({ ...options, script: options.script + "\n// reload" }),
    );
    expect(await (await mf.dispatchFetch(url, { headers })).json()).toEqual(before);
    expect((await mf.dispatchFetch(url)).status).toBe(401);
    expect(
      (await mf.dispatchFetch(url.replace("threads/thread", "threads/wrong"), { headers })).status,
    ).toBe(404);
    const malicious = {
      ...content,
      kind: "document",
      points: undefined,
      nodes: [{ tag: "script", children: [{ text: "location='/sentinel'" }] }],
    };
    expect(
      (
        await mf.dispatchFetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify({ key: "hostile", content: malicious }),
        })
      ).status,
    ).toBe(405);
    await mf.dispatchFetch("http://fixture/fixture/revoke");
    expect((await mf.dispatchFetch(url, { headers })).status).toBe(404);
  } finally {
    await mf.dispose();
  }
}, 30000);
