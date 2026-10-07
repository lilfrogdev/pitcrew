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

test("password mode never reads Access, accepts unverified controlled sessions and hides cloud credentials", async () => {
  const calls = [];
  let logoutFails = false;
  const relay = createAuthRelayMiddleware({
    enabled: true,
    passwordMode: true,
    tokenProvider: async () => {
      throw Error("Access must not be read");
    },
    verifyAccess: async () => {
      throw Error("Access must not be verified");
    },
    requestBackend: async (url, init) => {
      calls.push({ url, init });
      if (logoutFails) throw Error("synthetic transport failure");
      return Response.json(
        url.endsWith("get-session")
          ? {
              user: {
                id: "controlled-account",
                email: "dev@lilfrogdev.com",
                emailVerified: false,
                name: "Owner",
                username: "owner",
                image: null,
                accessActor: "must-not-leak",
              },
            }
          : { status: true, token: "must-not-leak" },
        {
          headers: url.endsWith("sign-in/email")
            ? { "Set-Cookie": cloudCookie + "; HttpOnly; Secure" }
            : {},
        },
      );
    },
  });
  const local = await call(relay, request("/api/auth/local-session"));
  const options = {
    cookie: local.headers["Set-Cookie"].split(";", 1)[0],
    nonce: local.value.nonce,
  };
  for (const path of [
    "sign-up/email",
    "request-password-reset",
    "reset-password",
    "send-verification-email",
    "sign-in/social",
  ])
    assert.equal(
      (await call(relay, request(`/api/auth/${path}`, { ...options, method: "POST", body: {} })))
        .status,
      404,
    );
  const login = await call(
    relay,
    request("/api/auth/sign-in/email", {
      ...options,
      method: "POST",
      body: { email: "dev@lilfrogdev.com", password: "synthetic" },
      headers: { "cf-access-jwt-assertion": "injected", authorization: "injected" },
    }),
  );
  assert.deepEqual(login.value, { status: true });
  assert.equal(login.headers["Set-Cookie"], undefined);
  assert.equal(calls[0].url, BACKEND_ACCESS.origin + "/app/api/auth/sign-in/email");
  assert.deepEqual(calls[0].init.headers, {
    Origin: BACKEND_ACCESS.origin,
    "Content-Type": "application/json",
  });
  const session = await call(relay, request("/api/auth/get-session", options));
  assert.equal(session.value.user.emailVerified, false);
  assert.equal(JSON.stringify(session.value).includes("must-not-leak"), false);
  assert.deepEqual(await relay.sessionHeaders(request("/api/projects", options)), {
    Cookie: cloudCookie,
  });
  logoutFails = true;
  assert.equal(
    (await call(relay, request("/api/auth/sign-out", { ...options, method: "POST", body: {} })))
      .status,
    502,
  );
  assert.deepEqual(await relay.sessionHeaders(request("/api/projects", options)), {});
});

test("late sign-in and session responses cannot restore a locally revoked password session", async () => {
  let release;
  const paused = new Promise((resolve) => {
    release = resolve;
  });
  let started;
  const seen = new Promise((resolve) => {
    started = resolve;
  });
  const relay = createAuthRelayMiddleware({
    enabled: true,
    passwordMode: true,
    requestBackend: async (url) => {
      if (url.endsWith("sign-in/email")) {
        started();
        await paused;
        return Response.json({ status: true }, { headers: { "Set-Cookie": cloudCookie } });
      }
      return Response.json({ status: true });
    },
  });
  const local = await call(relay, request("/api/auth/local-session"));
  const options = {
    cookie: local.headers["Set-Cookie"].split(";", 1)[0],
    nonce: local.value.nonce,
  };
  const login = call(
    relay,
    request("/api/auth/sign-in/email", { ...options, method: "POST", body: {} }),
  );
  await seen;
  assert.equal(
    (await call(relay, request("/api/auth/sign-out", { ...options, method: "POST", body: {} })))
      .status,
    200,
  );
  release();
  assert.equal((await login).status, 409);
  assert.deepEqual(await relay.sessionHeaders(request("/api/projects", options)), {});
});

async function passwordFixture(requestBackend) {
  const relay = createAuthRelayMiddleware({ enabled: true, passwordMode: true, requestBackend });
  const local = await call(relay, request("/api/auth/local-session"));
  const options = {
    cookie: local.headers["Set-Cookie"].split(";", 1)[0],
    nonce: local.value.nonce,
  };
  return {
    relay,
    options,
    login: () =>
      call(relay, request("/api/auth/sign-in/email", { ...options, method: "POST", body: {} })),
    session: () => call(relay, request("/api/auth/get-session", options)),
    headers: () => relay.sessionHeaders(request("/api/projects", options)),
  };
}

test("a null refresh started during sign-in cannot clear the subsequently installed cookie", async () => {
  const loginStarted = Promise.withResolvers();
  const refreshStarted = Promise.withResolvers();
  const loginResponse = Promise.withResolvers();
  const refreshResponse = Promise.withResolvers();
  const f = await passwordFixture(async (url, init) => {
    if (url.endsWith("sign-in/email")) {
      loginStarted.resolve();
      return loginResponse.promise;
    }
    assert.equal(init.headers.Cookie, undefined);
    refreshStarted.resolve();
    return refreshResponse.promise;
  });
  const login = f.login();
  await loginStarted.promise;
  const refresh = f.session();
  await refreshStarted.promise;
  loginResponse.resolve(
    Response.json({ status: true }, { headers: { "Set-Cookie": cloudCookie } }),
  );
  assert.equal((await login).status, 200);
  refreshResponse.resolve(Response.json(null));
  assert.equal((await refresh).status, 409);
  assert.deepEqual(await f.headers(), { Cookie: cloudCookie });
});

test("delayed failures and logout from another tab cannot wipe a newer sign-in", async (t) => {
  for (const path of ["get-session", "sign-out"]) {
    for (const failure of ["transport", "redirect", "invalid-json", "unauthorized", "success"]) {
      await t.test(`${path}: ${failure}`, async () => {
        const started = Promise.withResolvers();
        const delayed = Promise.withResolvers();
        let loginCount = 0;
        const f = await passwordFixture(async (url) => {
          if (url.endsWith("sign-in/email")) {
            loginCount++;
            return Response.json(
              { status: true },
              {
                headers: { "Set-Cookie": cloudCookie + loginCount },
              },
            );
          }
          started.resolve();
          return delayed.promise;
        });
        await f.login();
        const old = call(
          f.relay,
          request(`/api/auth/${path}`, {
            ...f.options,
            ...(path === "sign-out" ? { method: "POST", body: {} } : {}),
          }),
        );
        await started.promise;
        await f.login();
        if (failure === "transport") delayed.reject(Error("synthetic old transport error"));
        else
          delayed.resolve(
            failure === "redirect"
              ? new Response(null, {
                  status: 302,
                  headers: { Location: "https://example.com/private" },
                })
              : failure === "invalid-json"
                ? new Response("invalid", { headers: { "Content-Type": "application/json" } })
                : failure === "success"
                  ? Response.json(
                      { status: true },
                      { headers: { "Set-Cookie": cloudCookie + "old" } },
                    )
                  : Response.json({ error: "private" }, { status: 401 }),
          );
        assert.equal((await old).status, 409);
        assert.deepEqual(await f.headers(), { Cookie: cloudCookie + "2" });
      });
    }
  }
});

test("a logout waiting for its request body cannot acquire a newer sign-in cookie", async () => {
  const calls = [];
  const f = await passwordFixture(async (url, init) => {
    calls.push({ url, init });
    return Response.json({ status: true }, { headers: { "Set-Cookie": cloudCookie } });
  });
  const slowLogout = request("/api/auth/sign-out", { ...f.options, method: "POST", body: {} });
  const body = new Readable({ read() {} });
  Object.assign(body, {
    url: slowLogout.url,
    method: slowLogout.method,
    headers: slowLogout.headers,
    rawHeaders: slowLogout.rawHeaders,
    socket: slowLogout.socket,
  });
  const pending = call(f.relay, body);
  await f.login();
  body.push(Buffer.from("{}"));
  body.push(null);
  assert.equal((await pending).status, 409);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.endsWith("sign-in/email"));
  assert.deepEqual(await f.headers(), { Cookie: cloudCookie });
});

test("repeated overlapping tab refreshes cannot restore or clear later session state", async () => {
  let pending;
  let counter = 0;
  const f = await passwordFixture(async (url) => {
    if (url.endsWith("sign-in/email"))
      return Response.json(
        { status: true },
        {
          headers: { "Set-Cookie": cloudCookie + ++counter },
        },
      );
    if (url.endsWith("sign-out")) return Response.json({ status: true });
    pending.started.resolve();
    return pending.response.promise;
  });
  for (let cycle = 0; cycle < 3; cycle++) {
    await f.login();
    pending = { started: Promise.withResolvers(), response: Promise.withResolvers() };
    const old = f.session();
    await pending.started.promise;
    await call(f.relay, request("/api/auth/sign-out", { ...f.options, method: "POST", body: {} }));
    assert.deepEqual(await f.headers(), {});
    await f.login();
    pending.response.resolve(Response.json(null));
    await old;
    assert.deepEqual(await f.headers(), { Cookie: cloudCookie + counter });
  }
});
