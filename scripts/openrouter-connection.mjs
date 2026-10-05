import { randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const route = "/api/provider-connection/openrouter";
const cookieName = "pitcrew-provider-session";
const maxBytes = 8192;
const target = Object.freeze({
  name: "pitcrew-backend",
  account_id: "004227d2029c56b084ce15356768def3",
  compatibility_date: "2026-10-04",
  send_metrics: false,
});
const loopback = (address) =>
  address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
const equal = (a, b) => {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const left = Buffer.from(a),
    right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

// Only the key travels through stdin. This function never returns CLI diagnostics.
export async function storeOpenRouterSecret(key, spawnProcess = spawn) {
  const directory = await mkdtemp(join(tmpdir(), "pitcrew-provider-"));
  try {
    const configPath = join(directory, "target.json");
    const logPath = join(directory, "discard.log");
    await writeFile(configPath, JSON.stringify(target), { mode: 0o600 });
    await symlink("/dev/null", logPath);
    const env = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      CLOUDFLARE_ACCOUNT_ID: target.account_id,
      WRANGLER_SEND_METRICS: "false",
      WRANGLER_LOG_PATH: logPath,
      WRANGLER_LOG_SANITIZE: "true",
      CI: "true",
    };
    const runWrangler = (args, value) =>
      new Promise((resolve, reject) => {
        const child = spawnProcess(
          process.execPath,
          [
            join(dirname(require.resolve("wrangler/package.json")), "bin/wrangler.js"),
            ...args,
            "--config",
            configPath,
            "--env=",
          ],
          { cwd: directory, env, shell: false, stdio: ["pipe", "ignore", "ignore"] },
        );
        let finished = false;
        const finish = (success) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          child.stdin.destroy();
          if (success) resolve();
          else reject(new Error("provider_secret_store_failed"));
        };
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          finish(false);
        }, 30_000);
        child.once("error", () => finish(false));
        child.once("close", (code) => finish(code === 0));
        child.stdin.once("error", () => {
          child.kill("SIGKILL");
          finish(false);
        });
        child.stdin.end(value);
      });
    // secret put can create a draft Worker if absent. First require this fixed
    // Worker to exist. The separate operations cannot eliminate deletion races.
    await runWrangler(["secret", "list"]);
    await runWrangler(["secret", "put", "OPENROUTER_API_KEY"], key);
  } catch {
    throw new Error("provider_secret_store_failed");
  } finally {
    key = "";
    try {
      await rm(directory, { recursive: true, force: true });
    } catch {
      // This directory contains only fixed public target metadata and a /dev/null symlink.
      // A cleanup failure must not hide the result or expose CLI diagnostics.
    }
  }
}

function reply(res, status, value, headers = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  res.end(JSON.stringify(value));
}

// Dependency injection is for offline tests. Production uses the fixed store above.
export function createOpenRouterConnectionMiddleware({
  origin,
  store = storeOpenRouterSecret,
  enabled = false,
  now = Date.now,
} = {}) {
  const sessions = new Map();
  let configured = false;
  let saving = false;
  const status = () => ({ available: enabled, configured, executionEnabled: false });
  return async (req, res, next) => {
    const path = req.url?.split("?", 1)[0];
    if (path !== route && path !== `${route}/session`) return next();
    const expected = typeof origin === "function" ? origin() : origin;
    if (
      !expected ||
      !loopback(req.socket.localAddress) ||
      !loopback(req.socket.remoteAddress) ||
      req.headers.host !== new URL(expected).host ||
      (req.headers.origin !== undefined && req.headers.origin !== expected) ||
      (req.headers["sec-fetch-site"] !== "same-origin" && req.headers.origin !== expected)
    ) {
      return reply(res, 403, { error: "provider_connection_forbidden" });
    }
    if (!enabled) return reply(res, 503, status());
    if (req.method === "GET" && path === route) return reply(res, 200, status());
    if (req.method === "GET" && path === `${route}/session`) {
      for (const [id, expiry] of sessions) if (expiry <= now()) sessions.delete(id);
      if (sessions.size >= 128) return reply(res, 429, { error: "provider_session_limit" });
      const nonce = randomBytes(32).toString("hex");
      sessions.set(nonce, now() + 15 * 60_000);
      return reply(
        res,
        200,
        { nonce },
        {
          "Set-Cookie": `${cookieName}=${nonce}; HttpOnly; SameSite=Strict; Path=${route}; Max-Age=900`,
        },
      );
    }
    if (req.method !== "POST" || path !== route)
      return reply(res, 405, { error: "provider_method_not_allowed" }, { Allow: "GET, POST" });
    if (req.headers.origin !== expected)
      return reply(res, 403, { error: "provider_connection_forbidden" });
    const cookies = (req.headers.cookie ?? "")
      .split(";")
      .map((part) => part.trim())
      .filter((part) => part.startsWith(`${cookieName}=`));
    const cookie = cookies.length === 1 ? cookies[0].slice(cookieName.length + 1) : "";
    if (
      !/^[a-f0-9]{64}$/.test(cookie) ||
      (sessions.get(cookie) ?? 0) <= now() ||
      !equal(cookie, req.headers["x-pitcrew-connection-nonce"])
    ) {
      return reply(res, 403, { error: "provider_session_required" });
    }
    if (
      req.headers["content-type"] !== "application/json" ||
      req.headers["content-encoding"] ||
      (req.headers["content-length"] &&
        (!/^\d+$/.test(req.headers["content-length"]) ||
          Number(req.headers["content-length"]) > maxBytes))
    ) {
      return reply(res, 400, { error: "provider_request_invalid" });
    }
    if (saving) return reply(res, 409, { error: "provider_store_in_progress" });
    let raw = "",
      body,
      acquired = false;
    const bodyTimer = setTimeout(() => req.destroy(), 10_000);
    try {
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > maxBytes) throw new Error("too_large");
        raw += chunk.toString("utf8");
      }
      clearTimeout(bodyTimer);
      body = JSON.parse(raw);
      raw = "";
      if (
        !body ||
        Object.keys(body).sort().join(",") !== "action,key" ||
        body.action !== "store" ||
        typeof body.key !== "string" ||
        !/^[\x21-\x7e]{1,4096}$/.test(body.key)
      ) {
        return reply(res, 400, { error: "provider_request_invalid" });
      }
      if (saving) return reply(res, 409, { error: "provider_store_in_progress" });
      saving = true;
      acquired = true;
      await store(body.key);
      configured = true;
      reply(res, 200, status());
    } catch {
      reply(res, 400, { error: "provider_secret_store_failed" });
    } finally {
      clearTimeout(bodyTimer);
      raw = "";
      if (body) body.key = "";
      if (acquired) saving = false;
    }
  };
}

// Install before Vite's proxy. Never enable on a wildcard/network listener.
export function openRouterConnectionPlugin({ enabled = false } = {}) {
  return {
    name: "pitcrew-openrouter-connection",
    configResolved(config) {
      if (config.server.host !== "127.0.0.1")
        throw new Error("Provider connection requires server.host=127.0.0.1");
    },
    configureServer(server) {
      server.middlewares.use(
        createOpenRouterConnectionMiddleware({
          enabled,
          origin: () => {
            const address = server.httpServer?.address();
            return address && typeof address !== "string" && address.address === "127.0.0.1"
              ? `http://127.0.0.1:${address.port}`
              : undefined;
          },
        }),
      );
    },
  };
}
