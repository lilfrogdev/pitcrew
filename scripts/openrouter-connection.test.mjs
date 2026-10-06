import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { createOpenRouterConnectionMiddleware } from "./openrouter-connection.mjs";
import { BACKEND_ACCESS } from "./backend-relay.mjs";
const origin = "http://127.0.0.1:5227";
const route = "/api/provider-connection/openrouter";
const key = "sk-or-v1-synthetic_user_a_never_live";
const status = {
  available: true,
  storageAvailable: true,
  configured: true,
  executionEnabled: false,
};
async function request(handler, path = route, options = {}) {
  const req = Readable.from(options.body === undefined ? [] : [Buffer.from(options.body)]);
  req.url = path;
  req.method = options.method ?? "GET";
  req.headers = { host: new URL(origin).host, ...options.headers };
  req.socket = { localAddress: "127.0.0.1", remoteAddress: "127.0.0.1", ...options.socket };
  req.rawHeaders = options.rawHeaders;
  const result = {};
  await handler(
    req,
    {
      writeHead(code, headers) {
        result.code = code;
        result.headers = headers;
      },
      end(text) {
        result.text = text;
        result.json = JSON.parse(text);
      },
    },
    () => {
      result.next = true;
    },
  );
  return result;
}
function fixture(overrides = {}) {
  const calls = [];
  const handler = createOpenRouterConnectionMiddleware({
    enabled: true,
    userAccessSession: true,
    origin,
    tokenProvider: async () => "synthetic_user_access",
    verifyToken: async () => Math.floor(Date.now() / 1000) + 1800,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return url.endsWith("/api/local-session")
        ? new Response(null, {
            status: 302,
            headers: { location: BACKEND_ACCESS.issuer + "/cdn-cgi/access/login/fixture" },
          })
        : Response.json({ ...status, key });
    },
    ...overrides,
  });
  return { handler, calls };
}
async function session(handler) {
  const res = await request(handler, route + "/session");
  assert.equal(res.code, 200);
  return {
    origin,
    cookie: "pitcrew-backend-nonce=" + res.json.nonce,
    "x-pitcrew-connection-nonce": res.json.nonce,
    "content-type": "application/json",
  };
}
test("defaults fail closed; old Wrangler opt-in grants no storage access", async () => {
  for (const opts of [
    { enabled: false },
    { userAccessSession: false },
    { userAccessSession: undefined, userWranglerAuth: true },
  ]) {
    const f = fixture(opts);
    assert.equal((await request(f.handler)).code, 503);
    assert.equal(f.calls.length, 0);
  }
});
test("provider writes use only current user Access JWT and fixed backend; response strips credential-shaped fields", async () => {
  const f = fixture();
  const headers = await session(f.handler);
  const res = await request(f.handler, route, {
    method: "POST",
    headers: { ...headers, authorization: "injected", "cf-access-jwt-assertion": "forged" },
    body: JSON.stringify({ action: "store", key }),
  });
  assert.equal(res.code, 200);
  assert.deepEqual(res.json, status);
  assert.ok(!res.text.includes(key));
  const call = f.calls.at(-1);
  assert.equal(call.url, BACKEND_ACCESS.origin + route);
  assert.deepEqual(call.init.headers, {
    Accept: "application/json",
    "Cf-Access-Token": "synthetic_user_access",
    Origin: BACKEND_ACCESS.origin,
    "Content-Type": "application/json",
  });
  assert.deepEqual(JSON.parse(call.init.body), { action: "store", key });
  assert.equal(
    (
      await request(f.handler, route, {
        method: "POST",
        headers,
        body: JSON.stringify({ action: "remove" }),
      })
    ).code,
    200,
  );
});
test("rejects forged owner, cross-site, unsafe method/query/body and wrong nonce before network", async () => {
  const f = fixture();
  const headers = await session(f.handler);
  for (const options of [
    { body: JSON.stringify({ action: "store", key, actor: "access:other" }) },
    { body: JSON.stringify({ action: "store", key: "not-a-key" }) },
    { body: JSON.stringify({ action: "read" }) },
    { headers: { ...headers, origin: "https://evil.example" }, body: "{}" },
    { headers: { ...headers, "x-pitcrew-connection-nonce": "wrong" }, body: "{}" },
    { socket: { remoteAddress: "192.0.2.1" }, body: "{}" },
    { rawHeaders: ["Host", new URL(origin).host, "Host", "evil.example"], body: "{}" },
  ]) {
    const res = await request(f.handler, route, { method: "POST", headers, ...options });
    assert.ok(res.code >= 400);
  }
  assert.equal((await request(f.handler, route + "?actor=other")).code, 400);
  assert.equal((await request(f.handler, route, { method: "DELETE" })).code, 405);
  assert.equal(
    (
      await request(f.handler, route, {
        method: "POST",
        headers,
        body: JSON.stringify({ action: "store", key: "x".repeat(9000) }),
      })
    ).code,
    413,
  );
  assert.equal(f.calls.length, 0);
});
test("provider and authentication diagnostics never pass through responses", async () => {
  const f = fixture({
    fetchImpl: async (url) =>
      url.endsWith("/api/local-session")
        ? new Response(null, {
            status: 302,
            headers: { location: BACKEND_ACCESS.issuer + "/cdn-cgi/access/login/fixture" },
          })
        : Response.json({ error: key }, { status: 500 }),
  });
  const res = await request(f.handler);
  assert.equal(res.code, 500);
  assert.deepEqual(res.json, { error: "provider_operation_failed" });
  assert.ok(!res.text.includes(key));
  const denied = fixture({
    verifyToken: async () => {
      throw Error(key);
    },
  });
  assert.equal((await request(denied.handler)).code, 503);
});
test("this helper never relays Work, repositories, arbitrary paths or URLs", async () => {
  const f = fixture();
  for (const path of [
    "/api/projects",
    "/api/threads/x/messages",
    "/api/repositories",
    "//evil.example/api/provider-connection/openrouter",
    "https://evil.example" + route,
  ])
    assert.equal((await request(f.handler, path)).next, true);
  assert.equal(f.calls.length, 0);
});
