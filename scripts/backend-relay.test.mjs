import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import {
  BACKEND_ACCESS,
  backendRelayPlugin,
  createBackendRelayMiddleware,
  readCachedAccessToken,
  verifyUserAccessToken,
} from "./backend-relay.mjs";
const requireWorker = createRequire(new URL("../apps/worker/package.json", import.meta.url));
const { generateKeyPair, SignJWT } = await import(requireWorker.resolve("jose"));
const origin = "http://127.0.0.1:5219";
const goodPage = {
  repositories: [{ name: "pitcrew-test", lifecycle: "external", deletable: false }],
  cursor: null,
};
function fixture(overrides = {}) {
  const calls = [],
    tokens = [];
  const handler = createBackendRelayMiddleware({
    enabled: true,
    userAccessSession: true,
    origin,
    tokenProvider: async () => {
      tokens.push(true);
      return "synthetic.jwt.signature";
    },
    verifyToken: async () => Math.floor(Date.now() / 1000) + 1800,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return url.endsWith("/api/local-session")
        ? new Response(null, {
            status: 302,
            headers: { location: `${BACKEND_ACCESS.issuer}/cdn-cgi/access/login/backend` },
          })
        : Response.json(goodPage);
    },
    ...overrides,
  });
  return { handler, calls, tokens };
}
async function request(handler, path = "/api/repositories", options = {}) {
  const req = Readable.from(
    options.chunks ?? (options.body === undefined ? [] : [Buffer.from(options.body)]),
  );
  req.url = path;
  req.method = options.method ?? "GET";
  req.headers = { host: new URL(origin).host, ...options.headers };
  req.socket = { localAddress: "127.0.0.1", remoteAddress: "127.0.0.1", ...options.socket };
  req.rawHeaders = options.rawHeaders;
  const result = { status: 0, headers: {}, next: false };
  const res = {
    writeHead(status, headers) {
      result.status = status;
      result.headers = headers;
    },
    end(text) {
      result.text = text;
      result.json = JSON.parse(text);
    },
  };
  await handler(req, res, () => {
    result.next = true;
  });
  return result;
}
async function session(handler) {
  const response = await request(handler, "/api/backend-session");
  assert.equal(response.status, 200);
  return {
    origin,
    cookie: `pitcrew-backend-nonce=${response.json.nonce}`,
    "x-pitcrew-backend-nonce": response.json.nonce,
    "content-type": "application/json",
  };
}
test("both runtime opt-ins default off without token reads or network calls", async () => {
  for (const options of [{ enabled: false }, { userAccessSession: false }]) {
    const f = fixture(options);
    assert.equal((await request(f.handler)).status, 503);
    assert.equal((await request(f.handler, "/api/backend-session")).next, true);
    assert.equal(f.calls.length + f.tokens.length, 0);
  }
});
test("Work/provider APIs and arbitrary URLs never enter the cloud relay", async () => {
  const f = fixture();
  for (const path of [
    "/api/projects",
    "/api/local-session",
    "/api/threads/x/messages",
    "/api/provider-connection/openrouter",
    "https://example.com/api/repositories",
    "//example.com/api/repositories",
  ])
    assert.equal((await request(f.handler, path)).next, true);
  assert.equal(f.calls.length + f.tokens.length, 0);
});
test("exact socket/Host/Origin/fetch-site admission rejects before side effects", async () => {
  const f = fixture();
  for (const options of [
    { socket: { remoteAddress: "192.0.2.1" } },
    { socket: { localAddress: "0.0.0.0" } },
    { headers: { host: "evil.example" } },
    { headers: { origin: "https://evil.example" } },
    { headers: { "sec-fetch-site": "same-site" } },
    { rawHeaders: ["Host", new URL(origin).host, "Host", "evil.example"] },
  ])
    assert.equal((await request(f.handler, "/api/repositories", options)).status, 403);
  assert.equal(f.calls.length + f.tokens.length, 0);
});
test("repository session is private HttpOnly Strict and isolated from Work admission", async () => {
  const f = fixture();
  const first = await request(f.handler, "/api/backend-session");
  assert.match(first.json.nonce, /^[a-f0-9]{64}$/);
  assert.match(first.headers["Set-Cookie"], /HttpOnly; SameSite=Strict; Path=\/api; Max-Age=1800/);
  assert.equal(first.headers["Cache-Control"], "private, no-store");
  const second = await request(f.handler, "/api/backend-session", {
    headers: { cookie: `pitcrew-backend-nonce=${first.json.nonce}` },
  });
  assert.equal(second.json.nonce, first.json.nonce);
  assert.equal(f.calls.length + f.tokens.length, 0);
});
test("mutations require issued nonce, strict Origin and bounded valid JSON", async () => {
  const f = fixture();
  const headers = await session(f.handler);
  const valid = JSON.stringify({ name: "new-test", credentialConsent: true });
  for (const [change, expected] of [
    [{ cookie: "" }, 403],
    [{ origin: undefined }, 403],
    [{ "x-pitcrew-backend-nonce": "é".repeat(64) }, 403],
    [{ "content-type": "text/plain" }, 415],
  ])
    assert.equal(
      (
        await request(f.handler, "/api/repositories/create", {
          method: "POST",
          headers: { ...headers, ...change },
          body: valid,
        })
      ).status,
      expected,
    );
  for (const invalid of [
    "{",
    "[]",
    JSON.stringify({ name: ["new-test"], credentialConsent: true }),
    JSON.stringify({ name: "new-test", credentialConsent: true, key: "synthetic" }),
    JSON.stringify({ name: "new-test", credentialConsent: true, padding: "x".repeat(3000) }),
  ])
    assert.ok(
      [400, 413].includes(
        (
          await request(f.handler, "/api/repositories/create", {
            method: "POST",
            headers,
            body: invalid,
          })
        ).status,
      ),
    );
  assert.equal(f.calls.length + f.tokens.length, 0);
});
test("unsafe import URLs and unconfirmed deletes never reach the backend", async () => {
  const f = fixture(),
    headers = await session(f.handler);
  for (const url of [
    "https://user:password@github.com/a/b",
    "https://github.com/a/b?token=synthetic",
    "https://evil.example/a/b",
  ])
    assert.equal(
      (
        await request(f.handler, "/api/repositories/import", {
          method: "POST",
          headers,
          body: JSON.stringify({ name: "test", credentialConsent: true, url }),
        })
      ).status,
      400,
    );
  assert.equal(
    (
      await request(f.handler, "/api/repositories/delete", {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "test", confirmation: "other" }),
      })
    ).status,
    400,
  );
  assert.equal(f.calls.length + f.tokens.length, 0);
});
test("equivalent GitHub import forms are forwarded once with a canonical source", async () => {
  for (const [url, canonical] of [
    ["https://github.com/example/repo", "https://github.com/example/repo"],
    ["https://github.com/example/repo/", "https://github.com/example/repo"],
    ["https://github.com/example/repo.git/", "https://github.com/example/repo.git"],
    ["HTTPS://GITHUB.COM:443/Example/repo.name/", "https://github.com/Example/repo.name"],
  ]) {
    const forwarded = [];
    const f = fixture({
      fetchImpl: async (target, init) => {
        if (target.endsWith("/api/local-session"))
          return new Response(null, {
            status: 302,
            headers: { location: `${BACKEND_ACCESS.issuer}/cdn-cgi/access/login/backend` },
          });
        forwarded.push({ target, init });
        return Response.json({ name: "test", status: "ready" });
      },
    });
    const headers = await session(f.handler);
    const response = await request(f.handler, "/api/repositories/import", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "test", credentialConsent: true, url }),
    });
    assert.equal(response.status, 200);
    assert.equal(forwarded.length, 1);
    assert.equal(forwarded[0].target, `${BACKEND_ACCESS.origin}/api/repositories/import`);
    assert.deepEqual(JSON.parse(forwarded[0].init.body), {
      name: "test",
      credentialConsent: true,
      url: canonical,
    });
  }
});
test("unsafe or ambiguous GitHub URL syntax never reads a token or reaches the backend", async () => {
  const f = fixture(),
    headers = await session(f.handler);
  for (const url of [
    "https://github.com/owner.name/repo",
    "https://github.com/a/b//",
    "https://github.com/a/../owner/repo",
    "https://github.com/a/%2e%2e/owner/repo",
    "https://github.com/a/%62",
    "https://github.com/a/.",
    "https://github.com/a/..",
    "https://github.com:444/a/b",
    "https://github.com./a/b",
    "https://github.com.evil.example/a/b",
    "https://github.com/a/b?",
    "https://github.com/a/b#",
    "https://github.com/a/b\n",
    " https://github.com/a/b",
    "https://github.com/a\\b",
    "https://user@github.com/a/b",
    "//github.com/a/b",
    "https://github.com/a/" + "b".repeat(512),
    "not a URL",
    null,
  ])
    assert.equal(
      (
        await request(f.handler, "/api/repositories/import", {
          method: "POST",
          headers,
          body: JSON.stringify({ name: "test", credentialConsent: true, url }),
        })
      ).status,
      400,
    );
  assert.equal(f.calls.length + f.tokens.length, 0);
});
test("only bounded single cursor and allowlisted operations are accepted", async () => {
  const f = fixture();
  for (const path of [
    "/api/repositories?token=synthetic",
    "/api/repositories?cursor=a&cursor=b",
    `/api/repositories?cursor=${"x".repeat(1025)}`,
  ])
    assert.equal((await request(f.handler, path)).status, 400);
  assert.equal(
    (await request(f.handler, "/api/repositories/arbitrary", { method: "POST" })).status,
    405,
  );
  assert.equal(f.calls.length + f.tokens.length, 0);
});
test("unprotected or wrong-issuer edge responses prevent even cached token acquisition", async () => {
  for (const response of [
    Response.json({ nonce: null }),
    new Response(null, { status: 404 }),
    new Response(null, { status: 302, headers: { location: "https://evil.example/login" } }),
    new Response(null, { status: 302, headers: { location: `${BACKEND_ACCESS.issuer}/other` } }),
  ]) {
    const f = fixture({ fetchImpl: async () => response });
    assert.equal((await request(f.handler)).status, 503);
    assert.equal(f.tokens.length, 0);
  }
});
test("fixed backend receives only server token and safe headers; response drops credentials", async () => {
  const f = fixture({
    fetchImpl: async (url, init) => {
      f.calls.push({ url, init });
      if (url.endsWith("/api/local-session"))
        return new Response(null, {
          status: 302,
          headers: { location: `${BACKEND_ACCESS.issuer}/cdn-cgi/access/login/backend` },
        });
      return Response.json(
        {
          ...goodPage,
          token: "synthetic-secret",
          repositories: [{ ...goodPage.repositories[0], access_token: "synthetic-secret" }],
        },
        { headers: { "Set-Cookie": "CF_Authorization=synthetic-secret" } },
      );
    },
  });
  const result = await request(f.handler, "/api/repositories?cursor=opaque", {
    headers: {
      cookie: "CF_Authorization=browser-token",
      authorization: "Bearer browser-token",
      "cf-access-jwt-assertion": "browser-token",
      "x-forwarded-user": "evil",
    },
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.json, goodPage);
  assert.equal(result.text.includes("secret"), false);
  assert.equal(result.headers["Set-Cookie"], undefined);
  assert.deepEqual(f.calls[1].init.headers, {
    Accept: "application/json",
    "Cf-Access-Token": "synthetic.jwt.signature",
  });
  assert.equal(f.calls[1].url, `${BACKEND_ACCESS.origin}/api/repositories?cursor=opaque`);
  assert.equal(f.calls[1].init.redirect, "manual");
});
test("approved metadata mutation rewrites Origin to the protected backend", async () => {
  const calls = [];
  const f = fixture({
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return url.endsWith("/api/local-session")
        ? new Response(null, {
            status: 302,
            headers: { location: `${BACKEND_ACCESS.issuer}/cdn-cgi/access/login/backend` },
          })
        : Response.json(
            { name: "new-test", status: "pending", operation: "create", id: "internal" },
            { status: 202 },
          );
    },
  });
  const headers = await session(f.handler);
  const result = await request(f.handler, "/api/repositories/create", {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "new-test", credentialConsent: true }),
  });
  assert.deepEqual(result.json, { name: "new-test", status: "pending" });
  assert.equal(calls[1].init.headers.Origin, BACKEND_ACCESS.origin);
  assert.equal(calls[1].init.headers.Cookie, undefined);
  assert.equal(calls[1].init.headers["X-Pitcrew-Backend-Nonce"], undefined);
});
test("Access redirects are never followed or exposed and clear cached sessions", async () => {
  let remote = 0;
  const f = fixture({
    fetchImpl: async (url) => {
      if (url.endsWith("/api/local-session"))
        return new Response(null, {
          status: 302,
          headers: { location: `${BACKEND_ACCESS.issuer}/cdn-cgi/access/login/backend` },
        });
      remote++;
      return new Response("synthetic-secret", {
        status: 302,
        headers: { location: "https://evil.example/secret" },
      });
    },
  });
  const result = await request(f.handler);
  assert.deepEqual(result.json, { error: "backend_sign_in_required" });
  assert.equal(result.headers.Location, undefined);
  await request(f.handler);
  assert.equal(f.tokens.length, 2);
  assert.equal(remote, 2);
});
test("unexpected diagnostics, oversized JSON and malformed success stay sanitized", async () => {
  for (const response of [
    Response.json({ error: "synthetic-secret" }, { status: 500 }),
    Response.json({ repositories: [], cursor: null, padding: "x".repeat(270000) }),
    new Response("login page", { headers: { "content-type": "text/html" } }),
    Response.json({ repositories: [{ name: { key: "synthetic-secret" } }], cursor: null }),
  ]) {
    const f = fixture({
      fetchImpl: async (url) =>
        url.endsWith("/api/local-session")
          ? new Response(null, {
              status: 302,
              headers: { location: `${BACKEND_ACCESS.issuer}/cdn-cgi/access/login/backend` },
            })
          : response,
    });
    const result = await request(f.handler);
    assert.ok(result.status >= 500);
    assert.equal(result.text.includes("synthetic-secret"), false);
  }
});
test("known repository failures remain actionable without reflecting extra data", async () => {
  const f = fixture({
    fetchImpl: async (url) =>
      url.endsWith("/api/local-session")
        ? new Response(null, {
            status: 302,
            headers: { location: `${BACKEND_ACCESS.issuer}/cdn-cgi/access/login/backend` },
          })
        : Response.json(
            { error: "repository_backend_unavailable", diagnostic: "synthetic-secret" },
            { status: 503 },
          ),
  });
  assert.deepEqual((await request(f.handler)).json, { error: "repository_backend_unavailable" });
});
test("only one mutation can be pending; no automatic write retry", async () => {
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  let writes = 0;
  const f = fixture({
    fetchImpl: async (url) => {
      if (url.endsWith("/api/local-session"))
        return new Response(null, {
          status: 302,
          headers: { location: `${BACKEND_ACCESS.issuer}/cdn-cgi/access/login/backend` },
        });
      writes++;
      await pending;
      return Response.json({ name: "test", status: "ready" });
    },
  });
  const headers = await session(f.handler);
  const options = { method: "POST", headers, body: JSON.stringify({ name: "test" }) };
  const first = request(f.handler, "/api/repositories/reconcile", options);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await request(f.handler, "/api/repositories/reconcile", options)).status, 409);
  release();
  await first;
  assert.equal(writes, 1);
});
test("locally verifies exact RS256 issuer/audience/email and thirty-minute maximum", async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const now = Math.floor(Date.now() / 1000);
  const make = (claims = {}, alg = "RS256") =>
    new SignJWT({
      email: BACKEND_ACCESS.email,
      sub: "synthetic-user",
      iss: BACKEND_ACCESS.issuer,
      aud: BACKEND_ACCESS.audience,
      iat: now,
      exp: now + 1800,
      ...claims,
    })
      .setProtectedHeader({ alg })
      .sign(privateKey);
  assert.equal(await verifyUserAccessToken(await make(), async () => publicKey), now + 1800);
  assert.equal(
    await verifyUserAccessToken(
      await make({ email: "bryan.aldair.zamora@gmail.com" }),
      async () => publicKey,
    ),
    now + 1800,
  );
  for (const claims of [
    { email: "other@example.com" },
    { email: "bryan.aldair.zamora+other@gmail.com" },
    { email: "bryan.aldair.zamora@gmail.com.evil" },
    { aud: "other" },
    { iss: "https://evil.example" },
    { exp: now - 1 },
    { exp: now + 1801 },
    { iat: now + 5 },
    { sub: "" },
  ])
    await assert.rejects(verifyUserAccessToken(await make(claims), async () => publicKey));
});
function childFixture() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.kill = () => {
    child.killed = true;
  };
  return child;
}
test("cached-token command is fixed, no login, token argv/env/log or inherited credentials", async () => {
  const child = childFixture();
  let invocation;
  const result = readCachedAccessToken({
    homeDirectory: "/Users/bryan",
    spawnProcess: (...args) => {
      invocation = args;
      return child;
    },
  });
  child.stdout.emit("data", Buffer.from("synthetic.jwt.signature\n"));
  child.emit("close", 0);
  assert.equal(await result, "synthetic.jwt.signature");
  assert.equal(invocation[0], "/Users/bryan/Library/Application Support/Pitcrew/bin/cloudflared");
  assert.deepEqual(invocation[1], ["access", "token", `--app=${BACKEND_ACCESS.origin}`]);
  assert.deepEqual(invocation[2].env, { HOME: "/Users/bryan", PATH: "/usr/bin:/bin" });
  assert.deepEqual(invocation[2].stdio, ["ignore", "pipe", "ignore"]);
  assert.equal(invocation[2].shell, false);
});
test("oversized child output kills then waits for close without leaking diagnostics", async () => {
  const child = childFixture();
  let settled = false;
  const result = readCachedAccessToken({ spawnProcess: () => child });
  const rejected = assert.rejects(result, /backend_sign_in_required/).then(() => {
    settled = true;
  });
  child.stdout.emit("data", Buffer.from("synthetic-sensitive".repeat(2000)));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(child.killed, true);
  assert.equal(settled, false);
  child.emit("close", null);
  await rejected;
});
test("missing installed helper and empty cache fail closed without auth fallback", async () => {
  await assert.rejects(
    readCachedAccessToken({
      spawnProcess: () => {
        throw Error("synthetic-sensitive");
      },
    }),
    /backend_sign_in_required/,
  );
  const child = childFixture();
  const result = readCachedAccessToken({ spawnProcess: () => child });
  child.emit("close", 1);
  await assert.rejects(result, /backend_sign_in_required/);
});

test("valid first page includes fifty remote plus two hundred quarantined records", async () => {
  const page = {
    repositories: Array.from({ length: 250 }, (_, i) => ({
      name: `repo-${i}`,
      lifecycle: "pending",
      deletable: false,
    })),
    cursor: null,
  };
  const f = fixture({
    fetchImpl: async (url) =>
      url.endsWith("/api/local-session")
        ? new Response(null, {
            status: 302,
            headers: { location: `${BACKEND_ACCESS.issuer}/cdn-cgi/access/login/backend` },
          })
        : Response.json(page),
  });
  assert.equal((await request(f.handler)).json.repositories.length, 250);
  page.repositories.push({ name: "overflow", lifecycle: "pending", deletable: false });
  assert.equal((await request(f.handler)).status, 503);
});
test("plugin admits actual ephemeral listener port and refuses unavailable or wildcard listener", async () => {
  let handler;
  let address = { address: "127.0.0.1", port: 5220 };
  backendRelayPlugin({ enabled: true, userAccessSession: true }).configureServer({
    config: { server: { host: "127.0.0.1", port: 5219 } },
    httpServer: { address: () => address },
    middlewares: {
      use: (value) => {
        handler = value;
      },
    },
  });
  assert.equal(
    (await request(handler, "/api/backend-session", { headers: { host: "127.0.0.1:5220" } }))
      .status,
    200,
  );
  assert.equal((await request(handler, "/api/backend-session")).status, 403);
  address = undefined;
  assert.equal((await request(handler, "/api/backend-session")).status, 403);
  address = { address: "0.0.0.0", port: 5220 };
  assert.equal(
    (await request(handler, "/api/backend-session", { headers: { host: "127.0.0.1:5220" } }))
      .status,
    403,
  );
});

test("malformed request targets return sanitized errors with both opt-ins off or on", async () => {
  for (const options of [{}, { enabled: false, userAccessSession: false }]) {
    const f = fixture(options);
    for (const path of ["/\\[", "/\\[invalid/api/repositories"]) {
      const result = await request(f.handler, path);
      assert.equal(result.status, 400);
      assert.deepEqual(result.json, { error: "invalid_repository_request" });
    }
    assert.equal(f.tokens.length + f.calls.length, 0);
  }
});

test("shared routes bind server-held account cookies, nonce writes, deny arbitrary APIs and retain event cursor", async () => {
  const cloud = [];
  const f = fixture({
    sharedApi: true,
    sessionHeaders: async (_req, token) => {
      assert.equal(token, "synthetic.jwt.signature");
      return { Cookie: "__Secure-pitcrew-auth.session_token=server-only" };
    },
    fetchImpl: async (url, init) => {
      if (url.endsWith("/api/local-session"))
        return new Response(null, {
          status: 302,
          headers: { location: `${BACKEND_ACCESS.issuer}/cdn-cgi/access/login/backend` },
        });
      cloud.push({ url, init });
      return Response.json([{ sequence: 9 }], { headers: { "x-next-sequence": "10" } });
    },
  });
  const session = await request(f.handler, "/api/local-session");
  const cookie = session.headers["Set-Cookie"].split(";", 1)[0];
  const get = await request(f.handler, "/api/projects/repo/events?after=1", {
    headers: {
      cookie: `${cookie}; browser-secret=must-not-forward`,
      authorization: "browser-secret",
    },
  });
  assert.equal(get.status, 200);
  assert.equal(get.headers["X-Next-Sequence"], "10");
  assert.equal(cloud[0].init.headers.Cookie, "__Secure-pitcrew-auth.session_token=server-only");
  assert.equal(cloud[0].init.headers.Authorization, undefined);
  const denied = await request(f.handler, "/api/threads/task/messages", {
    method: "POST",
    headers: { origin, "content-type": "application/json", cookie },
    body: JSON.stringify({ content: "note", idempotencyKey: "note" }),
  });
  assert.equal(denied.status, 403);
  const allowed = await request(f.handler, "/api/threads/task/messages", {
    method: "POST",
    headers: {
      origin,
      "content-type": "application/json",
      cookie,
      "x-pitcrew-local-nonce": session.json.nonce,
    },
    body: JSON.stringify({ content: "note", idempotencyKey: "note" }),
  });
  assert.equal(allowed.status, 200);
  assert.equal(cloud[1].init.headers.Origin, BACKEND_ACCESS.origin);
  assert.equal((await request(f.handler, "/api/arbitrary-secrets")).status, 404);
  assert.equal(
    (await request(f.handler, "/api/projects/repo/events?credentialActor=forged")).status,
    400,
  );
  const loggedOut = fixture({ sharedApi: true, sessionHeaders: async () => ({}) });
  assert.equal((await request(loggedOut.handler, "/api/projects")).status, 401);
  assert.equal(loggedOut.calls.length, 1); // Access protection check only, no product read.
});
test("source viewers use explicit authenticated read routes and preserve bounded selectors", async () => {
  const f = fixture({
    sharedApi: true,
    sessionHeaders: async () => ({ Cookie: "trusted-session" }),
    fetchImpl: async (url) =>
      url.endsWith("/api/local-session")
        ? new Response(null, {
            status: 302,
            headers: { location: `${BACKEND_ACCESS.issuer}/cdn-cgi/access/login/backend` },
          })
        : Response.json({ sourceId: "synthetic-source", entries: [] }),
  });
  for (const endpoint of ["tree", "file", "diff"]) {
    const response = await request(
      f.handler,
      `/api/threads/thread/source/${endpoint}?path=src%2Fapp.ts&version=${"1".repeat(64)}&runId=run`,
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers["Cache-Control"], "private, no-store");
  }
  for (const path of [
    "/api/threads/thread/source/blob?hash=arbitrary",
    "/api/threads/thread/source/tree?ref=main",
    "/api/threads/thread/source/tree?path=a&path=b",
  ])
    assert.ok([400, 404].includes((await request(f.handler, path)).status));
});
