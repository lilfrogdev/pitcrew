import { expect, it } from "vite-plus/test";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
it("SQLite admission admits one concurrent request and persists reservations after runtime reload", async () => {
  const bundle = await build({
    entryPoints: [new URL("../test/admission-worker.ts", import.meta.url).pathname],
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
    durableObjects: { ADMISSION: { className: "AdmissionFixture", useSQLite: true } },
    resourcePersistencePath: `/tmp/pitcrew-admission-${crypto.randomUUID()}`,
  };
  const mf = new Miniflare(convertV4MiniflareOptions(options));
  const request = async (operation: string, id: string) =>
    (
      await mf.dispatchFetch("http://fixture/", {
        method: "POST",
        body: JSON.stringify({ operation, id }),
      })
    ).json() as Promise<{ allowed?: boolean; reason?: string }>;
  try {
    const simultaneous = await Promise.all([request("reserve", "one"), request("reserve", "two")]);
    expect(simultaneous.filter((item) => item.allowed)).toHaveLength(1);
    const first = simultaneous[0].allowed ? "one" : "two",
      second = first === "one" ? "two" : "one";
    await mf.setOptions(
      convertV4MiniflareOptions({ ...options, script: options.script + "\n// reload" }),
    );
    expect(await request("reserve", second)).toMatchObject({ allowed: false, reason: "busy" });
    expect(await request("reserve", first)).toMatchObject({ allowed: true });
    await request("release", first);
    expect(await request("reserve", first)).toMatchObject({
      allowed: false,
      reason: "already_finished",
    });
    expect(await request("reserve", second)).toMatchObject({ allowed: true });
  } finally {
    await mf.dispose();
  }
}, 30000);
