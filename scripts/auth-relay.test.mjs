import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { createAuthRelayMiddleware, authRelayPlugin } from "./auth-relay.mjs";
import { BACKEND_ACCESS } from "./backend-relay.mjs";
const origin = "http://localhost:5173";
const jwt = (sub = "owner", email = "dev@lilfrogdev.com") =>
  ["e30", Buffer.from(JSON.stringify({ sub, email })).toString("base64url"), "synthetic"].join(".");
const cloudCookie = "__Secure-pitcrew-auth.session_token=synthetic-signed-cookie";
function request(
  path,
  { method = "GET", cookie, nonce, body, headers = {}, socket = {}, rawHeaders } = {},
) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  req.url = path;
  req.method = method;
  req.headers = {
    host: "localhost:5173",
    ...(method === "POST" ? { origin, "content-type": "application/json" } : {}),
    ...(cookie ? { cookie } : {}),
    ...(nonce ? { "x-pitcrew-auth-nonce": nonce } : {}),
    ...headers,
  };
  req.socket = { localAddress: "127.0.0.1", remoteAddress: "127.0.0.1", ...socket };
  req.rawHeaders = rawHeaders ?? Object.entries(req.headers).flatMap(([k, v]) => [k, v]);
  return req;
}
async function call(handler, req) {
  let status,
    headers,
    value,
    next = false;
  await handler(
    req,
    {
      writeHead(s, h) {
        status = s;
        headers = h;
      },
      end(b) {
        value = JSON.parse(b);
      },
    },
    () => {
      next = true;
    },
  );
  return { status, headers, value, next };
}
async function fixture(backend) {
  let currentToken = jwt(),
    currentTime = Date.now(),
    calls = [];
  const relay = createAuthRelayMiddleware({
    enabled: true,
    userAccessSession: true,
    tokenProvider: async () => currentToken,
    verifyAccess: async () => Math.floor(currentTime / 1000) + 1800,
    now: () => currentTime,
    requestBackend: async (url, init) => {
      calls.push({ url, init });
      if (backend) return backend(url, init);
      return Response.json(
        url.includes("get-session")
          ? {
              user: {
                id: "fixture-account",
                email: "dev@lilfrogdev.com",
                emailVerified: true,
                name: "Owner",
                username: "owner",
                image: null,
                accessActor: "must-not-leak",
                token: "must-not-leak",
              },
            }
          : { status: true, token: "must-not-leak" },
        {
          headers: url.includes("sign-in/email")
            ? { "Set-Cookie": cloudCookie + "; HttpOnly; Secure; Path=/; SameSite=Lax" }
            : {},
        },
      );
    },
  });
  const local = await call(relay, request("/api/auth/local-session"));
  return {
    relay,
    local,
    calls,
    cookie: local.headers["Set-Cookie"].split(";", 1)[0],
    nonce: local.value.nonce,
    changeIdentity: () => {
      currentToken = jwt("bryan", "bryan.aldair.zamora@gmail.com");
    },
    expire: () => {
      currentTime += 1800001;
    },
  };
}
test("default gates and loopback Host/origin/duplicate/nonce admission fail closed", async () => {
  assert.equal(
    (await call(createAuthRelayMiddleware(), request("/api/auth/local-session"))).status,
    503,
  );
  const f = await fixture();
  assert.match(f.local.headers["Set-Cookie"], /HttpOnly; SameSite=Strict; Path=\/api/);
  for (const options of [
    { headers: { host: "evil.example" } },
    { headers: { origin: "https://evil.example" } },
    { socket: { remoteAddress: "192.0.2.1" } },
    { headers: { "sec-fetch-site": "cross-site" } },
    { rawHeaders: ["Host", "localhost:5173", "Host", "localhost:5173"] },
  ]) {
    assert.equal((await call(f.relay, request("/api/auth/local-session", options))).status, 403);
  }
  assert.equal(
    (await call(f.relay, request("/api/auth/get-session", { cookie: f.cookie }))).status,
    403,
  );
  assert.equal(
    (await call(f.relay, request("/api/auth/get-session", { cookie: f.cookie, nonce: "x" })))
      .status,
    403,
  );
  assert.equal(
    (
      await call(
        f.relay,
        request("/api/auth/get-session", { cookie: f.cookie, nonce: "é".repeat(64) }),
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await call(
        f.relay,
        request("/api/auth/get-session", { cookie: f.cookie + "; " + f.cookie, nonce: f.nonce }),
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await call(
        f.relay,
        request("/api/auth/sign-in/social", {
          method: "POST",
          cookie: f.cookie,
          nonce: f.nonce,
          body: {},
        }),
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await call(
        f.relay,
        request("/api/auth/get-session?arbitrary=1", { cookie: f.cookie, nonce: f.nonce }),
      )
    ).status,
    404,
  );
  assert.equal(f.calls.length, 0);
});
test("only fixed backend + verified Access + server cookie are sent; responses omit tokens/cookies, signout and changed subject clear session", async () => {
  const f = await fixture();
  const login = await call(
    f.relay,
    request("/api/auth/sign-in/email", {
      method: "POST",
      cookie: f.cookie,
      nonce: f.nonce,
      body: { email: "dev@lilfrogdev.com", password: "synthetic-password" },
      headers: { authorization: "injected", "cf-access-jwt-assertion": "injected" },
    }),
  );
  assert.deepEqual(login.value, { status: true });
  assert.equal(login.headers["Set-Cookie"], undefined);
  const sent = f.calls[0];
  assert.equal(sent.url, BACKEND_ACCESS.origin + "/api/auth/sign-in/email");
  assert.equal(sent.init.redirect, "manual");
  assert.deepEqual(sent.init.headers, {
    Origin: BACKEND_ACCESS.origin,
    "Cf-Access-Token": jwt(),
    "Content-Type": "application/json",
  });
  const get = await call(
    f.relay,
    request("/api/auth/get-session", { cookie: f.cookie, nonce: f.nonce }),
  );
  assert.deepEqual(get.value, {
    user: {
      id: "fixture-account",
      email: "dev@lilfrogdev.com",
      emailVerified: true,
      name: "Owner",
      username: "owner",
      image: null,
    },
  });
  assert.equal(f.calls[1].init.headers.Cookie, cloudCookie);
  assert.deepEqual(
    await f.relay.sessionHeaders(request("/api/projects", { cookie: f.cookie }), jwt()),
    { Cookie: cloudCookie },
  );
  assert.deepEqual(
    await f.relay.sessionHeaders(
      request("/api/projects", { cookie: f.cookie, headers: { host: "evil" } }),
      jwt(),
    ),
    {},
  );
  f.changeIdentity();
  assert.equal(
    (await call(f.relay, request("/api/auth/get-session", { cookie: f.cookie, nonce: f.nonce })))
      .status,
    401,
  );
  assert.deepEqual(
    await f.relay.sessionHeaders(request("/api/projects", { cookie: f.cookie }), jwt()),
    {},
  );
  const logout = await fixture();
  await call(
    logout.relay,
    request("/api/auth/sign-in/email", {
      method: "POST",
      cookie: logout.cookie,
      nonce: logout.nonce,
      body: {},
    }),
  );
  await call(
    logout.relay,
    request("/api/auth/sign-out", {
      method: "POST",
      cookie: logout.cookie,
      nonce: logout.nonce,
      body: {},
    }),
  );
  assert.deepEqual(
    await logout.relay.sessionHeaders(request("/api/projects", { cookie: logout.cookie }), jwt()),
    {},
  );
});
test("Access redirects, malformed upstream, throttles and expiration sanitize failure without exposing sensitive material", async () => {
  const redirects = await fixture(
    () =>
      new Response(null, {
        status: 302,
        headers: { Location: BACKEND_ACCESS.issuer + "/cdn-cgi/access/login/synthetic-secret" },
      }),
  );
  const denied = await call(
    redirects.relay,
    request("/api/auth/get-session", { cookie: redirects.cookie, nonce: redirects.nonce }),
  );
  assert.equal(denied.status, 401);
  assert.equal(JSON.stringify(denied).includes("synthetic-secret"), false);
  const throttle = await fixture(() =>
    Response.json(
      { error: "synthetic-secret" },
      { status: 429, headers: { "X-Retry-After": "300" } },
    ),
  );
  const limited = await call(
    throttle.relay,
    request("/api/auth/get-session", { cookie: throttle.cookie, nonce: throttle.nonce }),
  );
  assert.equal(limited.status, 429);
  assert.equal(limited.headers["X-Retry-After"], "300");
  assert.deepEqual(limited.value, { error: "rate_limited" });
  const malformed = await fixture(() => Response.json({ user: { token: "synthetic-secret" } }));
  const bad = await call(
    malformed.relay,
    request("/api/auth/get-session", { cookie: malformed.cookie, nonce: malformed.nonce }),
  );
  assert.equal(bad.status, 502);
  assert.deepEqual(bad.value, { error: "auth_backend_unavailable" });
  const expired = await fixture();
  expired.expire();
  assert.equal(
    (
      await call(
        expired.relay,
        request("/api/auth/get-session", { cookie: expired.cookie, nonce: expired.nonce }),
      )
    ).status,
    403,
  );
  const plugin = authRelayPlugin();
  assert.equal(plugin.name, "pitcrew-auth-relay");
  assert.equal(typeof plugin.sessionHeaders, "function");
});
test("malformed and absolute request targets fail safely without token reads", async () => {
  for (const options of [{}, { enabled: true, userAccessSession: true }]) {
    let tokens = 0;
    const relay = createAuthRelayMiddleware({
      ...options,
      tokenProvider: async () => {
        tokens++;
        return jwt();
      },
    });
    for (const target of [
      "/\\[",
      "//evil.example/api/auth/get-session",
      "https://evil.example/api/auth/get-session",
      "/api/auth/get-session#secret",
    ]) {
      const result = await call(relay, request(target));
      assert.equal(result.status, 400);
      assert.deepEqual(result.value, { error: "invalid_request" });
    }
    assert.equal(tokens, 0);
  }
});
