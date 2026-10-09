import { expect, it } from "vite-plus/test";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

it("actual implementer and reviewer factories retain ordinary SDK compaction and omit MAIN memory tools", async () => {
  const agentsPath = new URL("./pi-agents.ts", import.meta.url).pathname;
  const defaultsPath = new URL(
    "../node_modules/@earendil-works/pi-durable/dist/harness/agent.js",
    import.meta.url,
  ).pathname;
  const script = `
    import { ChangeAgent, ReviewAgent } from ${JSON.stringify(agentsPath)};
    import { resolveSettings } from ${JSON.stringify(defaultsPath)};
    function capture(owner, args) {
      const settings = resolveSettings(args[1].settings);
      const snapshot = args[1].registry.snapshot();
      owner.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS factory_audit(value TEXT)");
      owner.ctx.storage.sql.exec("INSERT INTO factory_audit VALUES(?)", JSON.stringify({
        compaction: settings.compaction,
        extensions: snapshot.installed().map(extension => extension.name),
        tools: snapshot.tools().map(entry => entry.tool.name),
      }));
      return Promise.resolve({
        root: async () => ({ configure: async () => {} }),
        resume() {},
        inspect: async () => ({ tasks: [], submissions: [] }),
        conversation: async () => undefined,
        close: async () => {},
      });
    }
    function seed(owner, role) {
      owner.bindModelAdmission(undefined, role, Date.now() + 60000);
      owner.bind({ workspace: { runId: "fixture-run", projectId: "fixture-project", repository: "fixture/repo",
        workerId: "fixture-worker", artifactId: "fixture-artifact", baseSha: "a".repeat(40), configurationRevision: "fixture" } });
    }
    async function audit(owner) {
      await owner.harness.pi();
      return JSON.parse(owner.ctx.storage.sql.exec("SELECT value FROM factory_audit ORDER BY rowid DESC LIMIT 1").toArray()[0].value);
    }
    export class MemoryRoleChangeFixture extends ChangeAgent {
      openHarness(...args) { return capture(this, args); }
      seed() { seed(this, "implementer"); }
      audit() { return audit(this); }
    }
    export class MemoryRoleReviewFixture extends ReviewAgent {
      openHarness(...args) { return capture(this, args); }
      seed() { seed(this, "reviewer"); }
      audit() { return audit(this); }
    }
    export default { async fetch(request, env) {
      const role = new URL(request.url).pathname.slice(1);
      const namespace = role === "implementer" ? env.CHANGE : env.REVIEW;
      const stub = namespace.get(namespace.idFromName("role-fixture"));
      await stub.seed();
      return Response.json(await stub.audit());
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
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      telemetry: { enabled: false },
      cf: false,
      modules: true,
      script: bundle.outputFiles[0].text,
      compatibilityDate: "2026-10-03",
      compatibilityFlags: ["nodejs_compat"],
      bindings: {
        ENVIRONMENT: "development",
        EXECUTION_MODE: "cloud",
        INFRASTRUCTURE_ADMISSION_ENABLED: "true",
        MODEL_CONFIGURATION: '{"provider":"fake"}',
        CONFIGURATION_REVISION: "fixture",
        REPO_MEMORY_ENABLED: "true",
      },
      durableObjects: {
        CHANGE: { className: "MemoryRoleChangeFixture", useSQLite: true },
        REVIEW: { className: "MemoryRoleReviewFixture", useSQLite: true },
      },
      outboundService: () => {
        throw Error("unexpected_external_request");
      },
    }),
  );
  try {
    for (const role of ["implementer", "reviewer"]) {
      const response = await mf.dispatchFetch(`http://fixture/${role}`);
      expect(response.status).toBe(200);
      const audit = (await response.json()) as {
        compaction: object;
        extensions: string[];
        tools: string[];
      };
      expect(audit.compaction).toEqual({
        enabled: true,
        reserveTokens: 16384,
        keepRecentTokens: 20000,
        backgroundTokens: 32768,
      });
      expect(audit.extensions).not.toContain("repository-memory");
      expect(audit.tools.some((tool) => tool.startsWith("memory_"))).toBe(false);
      expect(audit.tools.length).toBeGreaterThan(0);
    }
  } finally {
    await mf.dispose();
  }
}, 30000);
