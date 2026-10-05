import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Writable, Readable } from "node:stream";
import { access, readFile, readlink, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import {
  createOpenRouterConnectionMiddleware,
  openRouterConnectionPlugin,
  removeOpenRouterSecret,
  storeOpenRouterSecret,
} from "./openrouter-connection.mjs";

const route = "/api/provider-connection/openrouter";
const require = createRequire(import.meta.url);
const realSetTimeout = globalThis.setTimeout;
const mutation = (action) => (action === "store" ? { action, key: "mock-key" } : { action });

async function fixture(t, options = {}) {
  const origin = "http://127.0.0.1:5199";
  const stored = [],
    removed = [];
  const handler = createOpenRouterConnectionMiddleware({
    origin,
    enabled: true,
    userWranglerAuth: true,
    store: async (key) => {
      stored.push(key);
    },
    remove: async (...args) => {
      removed.push(args);
    },
    ...options,
  });
  const request = async (path = route, init = {}) => {
    const req = Readable.from(init.chunks ?? (init.body ? [Buffer.from(init.body)] : []));
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
  const post = (headers, body, init = {}) =>
    request(route, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      ...init,
    });
  return { request, session, post, stored, removed, origin };
}

test("authenticated save, replace and remove return sanitized status with execution disabled", async (t) => {
  const f = await fixture(t);
  const expected = {
    available: true,
    storageAvailable: true,
    configured: false,
    executionEnabled: false,
  };
  assert.deepEqual(await (await f.request()).json(), expected);
  const headers = await f.session();
  for (const key of ["mock-key-only", "mock-replacement-key"]) {
    const saved = await f.post(headers, { action: "store", key });
    assert.equal(saved.status, 200);
    assert.deepEqual(await saved.json(), { ...expected, configured: true });
    assert.match(saved.headers.get("cache-control"), /no-store/);
    assert.equal(saved.headers.get("x-content-type-options"), "nosniff");
  }
  assert.deepEqual(f.stored, ["mock-key-only", "mock-replacement-key"]);
  const removed = await f.post(headers, { action: "remove" });
  assert.equal(removed.status, 200);
  assert.deepEqual(await removed.json(), expected);
  assert.deepEqual(f.removed, [[]]);
  assert.deepEqual(await (await f.request()).json(), expected);
});

test("store and remove reject foreign origins, invalid sessions, wrong hosts and nonloopback sockets", async (t) => {
  const f = await fixture(t);
  const headers = await f.session();
  for (const action of ["store", "remove"]) {
    for (const changed of [
      { Origin: "https://attacker.example" },
      { Origin: "" },
      { Origin: undefined, "Sec-Fetch-Site": "same-origin" },
      { Cookie: "" },
      { "X-Pitcrew-Connection-Nonce": "0".repeat(64) },
      { "X-Pitcrew-Connection-Nonce": "é".repeat(64) },
      { Cookie: `${headers.Cookie}; ${headers.Cookie}` },
      { Host: "attacker.example" },
    ]) {
      assert.equal((await f.post({ ...headers, ...changed }, mutation(action))).status, 403);
    }
    for (const socket of [{ remoteAddress: "192.168.1.9" }, { localAddress: "0.0.0.0" }]) {
      assert.equal((await f.post(headers, mutation(action), { socket })).status, 403);
    }
  }
  assert.deepEqual(f.stored, []);
  assert.deepEqual(f.removed, []);
});

test("only exact store and remove bodies are accepted and rejected input never reaches operations", async (t) => {
  const f = await fixture(t);
  const headers = await f.session();
  for (const invalid of [
    { action: "store", key: "x", account: "other" },
    { action: "store", key: "x\ny" },
    { action: "store", key: "é" },
    { action: "store", key: "" },
    { action: "store", key: "x".repeat(4097) },
    { action: "store", key: 42 },
    { action: "store" },
    { action: "remove", key: "mock-key" },
    { action: "remove", account: "other" },
    { action: "remove", name: "other-worker" },
    { action: "remove", args: ["--force"] },
    { action: "remove", userWranglerAuth: true },
    { action: "remove", XDG_CONFIG_HOME: "/other/path" },
    { action: "delete" },
    {},
    [],
    null,
    42,
    "mock-key",
  ]) {
    const rejected = await f.post(headers, invalid);
    assert.equal(rejected.status, 400);
    assert.deepEqual(await rejected.json(), { error: "provider_request_invalid" });
  }
  const malformed = await f.request(route, {
    method: "POST",
    headers,
    body: "mock-secret-not-json",
  });
  assert.equal(malformed.status, 400);
  assert.equal(await malformed.text(), '{"error":"provider_request_invalid"}');
  assert.deepEqual(f.stored, []);
  assert.deepEqual(f.removed, []);
});

test("request headers and streamed body bytes remain bounded for both operations", async (t) => {
  const f = await fixture(t);
  const headers = await f.session();
  for (const action of ["store", "remove"]) {
    for (const changed of [
      { "Content-Type": "text/plain" },
      { "Content-Type": "application/json; charset=utf-8" },
      { "Content-Encoding": "gzip" },
      { "Content-Length": "8193" },
      { "Content-Length": "-1" },
      { "Content-Length": "NaN" },
    ]) {
      assert.equal((await f.post({ ...headers, ...changed }, mutation(action))).status, 400);
    }
    const payload = JSON.stringify(mutation(action));
    const oversized = await f.post(headers, mutation(action), {
      chunks: [Buffer.from(payload), Buffer.alloc(8193 - Buffer.byteLength(payload), " ")],
    });
    assert.equal(oversized.status, 400);
    assert.deepEqual(await oversized.json(), { error: "provider_request_invalid" });
  }
  assert.deepEqual(f.stored, []);
  assert.deepEqual(f.removed, []);
  const payload = JSON.stringify({ action: "remove" });
  assert.equal(
    (
      await f.post(
        headers,
        { action: "remove" },
        {
          chunks: [Buffer.from(payload), Buffer.alloc(8192 - Buffer.byteLength(payload), " ")],
        },
      )
    ).status,
    200,
  );
  assert.deepEqual(f.removed, [[]]);
});

test("expired sessions cannot store or remove", async (t) => {
  let clock = 0;
  const f = await fixture(t, { now: () => clock });
  const headers = await f.session();
  clock = 900_001;
  for (const action of ["store", "remove"]) {
    assert.equal((await f.post(headers, mutation(action))).status, 403);
  }
  assert.deepEqual(f.stored, []);
  assert.deepEqual(f.removed, []);
});

test("failed operations suppress diagnostics, preserve configured state and release the lock", async (t) => {
  let failStore = true,
    failRemove = true;
  const f = await fixture(t, {
    store: async () => {
      if (failStore) throw new Error("mock-secret-sensitive-store-output");
    },
    remove: async () => {
      if (failRemove) throw new Error("mock-secret-sensitive-remove-output");
    },
  });
  const headers = await f.session();
  const failedStore = await f.post(headers, mutation("store"));
  assert.equal(failedStore.status, 400);
  assert.equal(await failedStore.text(), '{"error":"provider_secret_store_failed"}');
  assert.equal((await (await f.request()).json()).configured, false);
  failStore = false;
  assert.equal((await f.post(headers, mutation("store"))).status, 200);
  const failedRemove = await f.post(headers, mutation("remove"));
  assert.equal(failedRemove.status, 400);
  assert.equal(await failedRemove.text(), '{"error":"provider_secret_remove_failed"}');
  assert.equal((await (await f.request()).json()).configured, true);
  failRemove = false;
  assert.equal((await f.post(headers, mutation("remove"))).status, 200);
  assert.equal((await (await f.request()).json()).configured, false);
});

test("storage is unavailable until the explicit boolean auth option is approved", async (t) => {
  for (const userWranglerAuth of [false, undefined, "true"]) {
    const f = await fixture(t, { userWranglerAuth });
    assert.deepEqual(await (await f.request()).json(), {
      available: true,
      storageAvailable: false,
      configured: false,
      executionEnabled: false,
    });
    const headers = await f.session();
    for (const action of ["store", "remove"]) {
      const rejected = await f.post(headers, mutation(action));
      assert.equal(rejected.status, 503);
      assert.deepEqual(await rejected.json(), { error: "provider_storage_unavailable" });
    }
    assert.deepEqual(f.stored, []);
    assert.deepEqual(f.removed, []);
  }
});

test("unavailable controller fails closed and wildcard host configuration is rejected", async (t) => {
  const f = await fixture(t, { enabled: false });
  const result = await f.request();
  assert.equal(result.status, 503);
  assert.deepEqual(await result.json(), {
    available: false,
    storageAvailable: false,
    configured: false,
    executionEnabled: false,
  });
  assert.throws(() => openRouterConnectionPlugin().configResolved({ server: { host: "0.0.0.0" } }));
});

test("direct secret helpers fail before spawning unless auth is explicitly enabled", async () => {
  let calls = 0;
  const spawnProcess = () => {
    calls++;
    throw new Error("must not spawn");
  };
  for (const userWranglerAuth of [false, undefined, "true"]) {
    const options = { userWranglerAuth, spawnProcess };
    await assert.rejects(storeOpenRouterSecret("mock-key", options), {
      message: "provider_storage_unavailable",
    });
    await assert.rejects(removeOpenRouterSecret(options), {
      message: "provider_storage_unavailable",
    });
  }
  assert.equal(calls, 0);
});

test("Wrangler operations use a fixed target, child-only auth context, stdin and discarded diagnostics", async (t) => {
  for (const action of ["store", "remove"]) {
    await t.test(action, async () => {
      const commands = [],
        inspections = [],
        directories = [];
      const parentHome = process.env.HOME,
        parentConfigHome = process.env.XDG_CONFIG_HOME;
      const spawnProcess = (binary, args, options) => {
        const child = new EventEmitter(),
          chunks = [];
        child.stdin = new Writable({
          write(chunk, _encoding, done) {
            chunks.push(chunk.toString());
            done();
          },
        });
        child.kill = () => {};
        commands.push(args.slice(2, args.indexOf("--config")));
        directories.push(options.cwd);
        const inspection = (async () => {
          assert.equal(binary, process.execPath);
          assert.deepEqual(args.slice(0, 2), [
            "--no-warnings",
            join(dirname(require.resolve("wrangler/package.json")), "wrangler-dist/cli.js"),
          ]);
          assert.equal(options.shell, false);
          assert.deepEqual(options.stdio, ["pipe", "ignore", "ignore"]);
          assert.equal(args.includes("mock-key"), false);
          assert.equal(args.at(-1), "--env=");
          const configPath = args[args.indexOf("--config") + 1];
          assert.equal(options.cwd, dirname(configPath));
          assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), {
            name: "pitcrew-backend",
            account_id: "004227d2029c56b084ce15356768def3",
            compatibility_date: "2026-10-04",
            send_metrics: false,
          });
          assert.equal((await stat(configPath)).mode & 0o777, 0o600);
          assert.equal(await readlink(options.env.WRANGLER_LOG_PATH), "/dev/null");
          assert.deepEqual(Object.keys(options.env).sort(), [
            "CI",
            "CLOUDFLARE_ACCOUNT_ID",
            "CLOUDFLARE_AUTH_USE_KEYRING",
            "HOME",
            "PATH",
            "TMPDIR",
            "WRANGLER_LOG_PATH",
            "WRANGLER_LOG_SANITIZE",
            "WRANGLER_SEND_METRICS",
            "XDG_CONFIG_HOME",
          ]);
          assert.equal(options.env.HOME, parentHome);
          assert.equal(options.env.XDG_CONFIG_HOME, "/Users/lilfrogdev/Library/Preferences");
          assert.equal(options.env.CLOUDFLARE_ACCOUNT_ID, "004227d2029c56b084ce15356768def3");
          assert.equal(options.env.CLOUDFLARE_AUTH_USE_KEYRING, "false");
          assert.equal(options.env.CI, "true");
          assert.equal(options.env.WRANGLER_SEND_METRICS, "false");
          assert.equal(options.env.WRANGLER_LOG_SANITIZE, "true");
          assert.equal(Object.values(options.env).includes("mock-key"), false);
          assert.equal(chunks.join(""), args[3] === "put" ? "mock-key" : "");
        })();
        inspections.push(inspection);
        inspection.then(
          () => child.emit("close", 0),
          () => child.emit("close", 1),
        );
        return child;
      };
      const options = { userWranglerAuth: true, spawnProcess };
      if (action === "store") await storeOpenRouterSecret("mock-key", options);
      else await removeOpenRouterSecret(options);
      await Promise.all(inspections);
      assert.deepEqual(commands, [
        ["secret", "list"],
        ["secret", action === "store" ? "put" : "delete", "OPENROUTER_API_KEY"],
      ]);
      for (const directory of directories)
        await assert.rejects(access(directory), { code: "ENOENT" });
      assert.equal(process.env.HOME, parentHome);
      assert.equal(process.env.XDG_CONFIG_HOME, parentConfigHome);
    });
  }
});

test("failed target preflight never starts put or delete or transmits a key", async () => {
  for (const action of ["store", "remove"]) {
    const commands = [],
      sent = [];
    const spawnProcess = (_binary, args) => {
      const child = new EventEmitter();
      commands.push(args[3]);
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
    const options = { userWranglerAuth: true, spawnProcess };
    await assert.rejects(
      action === "store"
        ? storeOpenRouterSecret("mock-key", options)
        : removeOpenRouterSecret(options),
      {
        message: `provider_secret_${action}_failed`,
      },
    );
    assert.deepEqual(commands, ["list"]);
    assert.deepEqual(sent, []);
  }
});

test("subprocess exit, spawn and stdin failures remain sanitized for both operations", async () => {
  for (const action of ["store", "remove"]) {
    for (const errorMode of ["exit", "spawn", "event", "stdin"]) {
      const commands = [],
        killed = [];
      const spawnProcess = (_binary, args) => {
        commands.push(args[3]);
        if (errorMode === "spawn") throw new Error("mock-secret-sensitive-spawn-error");
        const child = new EventEmitter();
        child.stdin = new Writable({
          write(_chunk, _encoding, done) {
            done();
          },
        });
        child.kill = (signal) => {
          killed.push(signal);
          setImmediate(() => child.emit("close", null, signal));
        };
        setImmediate(() => {
          if (errorMode === "event")
            child.emit("error", new Error("mock-secret-sensitive-child-error"));
          else if (errorMode === "stdin")
            child.stdin.emit("error", new Error("mock-secret-sensitive-stdin-error"));
          else child.emit("close", args[3] === "list" ? 0 : 1);
        });
        return child;
      };
      const options = { userWranglerAuth: true, spawnProcess };
      await assert.rejects(
        action === "store"
          ? storeOpenRouterSecret("mock-key", options)
          : removeOpenRouterSecret(options),
        {
          message: `provider_secret_${action}_failed`,
        },
      );
      assert.deepEqual(
        commands,
        errorMode === "exit" ? ["list", action === "store" ? "put" : "delete"] : ["list"],
      );
      assert.deepEqual(killed, ["event", "stdin"].includes(errorMode) ? ["SIGKILL"] : []);
    }
  }
});

test("termination waits for close before settling, releasing the lock or removing config", async (t) => {
  for (const action of ["store", "remove"]) {
    for (const phase of ["preflight", "mutation"]) {
      for (const errorMode of ["timeout", "stdin"]) {
        await t.test(`${action} ${phase} ${errorMode}`, async (t) => {
          t.mock.timers.enable({ apis: ["setTimeout"] });
          const commands = [],
            killed = [];
          let heldChild,
            configPath,
            hold = true,
            closed = false,
            notifyReady;
          const ready = new Promise((resolve) => {
            notifyReady = resolve;
          });
          const spawnProcess = (_binary, args) => {
            const child = new EventEmitter();
            const command = args[3];
            commands.push(command);
            child.stdin = new Writable({
              write(_chunk, _encoding, done) {
                done();
              },
            });
            child.kill = (signal) => {
              killed.push(signal);
              return true;
            };
            if (hold && (phase === "preflight" ? command === "list" : command !== "list")) {
              heldChild = child;
              configPath = args[args.indexOf("--config") + 1];
              notifyReady();
            } else {
              setImmediate(() => child.emit("close", 0));
            }
            return child;
          };
          const options = { userWranglerAuth: true, spawnProcess };
          const f = await fixture(t, {
            store: (key) => storeOpenRouterSecret(key, options),
            remove: () => removeOpenRouterSecret(options),
          });
          const headers = await f.session();
          let settled = false;
          const pending = f.post(headers, mutation(action)).then((result) => {
            settled = true;
            return result;
          });
          t.after(async () => {
            if (!closed && heldChild) heldChild.emit("close", null, "SIGKILL");
            await pending;
          });
          await ready;
          if (errorMode === "timeout") t.mock.timers.tick(30_000);
          else heldChild.stdin.emit("error", new Error("mock-secret-sensitive-stdin-error"));
          assert.deepEqual(killed, ["SIGKILL"]);
          heldChild.emit("exit", null, "SIGKILL");
          // Allow asynchronous cleanup to run if the operation incorrectly settled.
          await new Promise((resolve) => realSetTimeout(resolve, 20));
          assert.equal(settled, false);
          await access(configPath);
          assert.deepEqual(
            commands,
            phase === "preflight" ? ["list"] : ["list", action === "store" ? "put" : "delete"],
          );
          for (const competingAction of ["store", "remove"]) {
            const busy = await f.post(headers, mutation(competingAction));
            assert.equal(busy.status, 409);
            assert.deepEqual(await busy.json(), { error: "provider_store_in_progress" });
          }
          hold = false;
          closed = true;
          // A failure must stay a failure even if close reports a zero exit code.
          heldChild.emit("close", 0);
          const failed = await pending;
          assert.equal(failed.status, 400);
          assert.deepEqual(await failed.json(), { error: `provider_secret_${action}_failed` });
          assert.equal((await (await f.request()).json()).configured, false);
          await assert.rejects(access(configPath), { code: "ENOENT" });
          assert.equal((await f.post(headers, mutation(action))).status, 200);
        });
      }
    }
  }
});

test("save and remove share a lock that rejects any overlapping mutation", async (t) => {
  for (const activeAction of ["store", "remove"]) {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const wait = async () => {
      calls++;
      await gate;
    };
    const f = await fixture(t, { store: wait, remove: wait });
    const headers = await f.session();
    const first = f.post(headers, mutation(activeAction));
    await new Promise((resolve) => setImmediate(resolve));
    for (const action of ["store", "remove"]) {
      const busy = await f.post(headers, mutation(action));
      assert.equal(busy.status, 409);
      assert.deepEqual(await busy.json(), { error: "provider_store_in_progress" });
    }
    release();
    assert.equal((await first).status, 200);
    assert.equal(calls, 1);
    assert.equal((await f.post(headers, mutation(activeAction))).status, 200);
    assert.equal(calls, 2);
  }
});
