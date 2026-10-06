import { privateProviderStream } from "./openrouter-models";
import { createAssistantMessageEventStream, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { expect, it } from "vite-plus/test";
import { encryptCredential, decryptCredential } from "./user-credentials";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { generateKeyPair, SignJWT, exportJWK } from "jose";
import { createHash } from "node:crypto";
import { Coordinator, initialState } from "./coordinator";
import { resolveCatalog } from "./model-selection";
const secret = Buffer.alloc(32, 17).toString("base64");
const alice = "sk-or-v1-synthetic_alice_never_live";
const bob = "sk-or-v1-synthetic_bob_never_live";
const base = "https://fixture.pitcrew.test";
const route = "/api/provider-connection/openrouter";
it("uses fresh AES-GCM IVs, authenticates the owner and rejects tampering/wrong encryption keys", async () => {
  const a = await encryptCredential("access:alice", alice, secret),
    b = await encryptCredential("access:alice", alice, secret);
  expect(a.iv).not.toBe(b.iv);
  expect(JSON.stringify(a)).not.toContain(alice);
  expect(await decryptCredential("access:alice", a, secret)).toBe(alice);
  await expect(decryptCredential("access:bob", a, secret)).rejects.toThrow(
    "provider_storage_unavailable",
  );
  await expect(
    decryptCredential("access:alice", { ...a, ciphertext: "A" + a.ciphertext.slice(1) }, secret),
  ).rejects.toThrow("provider_storage_unavailable");
  await expect(
    decryptCredential("access:alice", a, Buffer.alloc(32, 18).toString("base64")),
  ).rejects.toThrow("provider_storage_unavailable");
  for (const invalid of [undefined, "invalid", Buffer.alloc(16).toString("base64")])
    await expect(encryptCredential("access:alice", alice, invalid)).rejects.toThrow(
      "provider_storage_unavailable",
    );
});
it("real SQLite DOs isolate two signed Access users, revoke without fallback, restart durably and sanitize errors", async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "synthetic-test" };
  const token = (sub: string, email: string, expired = false) =>
    new SignJWT({ email })
      .setProtectedHeader({ alg: "RS256", kid: "synthetic-test" })
      .setSubject(sub)
      .setIssuer("https://fixture.cloudflareaccess.com")
      .setAudience("fixture")
      .setIssuedAt()
      .setExpirationTime(expired ? "0s" : "10m")
      .sign(privateKey);
  const tokens = {
    alice: await token("alice", "alice@example.com"),
    bob: await token("bob", "bob@example.com"),
    other: await token("other", "other@example.com"),
    expired: await token("alice", "alice@example.com", true),
  };
  const bundle = await build({
    entryPoints: [new URL("../test/user-credentials-worker.ts", import.meta.url).pathname],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    conditions: ["workerd", "worker", "browser"],
    external: ["cloudflare:*", "node:*"],
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
      EXECUTION_MODE: "cloud",
      INFRASTRUCTURE_ADMISSION_ENABLED: "false",
      CLOUD_CONVERSATION_ENABLED: "false",
      ACCESS_ISSUER: "https://fixture.cloudflareaccess.com",
      ACCESS_AUDIENCE: "fixture",
      ACCESS_HOSTNAME: "fixture.pitcrew.test",
      ACCESS_EMAILS: '["alice@example.com","bob@example.com"]',
      TEST_PUBLIC_JWK: JSON.stringify(jwk),
      CREDENTIAL_ENCRYPTION_KEY: secret,
      MODEL_CONFIGURATION:
        '{"provider":"byok","providerId":"openrouter","model":"qwen/qwen3.8-flash","secretBinding":"OPENROUTER_API_KEY"}',
      OPENROUTER_API_KEY: "synthetic_global_must_never_be_used",
    },
    durableObjects: { USER_CREDENTIALS: { className: "CredentialFixture", useSQLite: true } },
    resourcePersistencePath: `/tmp/pitcrew-credentials-${crypto.randomUUID()}`,
  };
  const mf = new Miniflare(convertV4MiniflareOptions(options));
  const request = async (
    who: keyof typeof tokens,
    path = route,
    body?: unknown,
    extra: Record<string, string> = {},
  ) =>
    mf.dispatchFetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "cf-access-jwt-assertion": tokens[who],
        ...(body === undefined ? {} : { origin: base, "content-type": "application/json" }),
        ...extra,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  try {
    expect((await mf.dispatchFetch(base + route)).status).toBe(403);
    expect((await request("other")).status).toBe(403);
    expect((await request("expired")).status).toBe(403);
    expect(
      (
        await request(
          "alice",
          route,
          { action: "store", key: alice },
          { origin: "https://evil.test" },
        )
      ).status,
    ).toBe(403);
    expect(
      (await request("alice", route, { action: "store", key: alice, actor: "access:bob" })).status,
    ).toBe(400);
    expect((await request("alice", "/api/fixture/runtime")).status).toBe(409);
    expect(
      (await (await request("alice", route, { action: "store", key: alice })).json()) as any,
    ).toMatchObject({ configured: true, executionEnabled: false });
    expect(await (await request("bob")).json()).toMatchObject({ configured: false });
    expect((await request("bob", route, { action: "store", key: bob })).status).toBe(200);
    const a = (await (await request("alice", "/api/fixture/runtime")).json()) as any;
    const b = (await (await request("bob", "/api/fixture/runtime")).json()) as any;
    expect(a.fingerprint).toBe(
      createHash("sha256")
        .update("Bearer " + alice)
        .digest("hex"),
    );
    expect(b.fingerprint).toBe(
      createHash("sha256")
        .update("Bearer " + bob)
        .digest("hex"),
    );
    expect(a.called && b.called).toBe(true);
    expect(await (await request("alice", "/api/fixture/foreign")).json()).toEqual({ denied: true });
    const stored = await (await request("alice", "/api/fixture/ciphertext")).text();
    expect(stored).not.toContain(alice);
    expect(stored).toContain("ciphertext");
    const failed = await (await request("alice", "/api/fixture/runtime?fail")).text();
    expect(failed).not.toContain(alice);
    expect(failed).toContain("provider_request_failed");
    await mf.setOptions(
      convertV4MiniflareOptions({ ...options, script: options.script + "\n// cold restart" }),
    );
    expect(await (await request("alice")).json()).toMatchObject({ configured: true });
    expect((await request("alice", route, { action: "remove" })).status).toBe(200);
    expect((await request("alice", route, { action: "remove" })).status).toBe(200);
    expect((await request("alice", "/api/fixture/runtime")).status).toBe(409);
    expect(await (await request("bob")).json()).toMatchObject({ configured: true });
    expect((await request("bob", "/api/fixture/runtime")).status).toBe(200);
    await request("bob", "/api/fixture/corrupt", {});
    const corrupt = await request("bob");
    expect(corrupt.status).toBe(503);
    expect(await corrupt.json()).toEqual({ error: "provider_storage_unavailable" });
    await mf.setOptions(
      convertV4MiniflareOptions({
        ...options,
        bindings: { ...options.bindings, CREDENTIAL_ENCRYPTION_KEY: "" },
      }),
    );
    expect(await (await request("alice")).json()).toMatchObject({
      configured: false,
      storageAvailable: false,
    });
    expect((await request("alice", route, { action: "store", key: alice })).status).toBe(503);
  } finally {
    await mf.dispose();
  }
}, 30000);
it("freezes initiating identities for queued turns, delegated work, direct runs and retries across coordinator restart", () => {
  const state = initialState();
  let id = 0;
  const core = new Coordinator(
    state,
    () => {},
    () => new Date().toISOString(),
    () => String(++id),
  );
  const thread = core.createThread("shared", "thread");
  const catalog = resolveCatalog({ MODEL_CONFIGURATION: '{"provider":"fake"}' });
  const turn = core.queueTurn(thread.id, "do work", "turn", "access:alice", catalog).turn;
  expect(core.beginConversation(turn.id)!.credentialActor).toBe("access:alice");
  const delegated = core.delegateConversation(turn.id);
  core.fail(delegated.id);
  const retry = core.retryChange(delegated.changeId!, "retry", catalog, "access:bob");
  const direct = core.submit(thread.id, "another change", "direct", "access:alice").run;
  const sameKeyOtherUser = core.submit(thread.id, "another change", "direct", "access:bob").run;
  expect(sameKeyOtherUser.id).not.toBe(direct.id);
  expect(core.state.credentialActors?.[sameKeyOtherUser.id]).toBe("access:bob");
  const resumed = new Coordinator(structuredClone(state), () => {});
  expect(resumed.begin(retry.id)!.credentialActor).toBe("access:bob");
  expect(resumed.begin(direct.id)!.credentialActor).toBe("access:alice");
  expect(core.begin(delegated.id)).toBeUndefined();
  expect(core.state.credentialActors?.[delegated.id]).toBe("access:alice");
});

it("worker and reviewer native lifecycle consume the frozen user's key and retain admission after restart", async () => {
  const bundle = await build({
    entryPoints: [new URL("../test/model-admission-worker.ts", import.meta.url).pathname],
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
          build.onResolve({ filter: /^path$/ }, () => ({ path: "node:path", external: true }));
        },
      },
    ],
  });
  const modelConfiguration = {
    provider: "byok",
    providerId: "openrouter",
    model: "qwen/qwen3.8-flash",
    secretBinding: "OPENROUTER_API_KEY",
  };
  const options = {
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
      TEST_ADMISSION_DEADLINE: String(Date.now() + 120000),
      TEST_CREDENTIAL_ACTOR: "access:alice",
      CREDENTIAL_ENCRYPTION_KEY: secret,
      MODEL_CONFIGURATION: JSON.stringify(modelConfiguration),
      MODELS_CONFIGURATION: JSON.stringify([
        {
          id: "alternate",
          configuration: { ...modelConfiguration, model: "deepseek/deepseek-v4-flash-0731" },
        },
      ]),
      OPENROUTER_API_KEY: "synthetic_global_must_never_be_used",
    },
    durableObjects: {
      CHANGE: { className: "ModelChangeFixture", useSQLite: true },
      REVIEW: { className: "ModelReviewFixture", useSQLite: true },
      USER_CREDENTIALS: { className: "UserCredentials", useSQLite: true },
    },
    resourcePersistencePath: `/tmp/pitcrew-user-admission-${crypto.randomUUID()}`,
  };
  const mf = new Miniflare(convertV4MiniflareOptions(options));
  try {
    await mf.dispatchFetch("http://fixture/save");
    const expected = createHash("sha256").update(alice).digest("hex");
    const worker = (await (await mf.dispatchFetch("http://fixture/change")).json()) as any;
    const reviewer = (await (await mf.dispatchFetch("http://fixture/review")).json()) as any;
    expect(worker.fingerprint).toBe(expected);
    expect(reviewer.fingerprint).toBe(expected);
    await mf.setOptions(
      convertV4MiniflareOptions({ ...options, script: options.script + "\n// cold restart" }),
    );
    expect(
      ((await (await mf.dispatchFetch("http://fixture/change")).json()) as any).fingerprint,
    ).toBe(expected);
    expect(
      ((await (await mf.dispatchFetch("http://fixture/review")).json()) as any).fingerprint,
    ).toBe(expected);
  } finally {
    await mf.dispose();
  }
}, 30000);

it("sanitizes all provider error metadata and always terminates abnormal provider streams", async () => {
  const source = createAssistantMessageEventStream();
  source.push({
    type: "error",
    reason: "error",
    error: {
      ...fauxAssistantMessage("", { stopReason: "error", errorMessage: alice }),
      responseId: alice,
      responseModel: alice,
      rawStopReason: alice,
    },
  });
  source.end();
  const result = await privateProviderStream(source, alice).result();
  expect(JSON.stringify(result)).not.toContain(alice);
  expect(result.errorMessage).toBe("provider_request_failed");
  for (const broken of [
    {
      async *[Symbol.asyncIterator]() {
        yield await Promise.reject<never>(Error(alice));
      },
    },
    { async *[Symbol.asyncIterator]() {} },
  ]) {
    const result = await privateProviderStream(broken, alice).result();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe("provider_request_failed");
  }
});
