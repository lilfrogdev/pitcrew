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
      if (Buffer.isBuffer(text)) result.bytes = text;
      else result.json = JSON.parse(text);
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
async function nativeManagementHeaders(handler) {
  const response = await request(handler, "/api/local-session");
  assert.equal(response.status, 200);
  return {
    origin,
    cookie: `pitcrew-backend-nonce=${response.json.nonce}`,
    "x-pitcrew-local-nonce": response.json.nonce,
    "content-type": "application/json",
  };
}
const managedRepository = {
  projectId: "synthetic-project",
  name: "Website workspace",
  repositoryName: "synthetic-site",
  repositoryId: "immutable-synthetic-id",
  description: "Synthetic repository description",
  metadataRevision: 2,
  role: "owner",
  status: "present",
  lifecycle: "registered",
  deletable: true,
};
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
test("shared message writes preserve actor mentions and sanitize stale-mention errors", async () => {
  const writes = [];
  const f = fixture({
    sharedApi: true,
    sessionHeaders: async () => ({ Cookie: "trusted-session" }),
    fetchImpl: async (url, init) => {
      if (url.endsWith("/api/local-session"))
        return new Response(null, {
          status: 302,
          headers: { location: `${BACKEND_ACCESS.issuer}/cdn-cgi/access/login/backend` },
        });
      writes.push(JSON.parse(init.body));
      return Response.json(
        { error: "invalid_mentions", actor: "private-member", diagnostic: "private detail" },
        { status: 400 },
      );
    },
  });
  const local = await request(f.handler, "/api/local-session");
  const body = {
    content: "@johncena please review",
    idempotencyKey: "mention-retry",
    mentions: [{ actor: "account:john", start: 0, end: 9 }],
  };
  const result = await request(f.handler, "/api/threads/task/messages", {
    method: "POST",
    headers: {
      origin,
      "content-type": "application/json",
      cookie: local.headers["Set-Cookie"].split(";", 1)[0],
      "x-pitcrew-local-nonce": local.json.nonce,
    },
    body: JSON.stringify(body),
  });
  assert.deepEqual(writes, [body]);
  assert.equal(result.status, 400);
  assert.deepEqual(result.json, { error: "invalid_mentions" });
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

test("password mode uses only the held account cookie and scoped ingress without Access transport", async () => {
  const sessions = [];
  const f = fixture({
    passwordMode: true,
    userAccessSession: false,
    sharedApi: true,
    verifyToken: async () => {
      throw Error("Access must not be verified");
    },
    sessionHeaders: async (req, token) => {
      sessions.push({ req, token });
      return { Cookie: "__Secure-pitcrew-auth.session_token=held-account-cookie" };
    },
    fetchImpl: async (url, init) => {
      f.calls.push({ url, init });
      return Response.json([]);
    },
  });
  const local = await request(f.handler, "/api/local-session");
  assert.equal(local.status, 200);
  const cookie = local.headers["Set-Cookie"].split(";", 1)[0];
  const scopedPaths = [
    "/api/projects",
    "/api/account",
    "/api/project-adoptions",
    "/api/threads/thread/source/diff?path=a.ts",
    "/api/projects/project/threads/thread/visualizations",
    "/api/projects/project/threads/thread/visualizations/visual",
    "/api/threads/thread/presence",
  ];
  for (const path of scopedPaths)
    assert.equal(
      (
        await request(f.handler, path, {
          headers: {
            cookie: `${cookie}; browser-secret=untrusted`,
            authorization: "injected",
            "cf-access-jwt-assertion": "injected",
          },
        })
      ).status,
      200,
    );
  assert.equal(f.tokens.length, 0);
  assert.equal(f.calls.length, scopedPaths.length);
  assert.ok(sessions.every(({ token }) => token === ""));
  for (const call of f.calls) {
    assert.ok(call.url.startsWith(BACKEND_ACCESS.origin + "/app/api/"));
    assert.deepEqual(call.init.headers, {
      Accept: "application/json",
      Cookie: "__Secure-pitcrew-auth.session_token=held-account-cookie",
    });
  }
  const posted = await request(f.handler, "/api/threads/thread/messages", {
    method: "POST",
    headers: {
      origin,
      cookie,
      "content-type": "application/json",
      "x-pitcrew-local-nonce": local.json.nonce,
    },
    body: JSON.stringify({ content: "account note", idempotencyKey: "note" }),
  });
  assert.equal(posted.status, 200);
  assert.equal(f.calls.at(-1).init.headers.Origin, BACKEND_ACCESS.origin);
  assert.equal(f.calls.at(-1).init.headers["Cf-Access-Token"], undefined);
  const typing = { clientId: "00000000-0000-0000-0000-000000000001", sequence: 1, active: true };
  const presenceHeaders = {
    origin,
    cookie,
    "content-type": "application/json",
    "x-pitcrew-local-nonce": local.json.nonce,
  };
  const count = f.calls.length;
  assert.equal(
    (
      await request(f.handler, "/api/threads/thread/presence", {
        method: "POST",
        headers: { ...presenceHeaders, "x-pitcrew-local-nonce": "forged" },
        body: JSON.stringify(typing),
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request(f.handler, "/api/threads/thread/presence", {
        method: "POST",
        headers: presenceHeaders,
        body: JSON.stringify({ ...typing, username: "forged", text: "private draft" }),
      })
    ).status,
    400,
  );
  assert.equal(f.calls.length, count);
  assert.equal(
    (
      await request(f.handler, "/api/threads/thread/presence", {
        method: "POST",
        headers: presenceHeaders,
        body: JSON.stringify(typing),
      })
    ).status,
    200,
  );
  assert.equal(f.calls.at(-1).url, BACKEND_ACCESS.origin + "/app/api/threads/thread/presence");
  assert.equal(f.calls.at(-1).init.body, JSON.stringify(typing));
  assert.equal(
    f.calls.at(-1).init.headers.Cookie,
    "__Secure-pitcrew-auth.session_token=held-account-cookie",
  );
  assert.equal(f.tokens.length, 0);
});

test("password relay blocks cloud mutation surfaces and missing accounts before network", async () => {
  const f = fixture({ passwordMode: true, sharedApi: true, sessionHeaders: async () => ({}) });
  assert.equal((await request(f.handler, "/api/projects")).status, 401);
  for (const path of [
    "/api/repositories/import",
    "/api/repositories/reconcile",
    "/api/repositories/delete",
    "/api/projects/project/intake/dispatch",
    "/api/changes/change/runs",
    "/api/runs/run/merge-approval",
    "/api/runs/run/landing",
    "/api/runs/run/landing/reconcile",
  ])
    assert.equal((await request(f.handler, path, { method: "POST" })).status, 404);
  for (const headers of [
    { origin: "https://other.test" },
    { host: "evil.test" },
    { "sec-fetch-site": "same-site" },
  ])
    assert.equal((await request(f.handler, "/api/projects", { headers })).status, 403);
  assert.equal(f.calls.length + f.tokens.length, 0);
  assert.throws(() => createBackendRelayMiddleware({ passwordMode: "true" }), /invalid_relay_mode/);
});

test("password project adoption requires the local nonce and held account cookie", async () => {
  const f = fixture({
    passwordMode: true,
    sharedApi: true,
    sessionHeaders: async () => ({
      Cookie: "__Secure-pitcrew-auth.session_token=held-account-cookie",
    }),
  });
  const local = await request(f.handler, "/api/local-session");
  const cookie = local.headers["Set-Cookie"].split(";", 1)[0];
  const body = JSON.stringify({
    name: "approved-repository",
    repositoryId: "immutable-repository-id",
  });
  const headers = {
    origin,
    cookie,
    "content-type": "application/json",
    "x-pitcrew-local-nonce": local.json.nonce,
  };
  assert.equal(
    (
      await request(f.handler, "/api/projects", {
        method: "POST",
        headers: { ...headers, "x-pitcrew-local-nonce": "forged" },
        body,
      })
    ).status,
    403,
  );
  assert.equal(f.calls.length, 0);
  const adopted = await request(f.handler, "/api/projects", { method: "POST", headers, body });
  assert.equal(adopted.status, 200);
  assert.equal(f.calls[0].url, BACKEND_ACCESS.origin + "/app/api/projects");
  assert.equal(f.calls[0].init.body, body);
  assert.equal(
    f.calls[0].init.headers.Cookie,
    "__Secure-pitcrew-auth.session_token=held-account-cookie",
  );
  assert.equal(f.calls[0].init.headers.Origin, BACKEND_ACCESS.origin);
  assert.equal(f.calls[0].init.headers["Cf-Access-Token"], undefined);
  assert.equal(f.tokens.length, 0);
  const loggedOut = fixture({
    passwordMode: true,
    sharedApi: true,
    sessionHeaders: async () => ({}),
  });
  const anonymousLocal = await request(loggedOut.handler, "/api/local-session");
  const anonymous = await request(loggedOut.handler, "/api/projects", {
    method: "POST",
    headers: {
      origin,
      "content-type": "application/json",
      "x-pitcrew-local-nonce": anonymousLocal.json.nonce,
      cookie: anonymousLocal.headers["Set-Cookie"].split(";", 1)[0],
    },
    body,
  });
  assert.equal(anonymous.status, 401);
  assert.equal(loggedOut.calls.length + loggedOut.tokens.length, 0);
});

test("native creation forwards only bounded consent with held account authority and projects metadata without service tokens", async () => {
  const record = {
    name: "approved-new-repo",
    repositoryId: "immutable-id",
    projectId: "project-id",
    status: "ready",
  };
  const f = fixture({
    passwordMode: true,
    sharedApi: true,
    sessionHeaders: async () => ({ Cookie: "held-original-account-session" }),
    fetchImpl: async (url, init) => {
      f.calls.push({ url, init });
      const privateRecord = {
        ...record,
        token: "synthetic-token-must-not-escape",
        ownerActor: "internal-account",
      };
      return Response.json(
        url.endsWith("repository-creations")
          ? {
              approval: { name: record.name, email: "internal@example.test" },
              creations: [privateRecord],
              token: "synthetic-private",
            }
          : privateRecord,
      );
    },
  });
  const local = await request(f.handler, "/api/local-session");
  const headers = {
    origin,
    cookie: local.headers["Set-Cookie"].split(";", 1)[0],
    "content-type": "application/json",
    "x-pitcrew-local-nonce": local.json.nonce,
  };
  const discovery = await request(f.handler, "/api/repository-creations", { headers });
  assert.deepEqual(discovery.json, { approval: { name: record.name }, creations: [record] });
  const body = JSON.stringify({ name: record.name, credentialConsent: true });
  assert.equal(
    (
      await request(f.handler, "/api/repositories/create", {
        method: "POST",
        headers: { ...headers, "x-pitcrew-local-nonce": "forged" },
        body,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request(f.handler, "/api/repositories/create", {
        method: "POST",
        headers: { ...headers, origin: "https://evil.test" },
        body,
      })
    ).status,
    403,
  );
  for (const payload of [
    { name: record.name },
    { name: record.name, credentialConsent: false },
    { name: record.name, credentialConsent: true, actor: "account:forged" },
  ])
    assert.equal(
      (
        await request(f.handler, "/api/repositories/create", {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
        })
      ).status,
      400,
    );
  assert.equal(
    (
      await request(f.handler, "/api/repositories/create", {
        method: "POST",
        headers,
        body: JSON.stringify({
          name: record.name,
          credentialConsent: true,
          padding: "x".repeat(2100),
        }),
      })
    ).status,
    413,
  );
  assert.equal(f.calls.length, 1);
  const created = await request(f.handler, "/api/repositories/create", {
    method: "POST",
    headers,
    body,
  });
  assert.deepEqual(created.json, record);
  assert.equal(f.calls[1].url, BACKEND_ACCESS.origin + "/app/api/repositories/create");
  assert.equal(f.calls[1].init.body, body);
  assert.deepEqual(f.calls[1].init.headers, {
    Accept: "application/json",
    Cookie: "held-original-account-session",
    Origin: BACKEND_ACCESS.origin,
    "Content-Type": "application/json",
  });
  assert.equal(f.tokens.length, 0);
  assert.ok(!created.text.includes("synthetic-token"));
});

test("native creation cannot change the consented account while reading a slow body", async () => {
  let account = "original-account";
  const f = fixture({
    passwordMode: true,
    sharedApi: true,
    sessionHeaders: async () => ({ Cookie: account }),
  });
  const local = await request(f.handler, "/api/local-session");
  const headers = {
    origin,
    cookie: local.headers["Set-Cookie"].split(";", 1)[0],
    "content-type": "application/json",
    "x-pitcrew-local-nonce": local.json.nonce,
  };
  const chunks = (async function* () {
    yield Buffer.from('{"name":"approved-new-repo",');
    account = "replacement-account";
    yield Buffer.from('"credentialConsent":true}');
  })();
  const response = await request(f.handler, "/api/repositories/create", {
    method: "POST",
    headers,
    chunks,
  });
  assert.equal(response.status, 409);
  assert.deepEqual(response.json, { error: "backend_account_changed" });
  assert.equal(f.calls.length + f.tokens.length, 0);
});

test("visualization relay allows only bounded scoped JSON reads and retains server-held session authority", async () => {
  const calls = [];
  let large = false;
  const f = fixture({
    sharedApi: true,
    sessionHeaders: async () => ({ Cookie: "synthetic-server-session" }),
    fetchImpl: async (url, init) => {
      if (url.endsWith("/api/local-session"))
        return new Response(null, {
          status: 302,
          headers: { location: `${BACKEND_ACCESS.issuer}/cdn-cgi/access/login/backend` },
        });
      calls.push({ url, init });
      return Response.json({
        artifacts: [],
        ...(large ? { padding: "x".repeat(524288 + 4096) } : {}),
      });
    },
  });
  const path = "/api/projects/repo/threads/thread/visualizations";
  assert.equal((await request(f.handler, path)).status, 200);
  assert.equal(calls[0].init.headers.Cookie, "synthetic-server-session");
  assert.equal(calls[0].init.redirect, "manual");
  const count = calls.length;
  assert.equal(
    (
      await request(f.handler, path, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ content: {}, key: "manual" }),
      })
    ).status,
    404,
  );
  assert.equal((await request(f.handler, `${path}?accountId=other`)).status, 400);
  assert.equal((await request(f.handler, `${path}/../../secret`)).status, 404);
  assert.equal(calls.length, count);
  large = true;
  assert.equal((await request(f.handler, path)).status, 503);
  const loggedOut = fixture({ sharedApi: true, sessionHeaders: async () => ({}) });
  assert.equal((await request(loggedOut.handler, path)).status, 401);
});

test("thread presence uses authenticated exact routes, excludes draft fields, and never locks message writes", async () => {
  let releaseMessage;
  const cloud = [];
  const f = fixture({
    sharedApi: true,
    sessionHeaders: async () => ({ Cookie: "synthetic-server-held-account" }),
    fetchImpl: async (url, init) => {
      if (url.endsWith("/api/local-session"))
        return new Response(null, {
          status: 302,
          headers: { location: `${BACKEND_ACCESS.issuer}/cdn-cgi/access/login/backend` },
        });
      cloud.push({ url, init });
      if (url.endsWith("/messages"))
        await new Promise((resolve) => {
          releaseMessage = resolve;
        });
      return Response.json(
        url.endsWith("/presence") && init.method === "GET"
          ? { typers: [{ username: "Alice", expiresInMs: 6000 }] }
          : { ok: true },
      );
    },
  });
  const local = await request(f.handler, "/api/local-session");
  const headers = {
    origin,
    "content-type": "application/json",
    cookie: local.headers["Set-Cookie"].split(";", 1)[0],
    "x-pitcrew-local-nonce": local.json.nonce,
  };
  const signal = { clientId: "00000000-0000-0000-0000-000000000001", sequence: 2, active: false };
  const peers = await request(f.handler, "/api/threads/thread/presence");
  assert.equal(peers.status, 200);
  assert.equal(peers.headers["Cache-Control"], "private, no-store");
  assert.equal((await request(f.handler, "/api/threads/thread/presence?actor=guess")).status, 400);
  assert.equal(
    (
      await request(f.handler, "/api/threads/thread/presence", {
        method: "POST",
        headers,
        body: JSON.stringify({ ...signal, text: "private draft", username: "spoof" }),
      })
    ).status,
    400,
  );
  const pending = request(f.handler, "/api/threads/thread/messages", {
    method: "POST",
    headers,
    body: JSON.stringify({ content: "synthetic message", idempotencyKey: "one" }),
  });
  await new Promise(setImmediate);
  assert.equal(typeof releaseMessage, "function");
  assert.equal(
    (
      await request(f.handler, "/api/threads/thread/presence", {
        method: "POST",
        headers,
        body: JSON.stringify(signal),
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await request(f.handler, "/api/threads/thread/messages", {
        method: "POST",
        headers,
        body: JSON.stringify({ content: "second", idempotencyKey: "two" }),
      })
    ).status,
    409,
  );
  releaseMessage();
  await pending;
  assert.equal(cloud.at(-1).init.headers.Cookie, "synthetic-server-held-account");
  assert.equal(
    cloud.filter((call) => call.url.endsWith("/presence") && call.init.method === "POST").length,
    1,
  );
});

test("password uploads forward bounded exact bytes with account authority, enforce nonce and preserve safe downloads", async () => {
  const cloud = [];
  const bytes = Buffer.from([0, 255, 60, 115, 99, 114, 105, 112, 116, 62]);
  const id = "00000000-0000-0000-0000-000000000010";
  const f = fixture({
    passwordMode: true,
    sharedApi: true,
    sessionHeaders: async () => ({ Cookie: "__Secure-pitcrew-auth.session_token=synthetic-held" }),
    fetchImpl: async (url, init) => {
      cloud.push({ url, init });
      return url.includes("/attachments/")
        ? new Response(bytes, {
            headers: {
              "content-type": "application/octet-stream",
              "content-disposition": "inline; filename=unsafe.html",
              "set-cookie": "evil=synthetic",
              "x-private-path": "/private/synthetic",
            },
          })
        : Response.json({ ok: true });
    },
  });
  const local = await request(f.handler, "/api/local-session");
  const headers = {
    origin,
    cookie: local.headers["Set-Cookie"].split(";", 1)[0],
    "x-pitcrew-local-nonce": local.json.nonce,
    "content-type": "application/pdf",
    "x-pitcrew-filename": "synthetic.pdf",
    authorization: "synthetic-client",
    "x-user-id": "forged",
    "cf-access-token": "forged",
  };
  const path = `/api/threads/thread/uploads/${id}`;
  assert.equal(
    (
      await request(f.handler, path, {
        method: "PUT",
        body: bytes,
        headers: { ...headers, "x-pitcrew-local-nonce": "wrong" },
      })
    ).status,
    403,
  );
  assert.equal(
    (await request(f.handler, path + "?actor=forged", { method: "PUT", body: bytes, headers }))
      .status,
    400,
  );
  assert.equal(
    (
      await request(f.handler, "/api/threads/thread/uploads/not-a-uuid", {
        method: "PUT",
        body: bytes,
        headers,
      })
    ).status,
    404,
  );
  assert.equal(cloud.length, 0);
  assert.equal(
    (await request(f.handler, path, { method: "PUT", body: bytes, headers })).status,
    200,
  );
  assert.equal(cloud[0].url, BACKEND_ACCESS.origin + "/app" + path);
  assert.deepEqual(cloud[0].init.body, bytes);
  assert.deepEqual(cloud[0].init.headers, {
    Accept: "application/json",
    Cookie: "__Secure-pitcrew-auth.session_token=synthetic-held",
    Origin: BACKEND_ACCESS.origin,
    "Content-Type": "application/pdf",
    "X-Pitcrew-Filename": "synthetic.pdf",
  });
  assert.equal(f.tokens.length, 0);
  const download = await request(f.handler, `/api/threads/thread/attachments/${id}`);
  assert.equal(download.status, 200);
  assert.deepEqual(download.bytes, bytes);
  assert.match(download.headers["Content-Disposition"], /^attachment;/);
  assert.equal(download.headers["Content-Type"], "application/octet-stream");
  assert.equal(download.headers["X-Content-Type-Options"], "nosniff");
  assert.equal(download.headers["Cache-Control"], "private, no-store");
  assert.equal(download.headers["Set-Cookie"], undefined);
  assert.equal(download.headers["x-private-path"], undefined);
  assert.equal((await request(f.handler, path, { method: "DELETE", headers })).status, 200);
  assert.equal(cloud.at(-1).init.body, undefined);
  assert.equal(
    (await request(f.handler, path, { method: "PUT", body: Buffer.alloc(8388609), headers }))
      .status,
    413,
  );
});

test("an in-flight upload leaves message and presence mutations available", async () => {
  let release;
  const f = fixture({
    passwordMode: true,
    sharedApi: true,
    sessionHeaders: async () => ({ Cookie: "synthetic-held" }),
    fetchImpl: async (_url, init) => {
      if (init.method === "PUT")
        await new Promise((done) => {
          release = done;
        });
      return Response.json({ ok: true });
    },
  });
  const local = await request(f.handler, "/api/local-session");
  const headers = {
    origin,
    cookie: local.headers["Set-Cookie"].split(";", 1)[0],
    "x-pitcrew-local-nonce": local.json.nonce,
    "content-type": "application/octet-stream",
    "x-pitcrew-filename": "synthetic.bin",
  };
  const pending = request(
    f.handler,
    "/api/threads/one/uploads/00000000-0000-0000-0000-000000000011",
    { method: "PUT", headers, body: Buffer.from([1]) },
  );
  await new Promise(setImmediate);
  assert.equal(typeof release, "function");
  try {
    assert.equal(
      (
        await request(f.handler, "/api/threads/two/messages", {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ content: "synthetic", idempotencyKey: "another-thread" }),
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await request(f.handler, "/api/threads/two/presence", {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({
            clientId: "00000000-0000-0000-0000-000000000012",
            sequence: 1,
            active: true,
          }),
        })
      ).status,
      200,
    );
  } finally {
    release();
    await pending;
  }
});

test("a slow upload cannot move its selected bytes to a replacement account", async () => {
  let accountCookie = "synthetic-Alice";
  const cloud = [];
  let started;
  const entered = new Promise((done) => {
    started = done;
  });
  let release;
  const held = new Promise((done) => {
    release = done;
  });
  const f = fixture({
    passwordMode: true,
    sharedApi: true,
    sessionHeaders: async () => ({ Cookie: accountCookie }),
    fetchImpl: async (url, init) => {
      cloud.push({ url, init });
      return Response.json({ ok: true });
    },
  });
  const local = await request(f.handler, "/api/local-session");
  const headers = {
    origin,
    cookie: local.headers["Set-Cookie"].split(";", 1)[0],
    "x-pitcrew-local-nonce": local.json.nonce,
    "content-type": "application/octet-stream",
    "x-pitcrew-filename": "synthetic.bin",
  };
  const chunks = (async function* () {
    yield Buffer.from([65]);
    started();
    await held;
    yield Buffer.from([66]);
  })();
  const pending = request(
    f.handler,
    "/api/threads/shared/uploads/00000000-0000-0000-0000-000000000013",
    { method: "PUT", headers, chunks },
  );
  await entered;
  accountCookie = "synthetic-Bob";
  release();
  const result = await pending;
  assert.equal(result.status, 409);
  assert.equal(result.json.error, "backend_account_changed");
  assert.equal(cloud.length, 0);
});

test("native management discovers capabilities and safe physical identity alongside display metadata", async () => {
  const f = fixture({
    passwordMode: true,
    sharedApi: true,
    sessionHeaders: async () => ({ Cookie: "synthetic-held-session" }),
    fetchImpl: async (url) =>
      Response.json(
        url.endsWith("repository-creations")
          ? {
              approval: null,
              capabilities: {
                create: true,
                manage: true,
                delete: true,
                token: "private-provider-value",
              },
              creations: [],
            }
          : {
              repositories: [
                {
                  ...managedRepository,
                  token: "private-provider-value",
                  ownerActor: "private-owner",
                },
              ],
              cursor: null,
            },
      ),
  });
  assert.deepEqual((await request(f.handler, "/api/repository-creations")).json, {
    approval: null,
    capabilities: { create: true, manage: true, delete: true },
    creations: [],
  });
  const directory = await request(f.handler, "/api/repositories");
  assert.equal(directory.status, 200);
  assert.deepEqual(directory.json.repositories[0], managedRepository);
  assert.ok(!directory.text.includes("private-provider-value"));
  assert.ok(!directory.text.includes("private-owner"));
  assert.equal(f.tokens.length, 0);
});

test("physical deletion capability is independent, absent-default-off and malformed-fail-closed", async () => {
  for (const [capabilities, expectedStatus, expectedDelete] of [
    [{ create: true, manage: true }, 200, false],
    [{ create: true, manage: true, delete: false }, 200, false],
    [{ create: true, manage: true, delete: true }, 200, true],
    [{ create: true, manage: true, delete: "enabled" }, 503, undefined],
    [{ create: true, manage: true, delete: null }, 503, undefined],
    [{ create: false, manage: false, delete: true }, 503, undefined],
  ]) {
    const f = fixture({
      passwordMode: true,
      sharedApi: true,
      sessionHeaders: async () => ({ Cookie: "synthetic-held-session" }),
      fetchImpl: async () => Response.json({ approval: null, capabilities, creations: [] }),
    });
    const result = await request(f.handler, "/api/repository-creations");
    assert.equal(result.status, expectedStatus);
    if (expectedStatus === 200) {
      assert.equal(result.json.capabilities.create, capabilities.create);
      assert.equal(result.json.capabilities.manage, capabilities.manage);
      assert.equal(result.json.capabilities.delete, expectedDelete);
    } else {
      assert.deepEqual(result.json, { error: "repository_backend_unavailable" });
    }
    assert.equal(f.tokens.length, 0);
  }
});

test("native metadata and deletion accept only explicit routes, strict bodies, nonce and origin", async () => {
  const forwarded = [];
  const f = fixture({
    passwordMode: true,
    sharedApi: true,
    sessionHeaders: async () => ({ Cookie: "synthetic-original-session" }),
    fetchImpl: async (url, init) => {
      forwarded.push({ url, init });
      return Response.json(
        init.method === "PATCH"
          ? {
              id: managedRepository.projectId,
              name: "Edited workspace",
              repository: "artifact:synthetic-site",
              baseSha: "0".repeat(40),
              configurationRevision: "uninitialized-v1",
              description: "Edited description",
              metadataRevision: 3,
              token: "private-provider-value",
            }
          : {
              ...managedRepository,
              status: "deleting",
              lifecycle: "deleting",
              deletable: false,
              token: "private-provider-value",
            },
        { status: init.method === "PATCH" ? 200 : 202 },
      );
    },
  });
  const headers = await nativeManagementHeaders(f.handler);
  const metadataPath = `/api/projects/${managedRepository.projectId}/repository`;
  const validEdit = {
    displayName: "Edited workspace",
    description: "Edited description",
    expectedRevision: 2,
  };
  assert.equal(
    (await request(f.handler, metadataPath, { method: "PATCH", body: JSON.stringify(validEdit) }))
      .status,
    403,
  );
  assert.equal(
    (
      await request(f.handler, metadataPath, {
        method: "PATCH",
        headers: { ...headers, origin: "https://invalid.test" },
        body: JSON.stringify(validEdit),
      })
    ).status,
    403,
  );
  for (const invalid of [
    { ...validEdit, actor: "account:forged" },
    { ...validEdit, expectedRevision: -1 },
    { ...validEdit, displayName: "\u0000secret" },
    { displayName: "Missing description" },
    { ...validEdit, description: "x".repeat(1001) },
  ])
    assert.equal(
      (
        await request(f.handler, metadataPath, {
          method: "PATCH",
          headers,
          body: JSON.stringify(invalid),
        })
      ).status,
      400,
    );
  const edited = await request(f.handler, metadataPath, {
    method: "PATCH",
    headers,
    body: JSON.stringify(validEdit),
  });
  assert.equal(edited.status, 200);
  assert.equal(edited.json.name, "Edited workspace");
  assert.equal(edited.json.repository, "artifact:synthetic-site");
  assert.ok(!edited.text.includes("private-provider-value"));
  const deletePath = metadataPath + "/delete";
  const deletion = {
    confirmation: managedRepository.repositoryName,
    repositoryId: managedRepository.repositoryId,
  };
  for (const invalid of [
    { confirmation: "Website workspace", repositoryId: managedRepository.repositoryId },
    { ...deletion, owner: "account:forged" },
    { confirmation: deletion.confirmation },
  ])
    assert.equal(
      (
        await request(f.handler, deletePath, {
          method: "POST",
          headers,
          body: JSON.stringify(invalid),
        })
      ).status,
      400,
    );
  assert.equal(
    (
      await request(f.handler, deletePath + "?actor=forged", {
        method: "POST",
        headers,
        body: JSON.stringify(deletion),
      })
    ).status,
    400,
  );
  const deleting = await request(f.handler, deletePath, {
    method: "POST",
    headers,
    body: JSON.stringify(deletion),
  });
  assert.equal(deleting.status, 202);
  assert.deepEqual(deleting.json, {
    ...managedRepository,
    status: "deleting",
    lifecycle: "deleting",
    deletable: false,
  });
  assert.ok(!deleting.text.includes("private-provider-value"));
  assert.equal(forwarded.length, 2);
  assert.equal(forwarded[0].init.headers.Cookie, "synthetic-original-session");
  assert.deepEqual(JSON.parse(forwarded[1].init.body), deletion);
  assert.equal(
    (
      await request(f.handler, "/api/repositories/delete", {
        method: "POST",
        headers,
        body: JSON.stringify(deletion),
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await request(f.handler, metadataPath + "/rename", {
        method: "PATCH",
        headers,
        body: JSON.stringify(validEdit),
      })
    ).status,
    404,
  );
  const accessMode = fixture({
    sharedApi: true,
    sessionHeaders: async () => ({ Cookie: "synthetic-access-session" }),
  });
  assert.equal(
    (
      await request(accessMode.handler, metadataPath, {
        method: "PATCH",
        headers,
        body: JSON.stringify(validEdit),
      })
    ).status,
    404,
  );
});

test("native general creation forwards optional bounded metadata without provider credentials", async () => {
  const forwarded = [];
  const f = fixture({
    passwordMode: true,
    sharedApi: true,
    sessionHeaders: async () => ({ Cookie: "synthetic-original-session" }),
    fetchImpl: async (url, init) => {
      forwarded.push({ url, init });
      return Response.json({
        name: "new-user-selected-site",
        status: "ready",
        repositoryId: "new-immutable-id",
        projectId: "new-project-id",
        token: "private-provider-value",
      });
    },
  });
  const headers = await nativeManagementHeaders(f.handler);
  const input = {
    name: "new-user-selected-site",
    credentialConsent: true,
    displayName: "User selected display name",
    description: "🙂".repeat(500),
  };
  const created = await request(f.handler, "/api/repositories/create", {
    method: "POST",
    headers,
    body: JSON.stringify(input),
  });
  assert.equal(created.status, 200);
  assert.deepEqual(JSON.parse(forwarded[0].init.body), input);
  assert.ok(!created.text.includes("private-provider-value"));
  for (const invalid of [
    { ...input, description: "x".repeat(1001) },
    { ...input, credentialConsent: false },
    { ...input, displayName: " " },
    { ...input, description: "\u0000" },
    { ...input, ownerActor: "account:forged" },
  ])
    assert.equal(
      (
        await request(f.handler, "/api/repositories/create", {
          method: "POST",
          headers,
          body: JSON.stringify(invalid),
        })
      ).status,
      400,
    );
  assert.equal(forwarded.length, 1);
});

test("native logical names preserve separate immutable physical identities across create and rename", async () => {
  const physicalName = "acme-website-11111111222243338444555555555555";
  const forwarded = [];
  let malformed = false;
  const f = fixture({
    passwordMode: true,
    sharedApi: true,
    sessionHeaders: async () => ({ Cookie: "synthetic-original-session" }),
    fetchImpl: async (url, init) => {
      forwarded.push({ url, init });
      if (url.endsWith("/create"))
        return Response.json({
          name: "acme-website",
          repositoryName: malformed ? "INVALID/physical" : physicalName,
          status: "ready",
          repositoryId: "immutable-id",
          projectId: "11111111-2222-4333-8444-555555555555",
          token: "private-provider-value",
        });
      return Response.json({
        id: managedRepository.projectId,
        name: "Display label",
        logicalName: "renamed-site",
        repository: `artifact:${physicalName}`,
        baseSha: "0".repeat(40),
        configurationRevision: "uninitialized-v1",
        description: "",
        metadataRevision: 3,
        token: "private-provider-value",
      });
    },
  });
  const headers = await nativeManagementHeaders(f.handler);
  const input = { name: " Acme-Website ", credentialConsent: true };
  const created = await request(f.handler, "/api/repositories/create", {
    method: "POST",
    headers,
    body: JSON.stringify(input),
  });
  assert.equal(created.status, 200);
  assert.equal(created.json.name, "acme-website");
  assert.equal(created.json.repositoryName, physicalName);
  assert.deepEqual(JSON.parse(forwarded[0].init.body), input);
  assert.ok(!created.text.includes("private-provider-value"));
  const path = `/api/projects/${managedRepository.projectId}/repository`;
  const edit = {
    displayName: "Display label",
    description: "",
    logicalName: " Renamed-Site ",
    expectedRevision: 2,
  };
  const renamed = await request(f.handler, path, {
    method: "PATCH",
    headers,
    body: JSON.stringify(edit),
  });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.json.logicalName, "renamed-site");
  assert.equal(renamed.json.repository, `artifact:${physicalName}`);
  assert.deepEqual(JSON.parse(forwarded[1].init.body), edit);
  assert.ok(!renamed.text.includes("private-provider-value"));
  for (const logicalName of [
    null,
    "",
    "-bad",
    "bad/name",
    "bad_name",
    "x".repeat(64),
    "Kelvin",
    "\u00a0not-ascii\u00a0",
  ]) {
    assert.equal(
      (
        await request(f.handler, path, {
          method: "PATCH",
          headers,
          body: JSON.stringify({ ...edit, logicalName }),
        })
      ).status,
      400,
    );
  }
  assert.equal(forwarded.length, 2);
  malformed = true;
  const invalid = await request(f.handler, "/api/repositories/create", {
    method: "POST",
    headers,
    body: JSON.stringify(input),
  });
  assert.equal(invalid.status, 503);
  assert.deepEqual(invalid.json, { error: "repository_backend_unavailable" });
});

test("native invitation listing and ID revocation omit tokens and require an exact empty body", async () => {
  const id = "11111111-2222-4333-8444-555555555555";
  const invitation = {
    id,
    scope: "project",
    projectId: managedRepository.projectId,
    email: "editor@synthetic.test",
    role: "editor",
    invitedBy: "account:synthetic-owner",
    expiresAt: new Date(Date.now() + 100000).toISOString(),
  };
  const forwarded = [];
  const f = fixture({
    passwordMode: true,
    sharedApi: true,
    sessionHeaders: async () => ({ Cookie: "synthetic-owner-session" }),
    fetchImpl: async (url, init) => {
      forwarded.push({ url, init });
      const value = { ...invitation, digest: "private-digest", token: "private-token" };
      return Response.json(
        url.endsWith("/revoke") ? { ...value, revokedAt: "2026-10-08T05:00:00.000Z" } : [value],
      );
    },
  });
  const path = `/api/projects/${managedRepository.projectId}/invitations`;
  const listed = await request(f.handler, path);
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.json, [invitation]);
  assert.ok(!listed.text.includes("private-"));
  const headers = await nativeManagementHeaders(f.handler);
  const revoke = path + `/${id}/revoke`;
  assert.equal(
    (
      await request(f.handler, revoke, {
        method: "POST",
        headers,
        body: JSON.stringify({ token: "forged-link" }),
      })
    ).status,
    400,
  );
  const revoked = await request(f.handler, revoke, { method: "POST", headers, body: "{}" });
  assert.equal(revoked.status, 200);
  assert.ok(revoked.json.revokedAt);
  assert.ok(!revoked.text.includes("private-"));
  assert.equal(
    (await request(f.handler, path + "/arbitrary/revoke", { method: "POST", headers, body: "{}" }))
      .status,
    404,
  );
  assert.equal(forwarded.length, 2);
});

test("every native management mutation retains the account captured before a slow body", async () => {
  const cases = [
    [
      "PATCH",
      `/api/projects/${managedRepository.projectId}/repository`,
      { displayName: "Updated", description: "" },
    ],
    [
      "POST",
      `/api/projects/${managedRepository.projectId}/repository/delete`,
      {
        confirmation: managedRepository.repositoryName,
        repositoryId: managedRepository.repositoryId,
      },
    ],
    [
      "POST",
      `/api/projects/${managedRepository.projectId}/invitations`,
      { email: "editor@synthetic.test", role: "editor" },
    ],
    [
      "POST",
      "/api/threads/synthetic-thread/invitations",
      { recipient: "johncena", role: "editor" },
    ],
    ["POST", `/api/invitations/${"a".repeat(64)}/accept`, {}],
    [
      "POST",
      `/api/projects/${managedRepository.projectId}/invitations/11111111-2222-4333-8444-555555555555/revoke`,
      {},
    ],
  ];
  for (const [method, path, input] of cases) {
    let account = "synthetic-Alice";
    const forwarded = [];
    const f = fixture({
      passwordMode: true,
      sharedApi: true,
      sessionHeaders: async () => ({ Cookie: account }),
      fetchImpl: async (url, init) => {
        forwarded.push({ url, init });
        return Response.json(managedRepository);
      },
    });
    const headers = await nativeManagementHeaders(f.handler);
    const chunks = (async function* () {
      yield Buffer.from("{");
      account = "synthetic-Bob";
      yield Buffer.from(JSON.stringify(input).slice(1));
    })();
    const result = await request(f.handler, path, { method, headers, chunks });
    assert.equal(result.status, 409, path);
    assert.deepEqual(result.json, { error: "backend_account_changed" });
    assert.equal(forwarded.length, 0);
  }
});

test("native management response identities and lifecycle states cannot change the selected target", async () => {
  const path = `/api/projects/${managedRepository.projectId}/repository`;
  for (const unexpected of [
    { ...managedRepository, projectId: "other-project" },
    { ...managedRepository, status: "deleted", lifecycle: "registered" },
    { ...managedRepository, metadataRevision: -1 },
    { ...managedRepository, description: "x".repeat(1001) },
  ]) {
    const f = fixture({
      passwordMode: true,
      sharedApi: true,
      sessionHeaders: async () => ({ Cookie: "synthetic-owner" }),
      fetchImpl: async () => Response.json(unexpected),
    });
    assert.equal((await request(f.handler, path)).status, 503);
  }
  for (const unexpected of [
    {
      ...managedRepository,
      repositoryId: "replacement-repository",
      status: "deleted",
      lifecycle: "deleted",
      deletable: false,
    },
    {
      ...managedRepository,
      repositoryName: "replacement-name",
      status: "deleted",
      lifecycle: "deleted",
      deletable: false,
    },
  ]) {
    const f = fixture({
      passwordMode: true,
      sharedApi: true,
      sessionHeaders: async () => ({ Cookie: "synthetic-owner" }),
      fetchImpl: async () => Response.json(unexpected),
    });
    const headers = await nativeManagementHeaders(f.handler);
    const result = await request(f.handler, path + "/delete", {
      method: "POST",
      headers,
      body: JSON.stringify({
        confirmation: managedRepository.repositoryName,
        repositoryId: managedRepository.repositoryId,
      }),
    });
    assert.equal(result.status, 503);
    assert.deepEqual(result.json, { error: "repository_backend_unavailable" });
  }
});

test("percent-encoded native route aliases retain strict body and response projection", async () => {
  const forwarded = [];
  const f = fixture({
    passwordMode: true,
    sharedApi: true,
    sessionHeaders: async () => ({ Cookie: "synthetic-owner" }),
    fetchImpl: async (url, init) => {
      forwarded.push({ url, init });
      return Response.json({ ...managedRepository, token: "never-browser-visible" });
    },
  });
  const headers = await nativeManagementHeaders(f.handler);
  const alias = `/api/projects/${managedRepository.projectId}/%72epository`;
  const status = await request(f.handler, alias);
  assert.equal(status.status, 200);
  assert.deepEqual(status.json, managedRepository);
  assert.ok(!status.text.includes("never-browser-visible"));
  const invalid = await request(f.handler, alias, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ displayName: "Changed", description: "", actor: "forged-owner" }),
  });
  assert.equal(invalid.status, 400);
  assert.equal(forwarded.length, 1);
});

test("native username and email invitations project safe metadata on project/thread and token routes", async () => {
  const token = "a".repeat(64);
  const base = {
    id: "11111111-2222-4333-8444-555555555555",
    projectId: managedRepository.projectId,
    recipient: "@johncena",
    role: "editor",
    invitedBy: "account:synthetic-owner",
    expiresAt: new Date(Date.now() + 100000).toISOString(),
  };
  let scope = "project",
    recipient = "@johncena";
  const forwarded = [];
  const f = fixture({
    passwordMode: true,
    sharedApi: true,
    sessionHeaders: async () => ({ Cookie: "synthetic-owner-session" }),
    fetchImpl: async (url, init) => {
      forwarded.push({ url, init });
      const invitation = {
        ...base,
        scope,
        recipient,
        ...(scope === "thread" ? { threadId: "synthetic-thread" } : {}),
        recipientActor: "account:private-recipient",
        digest: "private-digest",
        token: "private-stored-token",
      };
      return Response.json(url.endsWith("/invitations") ? { token, invitation } : invitation, {
        status: url.endsWith("/invitations") ? 201 : 200,
      });
    },
  });
  const headers = await nativeManagementHeaders(f.handler);
  for (const [path, selector, desiredScope, label] of [
    [
      `/api/projects/${managedRepository.projectId}/invitations`,
      "JoHnCeNa",
      "project",
      "@johncena",
    ],
    ["/api/threads/synthetic-thread/invitations", "@JOHNCENA", "thread", "@johncena"],
    [
      "/api/threads/synthetic-thread/invitations",
      "EDITOR@SYNTHETIC.TEST",
      "thread",
      "editor@synthetic.test",
    ],
  ]) {
    scope = desiredScope;
    recipient = label;
    const created = await request(f.handler, path, {
      method: "POST",
      headers,
      body: JSON.stringify({ recipient: selector, role: "editor" }),
    });
    assert.equal(created.status, 201);
    assert.equal(created.json.token, token);
    assert.equal(created.json.invitation.recipient, label);
    assert.equal(created.json.invitation.scope, desiredScope);
    assert.ok(!created.text.includes("private-"));
    assert.ok(!created.text.includes("recipientActor"));
    assert.ok(!created.text.includes("email"));
    for (const [target, method] of [
      [`/api/invitations/${token}`, "GET"],
      [`/api/invitations/${token}/accept`, "POST"],
      [`/api/invitations/${token}/revoke`, "POST"],
    ]) {
      const response = await request(f.handler, target, {
        method,
        headers,
        ...(method === "POST" ? { body: "{}" } : {}),
      });
      assert.equal(response.status, 200);
      assert.equal(response.json.recipient, label);
      assert.ok(!response.text.includes("private-"));
      assert.ok(!response.text.includes("token"));
    }
  }
  assert.equal(forwarded.length, 12);
});

test("native invitation relay rejects identity injection and hides malformed or leaked success metadata", async () => {
  const token = "a".repeat(64),
    forwarded = [];
  let result = { error: "recipient_unavailable", diagnostic: "private-diagnostic" };
  let status = 400;
  const f = fixture({
    passwordMode: true,
    sharedApi: true,
    sessionHeaders: async () => ({ Cookie: "synthetic-owner-session" }),
    fetchImpl: async (url, init) => {
      forwarded.push({ url, init });
      return Response.json(result, { status });
    },
  });
  const headers = await nativeManagementHeaders(f.handler);
  for (const path of [
    `/api/projects/${managedRepository.projectId}/invitations`,
    "/api/threads/synthetic-thread/invitations",
  ]) {
    for (const input of [
      { recipient: "johncena", role: "editor", recipientActor: "account:forged" },
      { recipient: "johncena", email: "other@synthetic.test", role: "editor" },
      { recipient: "johncena", role: "editor", digest: "forged" },
      { recipient: "\u00a0johncena\u00a0", role: "editor" },
      { recipient: "a\u0000@synthetic.test", role: "editor" },
      { email: "a@synthetic\u007f.test", role: "editor" },
    ])
      assert.equal(
        (await request(f.handler, path, { method: "POST", headers, body: JSON.stringify(input) }))
          .status,
        400,
      );
  }
  assert.equal(
    (
      await request(f.handler, `/api/invitations/${token}/accept`, {
        method: "POST",
        headers,
        body: JSON.stringify({ actor: "account:forged" }),
      })
    ).status,
    400,
  );
  assert.equal(forwarded.length, 0);
  const unknown = await request(f.handler, "/api/threads/synthetic-thread/invitations", {
    method: "POST",
    headers,
    body: JSON.stringify({ recipient: "unknown", role: "editor" }),
  });
  assert.deepEqual(unknown.json, { error: "recipient_unavailable" });
  status = 201;
  result = {
    token,
    invitation: {
      id: "11111111-2222-4333-8444-555555555555",
      projectId: managedRepository.projectId,
      scope: "thread",
      threadId: "wrong-thread",
      recipient: "@johncena",
      role: "editor",
      invitedBy: "account:synthetic-owner",
      expiresAt: new Date(Date.now() + 100000).toISOString(),
    },
  };
  assert.equal(
    (
      await request(f.handler, "/api/threads/synthetic-thread/invitations", {
        method: "POST",
        headers,
        body: JSON.stringify({ recipient: "johncena", role: "editor" }),
      })
    ).status,
    503,
  );
  result.invitation.threadId = "synthetic-thread";
  result.invitation.email = "private-email@synthetic.test";
  const leaked = await request(f.handler, "/api/threads/synthetic-thread/invitations", {
    method: "POST",
    headers,
    body: JSON.stringify({ recipient: "johncena", role: "editor" }),
  });
  assert.equal(leaked.status, 503);
  assert.ok(!leaked.text.includes("private-"));
});

test("native project and thread invitation codes remain fenced to the submitted canonical recipient", async () => {
  const token = "b".repeat(64);
  for (const scope of ["project", "thread"]) {
    const path =
      scope === "project"
        ? `/api/projects/${managedRepository.projectId}/invitations`
        : "/api/threads/synthetic-thread/invitations";
    let responseLabel = "@johncena",
      extra = {};
    const f = fixture({
      passwordMode: true,
      sharedApi: true,
      sessionHeaders: async () => ({ Cookie: "synthetic-owner-session" }),
      fetchImpl: async () =>
        Response.json(
          {
            token,
            invitation: {
              id: "11111111-2222-4333-8444-555555555555",
              projectId: managedRepository.projectId,
              scope,
              ...(scope === "thread" ? { threadId: "synthetic-thread" } : {}),
              recipient: responseLabel,
              role: "editor",
              invitedBy: "account:synthetic-owner",
              expiresAt: new Date(Date.now() + 100000).toISOString(),
              ...extra,
            },
          },
          { status: 201 },
        ),
    });
    const headers = await nativeManagementHeaders(f.handler);
    const create = (input) =>
      request(f.handler, path, {
        method: "POST",
        headers,
        body: JSON.stringify({ ...input, role: "editor" }),
      });
    for (const input of ["johncena", "JoHnCeNa", "@JOHNCENA", " \t@JohnCena\r\n"]) {
      const accepted = await create({ recipient: input });
      assert.equal(accepted.status, 201, scope + input);
      assert.equal(accepted.json.token, token);
      assert.equal(accepted.json.invitation.recipient, "@johncena");
    }
    for (const wrong of ["@different", "@JohnCena", "johncena@synthetic.test", " @johncena "]) {
      responseLabel = wrong;
      const denied = await create({ recipient: "johncena" });
      assert.equal(denied.status, 503, scope + wrong);
      assert.ok(!denied.text.includes(token));
      assert.ok(!denied.text.includes(wrong));
    }
    responseLabel = "editor@synthetic.test";
    for (const key of ["recipient", "email"]) {
      const accepted = await create({ [key]: "EDITOR@SYNTHETIC.TEST" });
      assert.equal(accepted.status, 201, scope + key);
      assert.equal(accepted.json.token, token);
      for (const wrong of ["other@synthetic.test", "EDITOR@SYNTHETIC.TEST", "@editor"]) {
        responseLabel = wrong;
        const denied = await create({ [key]: "EDITOR@SYNTHETIC.TEST" });
        assert.equal(denied.status, 503, scope + key + wrong);
        assert.ok(!denied.text.includes(token));
        assert.ok(!denied.text.includes(wrong));
      }
      responseLabel = "editor@synthetic.test";
    }
    responseLabel = "@johncena";
    extra = { email: "johncena@synthetic.test" };
    const dual = await create({ recipient: "johncena" });
    assert.equal(dual.status, 503);
    assert.ok(!dual.text.includes(token));
  }
});
