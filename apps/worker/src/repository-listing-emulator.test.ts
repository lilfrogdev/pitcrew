import { expect, it } from "vite-plus/test";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { generateKeyPair, SignJWT, exportJWK } from "jose";

it("signed users list metadata with lifecycle disabled while every write remains disabled, including after initialization", async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "listing-test" };
  const base = "https://fixture.pitcrew.test";
  const issuer = "https://fixture.cloudflareaccess.com";
  const token = (email: string, expired = false) =>
    new SignJWT({ email })
      .setProtectedHeader({ alg: "RS256", kid: "listing-test" })
      .setSubject(email)
      .setIssuer(issuer)
      .setAudience("listing")
      .setIssuedAt()
      .setExpirationTime(expired ? "0s" : "10m")
      .sign(privateKey);
  const owner = await token("dev@lilfrogdev.com");
  const bryan = await token("bryan.aldair.zamora@gmail.com");
  const other = await token("other@example.com");
  const expired = await token("dev@lilfrogdev.com", true);
  const bundle = await build({
    entryPoints: [new URL("../test/repository-listing-worker.ts", import.meta.url).pathname],
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
      ENVIRONMENT: "production",
      EXECUTION_MODE: "disabled",
      INFRASTRUCTURE_ADMISSION_ENABLED: "false",
      CLOUD_CONVERSATION_ENABLED: "false",
      REPOSITORY_LIFECYCLE: "disabled",
      ACCESS_ISSUER: issuer,
      ACCESS_AUDIENCE: "listing",
      ACCESS_HOSTNAME: "fixture.pitcrew.test",
      ACCESS_EMAILS: '["dev@lilfrogdev.com","bryan.aldair.zamora@gmail.com"]',
      TEST_ARTIFACTS_AVAILABLE: "true",
    },
    durableObjects: { REPOSITORY: { className: "RepositoryListingFixture", useSQLite: true } },
    resourcePersistencePath: `/tmp/pitcrew-repository-listing-${crypto.randomUUID()}`,
    outboundService: (request: Request) => {
      if (request.url !== `${issuer}/cdn-cgi/access/certs`)
        throw Error("unexpected_external_transport");
      return Response.json({ keys: [jwk] });
    },
  };
  const mf = new Miniflare(convertV4MiniflareOptions(options));
  const request = (path: string, method = "GET", jwt = owner, origin = base) =>
    mf.dispatchFetch(base + path, {
      method,
      headers: { "cf-access-jwt-assertion": jwt, origin },
      ...(method === "POST"
        ? {
            body: JSON.stringify({
              name: "sandbox",
              confirmation: "sandbox",
              credentialConsent: true,
              url: "https://github.com/example/repo",
            }),
          }
        : {}),
    });
  const calls = async () => {
    const namespace = await mf.getDurableObjectNamespace("REPOSITORY");
    const stub = namespace.get(namespace.idFromName("pitcrew"));
    return (stub as unknown as { calls(): Promise<string[]> }).calls();
  };
  try {
    // Denial happens before the DO or artifact binding is consulted.
    expect((await mf.dispatchFetch(base + "/api/repositories")).status).toBe(403);
    for (const jwt of [other, expired, "invalid"])
      expect((await request("/api/repositories", "GET", jwt)).status).toBe(403);
    expect(
      (await request("/api/repositories/create", "POST", owner, "https://evil.test")).status,
    ).toBe(403);
    expect(await calls()).toEqual([]);
    // A write must fail both before and after the read initializes the adapter.
    expect((await request("/api/repositories/create", "POST")).status).toBe(503);
    for (const jwt of [owner, bryan]) {
      const response = await request("/api/repositories", "GET", jwt);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      const text = await response.text();
      expect(text).not.toContain("SECRET");
      expect(text).not.toContain("private-id");
      expect(JSON.parse(text)).toEqual({
        repositories: [
          { name: "existing-repo", status: "present", lifecycle: "external", deletable: false },
        ],
        cursor: "next-page",
      });
    }
    const page = await request("/api/repositories?cursor=next-page");
    expect(page.status).toBe(200);
    expect(((await page.json()) as { cursor: string | null }).cursor).toBeNull();
    expect((await request("/api/repositories?cursor=" + "x".repeat(1025))).status).toBe(400);
    const failure = await request("/api/repositories?cursor=fail");
    expect(failure.status).toBe(400);
    expect(await failure.text()).not.toContain("SECRET");
    for (const path of ["", "/create", "/import", "/reconcile", "/delete", "/unknown"])
      for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"])
        expect((await request("/api/repositories" + path, method)).status).toBe(503);
    for (const path of ["/", "/create", "/import", "/reconcile", "/delete"])
      expect((await request("/api/repositories" + path)).status).toBe(503);
    expect(await calls()).toEqual(["list:50:", "list:50:", "list:50:next-page", "list:50:fail"]);
    // Restart with no artifacts binding: signed listing still fails closed.
    await mf.setOptions(
      convertV4MiniflareOptions({
        ...options,
        bindings: { ...options.bindings, TEST_ARTIFACTS_AVAILABLE: "false" },
        script: options.script + "\n// no artifacts binding",
      }),
    );
    const unavailable = await request("/api/repositories");
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({ error: "repository_backend_unavailable" });
    expect(await calls()).toEqual(["list:50:", "list:50:", "list:50:next-page", "list:50:fail"]);
  } finally {
    await mf.dispose();
  }
}, 30000);
