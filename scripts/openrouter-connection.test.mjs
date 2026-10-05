import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Writable, Readable } from "node:stream";
import { readFile } from "node:fs/promises";
import {
  createOpenRouterConnectionMiddleware,
  openRouterConnectionPlugin,
  storeOpenRouterSecret,
} from "./openrouter-connection.mjs";
const route = "/api/provider-connection/openrouter";
async function fixture(t, options = {}) {
  const origin = "http://127.0.0.1:5199";
  const stored = [];
  const handler = createOpenRouterConnectionMiddleware({
    origin,
    enabled: true,
    store: async (key) => stored.push(key),
    ...options,
  });
  const request = async (path = route, init = {}) => {
    const req = Readable.from(init.body ? [Buffer.from(init.body)] : []);
    req.url = path;
    req.method = init.method ?? "GET";
    req.headers = Object.fromEntries(
      Object.entries({ Host: "127.0.0.1:5199", Origin: origin, ...init.headers }).map(
        ([key, value]) => [key.toLowerCase(), value],
      ),
    );
    req.socket = { localAddress: "127.0.0.1", remoteAddress: "127.0.0.1", ...init.socket };
    let status, headers, body;
    await handler(
      req,
      {
        writeHead(code, values) {
          status = code;
          headers = values;
        },
        end(value) {
          body = value;
        },
      },
      () => {
        status = 404;
      },
    );
    return new Response(body, { status, headers });
  };
  const session = async () => {
    const result = await request(`${route}/session`);
    return {
      Cookie: result.headers.get("set-cookie").split(";")[0],
      "X-Pitcrew-Connection-Nonce": (await result.json()).nonce,
      "Content-Type": "application/json",
    };
  };
  return { request, session, stored, origin };
}
test("explicit authenticated save stores only key and returns sanitized disabled execution status", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await (await f.request()).json(), {
    available: true,
    configured: false,
    executionEnabled: false,
  });
  const headers = await f.session();
  const saved = await f.request(route, {
    method: "POST",
    headers,
    body: JSON.stringify({ action: "store", key: "mock-key-only" }),
  });
  assert.deepEqual(await saved.json(), {
    available: true,
    configured: true,
    executionEnabled: false,
  });
  assert.deepEqual(f.stored, ["mock-key-only"]);
  assert.match(saved.headers.get("cache-control"), /no-store/);
});
test("rejects cross-origin, missing session, forged cookie, duplicate cookie, wrong host and malformed requests", async (t) => {
  const f = await fixture(t);
  const headers = await f.session();
  const body = JSON.stringify({ action: "store", key: "mock-key" });
  for (const changed of [
    { Origin: "https://attacker.example" },
    { Origin: "" },
    { Cookie: "" },
    { "X-Pitcrew-Connection-Nonce": "0".repeat(64) },
    { "X-Pitcrew-Connection-Nonce": "é".repeat(64) },
    { Cookie: `${headers.Cookie}; ${headers.Cookie}` },
    { Host: "attacker.example" },
  ]) {
    assert.equal(
      (await f.request(route, { method: "POST", headers: { ...headers, ...changed }, body }))
        .status,
      403,
    );
  }
  for (const invalid of [
    JSON.stringify({ action: "store", key: "x", account: "other" }),
    JSON.stringify({ action: "store", key: "x\ny" }),
    "x".repeat(9000),
    "{}",
  ]) {
    assert.equal((await f.request(route, { method: "POST", headers, body: invalid })).status, 400);
  }
  for (const socket of [{ remoteAddress: "192.168.1.9" }, { localAddress: "0.0.0.0" }])
    assert.equal((await f.request(route, { method: "POST", headers, body, socket })).status, 403);
  assert.deepEqual(f.stored, []);
});
test("expired sessions cannot save and store diagnostics never reach response", async (t) => {
  let clock = 0;
  const f = await fixture(t, {
    now: () => clock,
    store: async () => {
      throw new Error("mock-secret-sensitive-output");
    },
  });
  const headers = await f.session();
  const post = () =>
    f.request(route, {
      method: "POST",
      headers,
      body: JSON.stringify({ action: "store", key: "mock-key" }),
    });
  const failure = await post();
  assert.equal(await failure.text(), '{"error":"provider_secret_store_failed"}');
  assert.equal((await (await f.request()).json()).configured, false);
  clock = 900_001;
  assert.equal((await post()).status, 403);
});
test("unavailable controller fails closed and wildcard host configuration is rejected", async (t) => {
  const f = await fixture(t, { enabled: false });
  assert.equal((await f.request()).status, 503);
  assert.throws(() => openRouterConnectionPlugin().configResolved({ server: { host: "0.0.0.0" } }));
});
test("Wrangler preflight and put use immutable target, stdin and discarded diagnostics", async () => {
  const inspections = [];
  const commands = [];
  const fakeSpawn = (binary, args, options) => {
    const child = new EventEmitter();
    const chunks = [];
    child.stdin = new Writable({
      write(chunk, _encoding, done) {
        chunks.push(chunk.toString());
        done();
      },
    });
    child.kill = () => {};
    commands.push(args.slice(1, args.indexOf("--config")));
    const inspect = (async () => {
      assert.equal(binary, process.execPath);
      assert.equal(options.shell, false);
      assert.deepEqual(options.stdio, ["pipe", "ignore", "ignore"]);
      assert.equal(args.includes("mock-key"), false);
      const config = JSON.parse(await readFile(args[args.indexOf("--config") + 1], "utf8"));
      assert.equal(config.name, "pitcrew-backend");
      assert.equal(config.account_id, "004227d2029c56b084ce15356768def3");
      assert.equal(Object.values(options.env).includes("mock-key"), false);
      assert.equal(chunks.join(""), args[2] === "put" ? "mock-key" : "");
      child.emit("close", 0);
    })();
    inspections.push(inspect);
    return child;
  };
  await storeOpenRouterSecret("mock-key", fakeSpawn);
  await Promise.all(inspections);
  assert.deepEqual(commands, [
    ["secret", "list"],
    ["secret", "put", "OPENROUTER_API_KEY"],
  ]);
});
test("failed target preflight never starts put or transmits the key", async () => {
  const commands = [],
    sent = [];
  const fakeSpawn = (_binary, args) => {
    const child = new EventEmitter();
    commands.push(args[2]);
    child.stdin = new Writable({
      write(chunk, _encoding, done) {
        sent.push(chunk.toString());
        done();
      },
    });
    child.kill = () => {};
    setImmediate(() => child.emit("close", 1));
    return child;
  };
  await assert.rejects(storeOpenRouterSecret("mock-key", fakeSpawn), {
    message: "provider_secret_store_failed",
  });
  assert.deepEqual(commands, ["list"]);
  assert.deepEqual(sent, []);
});

test("concurrent saves reject the second request while the first is active", async (t) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const f = await fixture(t, {
    store: async () => {
      calls++;
      await gate;
    },
  });
  const headers = await f.session();
  const post = () =>
    f.request(route, {
      method: "POST",
      headers,
      body: JSON.stringify({ action: "store", key: "mock-key" }),
    });
  const first = post();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await post()).status, 409);
  release();
  assert.equal((await first).status, 200);
  assert.equal(calls, 1);
});
