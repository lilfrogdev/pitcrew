import { expect, it } from "vite-plus/test";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

it("native SQLite publisher journal persists pending operations, immutable identity, cancellation and chunked bundles", async () => {
  const bundle = await build({ entryPoints: [new URL("../test/trusted-publisher-worker.ts", import.meta.url).pathname],
    bundle: true, write: false, format: "esm", platform: "browser", external: ["cloudflare:*"], });
  const options = { modules: true as const, script: bundle.outputFiles[0].text,
    compatibilityDate: "2026-10-03", cf: false,
    durableObjects: { JOURNAL: { className: "PublisherJournalFixture", useSQLite: true } },
    resourcePersistencePath: `/tmp/pitcrew-publisher-journal-${crypto.randomUUID()}` };
  const mf = new Miniflare(convertV4MiniflareOptions(options));
  const request = async (operation: string, id: string, data: Record<string, string> = {}) =>
    (await mf.dispatchFetch("http://fixture/", { method: "POST", body: JSON.stringify({ operation, id, ...data }) })).json() as
      Promise<{ claimed?: boolean; error?: string; record?: { state: string; cancelled: boolean }; bundle?: string; cancelled?: boolean }>;
  try {
    const claims = await Promise.all([request("claim", "one"), request("claim", "one")]);
    expect(claims.filter((claim) => claim.claimed)).toHaveLength(1);
    expect(await request("claim", "two")).toMatchObject({ error: "PUBLISHER_BUSY_RECONCILIATION" });
    const encoded = "safe-inert-bundle-data".repeat(10_000);
    expect(await request("bundle", "one", { bundle: encoded })).toEqual({ bundle: encoded });
    expect(await request("bundle", "one", { bundle: "spoof" })).toMatchObject({ error: "PUBLISHER_REPLAY_CONFLICT" });
    expect(await request("mutate", "one")).toMatchObject({ error: "PUBLISHER_IDENTITY_IMMUTABLE" });
    await request("cancel", "one");
    expect(await request("uncancel", "one")).toMatchObject({ error: "PUBLISHER_CANCELLED" });
    await mf.setOptions(convertV4MiniflareOptions({ ...options, script: options.script + "\n// reload" }));
    expect(await request("claim", "one")).toMatchObject({ claimed: false, record: { state: "pending", cancelled: true } });
    expect(await request("claim", "two")).toMatchObject({ error: "PUBLISHER_BUSY_RECONCILIATION" });
    expect(await request("bundle", "one", { bundle: encoded })).toEqual({ bundle: encoded });
    await request("complete", "one");
    expect(await request("claim", "two")).toMatchObject({ claimed: true });
  } finally { await mf.dispose(); }
}, 30_000);
