import { randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { normalizePublicRepositoryImportUrl } from "../packages/protocol/src/repository-import-url.mjs";

const workerRequire = createRequire(new URL("../apps/worker/package.json", import.meta.url));
const { createRemoteJWKSet, jwtVerify } = await import(workerRequire.resolve("jose"));
export const BACKEND_ACCESS = Object.freeze({
  origin: "https://pitcrew-backend.pitcrew-004.workers.dev",
  issuer: "https://purple-mouse-ee03.cloudflareaccess.com",
  audience: "147a2e216894b65c6445fc8dec1a3347c6b1681e01089dd066f875a581e81683",
  email: "dev@lilfrogdev.com",
  emails: Object.freeze(["dev@lilfrogdev.com", "bryan.aldair.zamora@gmail.com"]),
});
const cookieName = "pitcrew-backend-nonce";
const lifetime = 30 * 60 * 1000;
const namePattern = /^[a-z0-9][a-z0-9-]{0,62}$/;
const statuses = new Set([
  "external",
  "pending",
  "cleanup_required",
  "ready",
  "deleting",
  "deleted",
]);
const safeErrors = new Set([
  "repository_backend_unavailable",
  "repository_name_retired",
  "deletion_pending",
  "import_source_authentication_required",
  "import_source_not_found",
  "import_limit_exceeded",
  "repository_exists",
  "repository_protected",
  "invalid_name",
  "invalid_public_url",
  "reconciliation_unavailable",
  "invalid_cursor",
  "credential_consent_required",
  "namespace_limit",
  "lifecycle_limit",
  "confirmation_required",
  "delete_not_confirmed",
  "repository_operation_failed",
  "body_too_large",
  "method_not_allowed",
  "not_found",
]);
const loopback = (value) => ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(value);
const equal = (left, right) => {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const a = Buffer.from(left),
    b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

// This command reads an existing application cache. It never runs access login.
// Activation and the user-owned login/cache scope are separate runtime gates.
export function readCachedAccessToken({ spawnProcess = spawn } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnProcess(
        "/Users/lilfrogdev/Library/Application Support/Pitcrew/bin/cloudflared",
        ["access", "token", `--app=${BACKEND_ACCESS.origin}`],
        {
          shell: false,
          env: { HOME: "/Users/lilfrogdev", PATH: "/usr/bin:/bin" },
          stdio: ["ignore", "pipe", "ignore"],
        },
      );
    } catch {
      reject(Error("backend_sign_in_required"));
      return;
    }
    let output = "",
      failed = false;
    const stop = () => {
      if (failed) return;
      failed = true;
      output = "";
      try {
        child.kill("SIGKILL");
      } catch {
        /* Await close before resolving. */
      }
    };
    const timer = setTimeout(stop, 10000);
    child.stdout.on("data", (bytes) => {
      if (failed) return;
      output += bytes.toString("utf8");
      if (Buffer.byteLength(output) > 16384) stop();
    });
    child.once("error", stop);
    child.stdout.once("error", stop);
    child.once("close", (code) => {
      clearTimeout(timer);
      const token = output.trim();
      output = "";
      if (failed || code !== 0 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token))
        reject(Error("backend_sign_in_required"));
      else resolve(token);
    });
  });
}
const keys = createRemoteJWKSet(new URL(`${BACKEND_ACCESS.issuer}/cdn-cgi/access/certs`), {
  timeoutDuration: 5000,
});
export async function verifyUserAccessToken(token, resolver = keys) {
  if (typeof token !== "string" || token.length > 16384) throw Error("backend_sign_in_required");
  const { payload } = await jwtVerify(token, resolver, {
    issuer: BACKEND_ACCESS.issuer,
    audience: BACKEND_ACCESS.audience,
    algorithms: ["RS256"],
    requiredClaims: ["sub", "email", "iat", "exp"],
  });
  const now = Math.floor(Date.now() / 1000);
  if (
    typeof payload.sub !== "string" ||
    !payload.sub ||
    typeof payload.email !== "string" ||
    !BACKEND_ACCESS.emails.includes(payload.email.toLowerCase()) ||
    typeof payload.iat !== "number" ||
    typeof payload.exp !== "number" ||
    payload.iat > now ||
    payload.exp <= payload.iat ||
    payload.exp - payload.iat > 1800
  )
    throw Error("backend_sign_in_required");
  return payload.exp;
}
function reply(res, status, value, extra = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    ...extra,
  });
  res.end(JSON.stringify(value));
}
function admitted(req, origin) {
  const expected = new URL(origin);
  const header = req.headers.origin;
  const singles = ["host", "origin", "content-type", "x-pitcrew-backend-nonce"];
  const counts = new Map();
  for (let i = 0; i < (req.rawHeaders?.length ?? 0); i += 2) {
    const name = req.rawHeaders[i].toLowerCase();
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return (
    singles.every((name) => (counts.get(name) ?? 0) <= 1) &&
    loopback(req.socket?.localAddress) &&
    loopback(req.socket?.remoteAddress) &&
    req.headers.host === expected.host &&
    (!header || header === origin) &&
    !["cross-site", "same-site"].includes(req.headers["sec-fetch-site"])
  );
}
function cookie(req) {
  const values = (req.headers.cookie ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${cookieName}=`));
  return values.length === 1 && /^[a-f0-9]{64}$/.test(values[0].slice(cookieName.length + 1))
    ? values[0].slice(cookieName.length + 1)
    : undefined;
}
async function body(req) {
  if (req.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase() !== "application/json")
    throw Object.assign(Error(), { status: 415 });
  const chunks = [];
  let size = 0;
  const timer = setTimeout(() => req.destroy(Object.assign(Error(), { status: 408 })), 5000);
  try {
    for await (const chunk of req) {
      size += Buffer.byteLength(chunk);
      if (size > 2048) throw Object.assign(Error(), { status: 413 });
      chunks.push(chunk);
    }
  } finally {
    clearTimeout(timer);
  }
  const parsed = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
  );
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw Error();
  return parsed;
}
function normalizeMutation(path, value) {
  const action = path.slice(path.lastIndexOf("/") + 1);
  const allowed =
    action === "import"
      ? ["name", "url", "credentialConsent"]
      : action === "create"
        ? ["name", "credentialConsent"]
        : action === "delete"
          ? ["name", "confirmation"]
          : ["name"];
  if (
    Object.keys(value).some((key) => !allowed.includes(key)) ||
    typeof value.name !== "string" ||
    !namePattern.test(value.name)
  )
    return false;
  if (action === "create" || action === "import") {
    if (value.credentialConsent !== true) return false;
    if (action === "import") {
      try {
        value.url = normalizePublicRepositoryImportUrl(value.url);
      } catch {
        return false;
      }
    }
  }
  return action !== "delete" || value.confirmation === value.name;
}
async function boundedJson(response) {
  if (response.headers.get("content-type")?.split(";", 1)[0].trim() !== "application/json")
    throw Error();
  const reader = response.body?.getReader();
  if (!reader) throw Error();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 262144) throw Error();
      chunks.push(value);
    }
  } catch {
    await reader.cancel().catch(() => {});
    throw Error();
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
function cleanResponse(path, value) {
  if (path === "/api/repositories") {
    if (
      !value ||
      !Array.isArray(value.repositories) ||
      value.repositories.length > 250 ||
      !(value.cursor === null || (typeof value.cursor === "string" && value.cursor.length <= 1024))
    )
      throw Error();
    return {
      repositories: value.repositories.map((item) => {
        if (
          typeof item?.name !== "string" ||
          !namePattern.test(item.name) ||
          !statuses.has(item.lifecycle) ||
          typeof item.deletable !== "boolean"
        )
          throw Error();
        return {
          name: item.name,
          lifecycle: item.lifecycle,
          deletable: item.deletable,
          ...(safeErrors.has(item.issue) ? { issue: item.issue } : {}),
        };
      }),
      cursor: value.cursor,
    };
  }
  if (
    typeof value?.name !== "string" ||
    !namePattern.test(value.name) ||
    !statuses.has(value.status)
  )
    throw Error();
  return {
    name: value.name,
    status: value.status,
    ...(safeErrors.has(value.issue) ? { issue: value.issue } : {}),
  };
}

/** Repository metadata only. This never proxies Work, inference, secrets, or arbitrary URLs. */
export function createBackendRelayMiddleware({
  enabled = false,
  userAccessSession = false,
  origin = "http://127.0.0.1:5173",
  fetchImpl = fetch,
  tokenProvider = readCachedAccessToken,
  verifyToken = verifyUserAccessToken,
} = {}) {
  const configuredOrigin = origin;
  const validOrigin = (value) => {
    try {
      const local = new URL(value);
      return local.protocol === "http:" && local.hostname === "127.0.0.1" && local.origin === value;
    } catch {
      return false;
    }
  };
  if (typeof configuredOrigin !== "function" && !validOrigin(configuredOrigin))
    throw Error("invalid_relay_origin");
  const sessions = new Map();
  let busy = false,
    active = 0,
    edgeAt = 0,
    cached,
    acquiring;
  async function token() {
    const now = Date.now();
    if (now - edgeAt > 30000) {
      const response = await fetchImpl(`${BACKEND_ACCESS.origin}/api/local-session`, {
        redirect: "manual",
        signal: AbortSignal.timeout(5000),
        headers: { Accept: "application/json" },
      });
      const location = response.headers.get("location");
      const login = location && new URL(location);
      await response.body?.cancel();
      if (
        ![302, 303].includes(response.status) ||
        login?.origin !== BACKEND_ACCESS.issuer ||
        !login.pathname.startsWith("/cdn-cgi/access/login/")
      )
        throw Error("backend_access_unverified");
      edgeAt = now;
    }
    if (cached && cached.exp * 1000 > now + 15000) return cached.token;
    acquiring ??= (async () => {
      const value = await tokenProvider();
      const exp = await verifyToken(value);
      cached = { token: value, exp };
      return value;
    })().finally(() => {
      acquiring = undefined;
    });
    return acquiring;
  }
  return async (req, res, next) => {
    const origin = typeof configuredOrigin === "function" ? configuredOrigin() : configuredOrigin;
    const raw = req.url ?? "";
    if (!validOrigin(origin)) {
      if (
        raw.startsWith("/api/repositories") ||
        (enabled && userAccessSession && raw.startsWith("/api/backend-session"))
      )
        return reply(res, 403, { error: "backend_relay_forbidden" });
      return next();
    }
    if (!raw.startsWith("/") || raw.startsWith("//")) return next();
    let url;
    try {
      url = new URL(raw, origin);
    } catch {
      return reply(res, 400, { error: "invalid_repository_request" });
    }
    const metadata =
      url.pathname === "/api/repositories" || url.pathname.startsWith("/api/repositories/");
    const session = url.pathname === "/api/backend-session";
    if (!metadata && !(session && enabled && userAccessSession)) return next();
    if (!admitted(req, origin)) return reply(res, 403, { error: "backend_relay_forbidden" });
    if (!enabled || !userAccessSession)
      return reply(res, 503, { error: "repository_backend_unavailable" });
    if (session) {
      if (req.method !== "GET" || url.search)
        return reply(res, 405, { error: "method_not_allowed" });
      const now = Date.now();
      for (const [value, expires] of sessions) if (expires <= now) sessions.delete(value);
      let nonce = cookie(req);
      if (!nonce || !sessions.has(nonce)) {
        if (sessions.size >= 32) return reply(res, 429, { error: "backend_relay_capacity" });
        nonce = randomBytes(32).toString("hex");
        sessions.set(nonce, now + lifetime);
      }
      return reply(
        res,
        200,
        { nonce },
        {
          "Set-Cookie": `${cookieName}=${nonce}; HttpOnly; SameSite=Strict; Path=/api; Max-Age=1800`,
        },
      );
    }
    const read = req.method === "GET" && url.pathname === "/api/repositories";
    const write =
      req.method === "POST" &&
      /^\/api\/repositories\/(create|import|reconcile|delete)$/.test(url.pathname);
    if (!read && !write) return reply(res, 405, { error: "method_not_allowed" });
    if (
      (write && url.search) ||
      [...url.searchParams.keys()].some((key) => key !== "cursor") ||
      url.searchParams.getAll("cursor").length > 1 ||
      (url.searchParams.get("cursor")?.length ?? 0) > 1024
    )
      return reply(res, 400, { error: "invalid_cursor" });
    let content;
    if (write) {
      const nonce = cookie(req);
      if (
        req.headers.origin !== origin ||
        !nonce ||
        (sessions.get(nonce) ?? 0) <= Date.now() ||
        !equal(nonce, req.headers["x-pitcrew-backend-nonce"])
      )
        return reply(res, 403, { error: "backend_session_required" });
      try {
        content = await body(req);
        if (!normalizeMutation(url.pathname, content)) throw Error();
      } catch (error) {
        return reply(res, error.status ?? 400, { error: "invalid_repository_request" });
      }
      if (busy) return reply(res, 409, { error: "backend_relay_busy" });
    }
    if (active >= 4) return reply(res, 429, { error: "backend_relay_capacity" });
    active++;
    if (write) busy = true;
    try {
      const access = await token();
      // Rebuild headers. Never forward browser Cookie/Authorization/identity, nonce or hints.
      const response = await fetchImpl(`${BACKEND_ACCESS.origin}${url.pathname}${url.search}`, {
        method: req.method,
        redirect: "manual",
        signal: AbortSignal.timeout(10000),
        headers: {
          Accept: "application/json",
          "Cf-Access-Token": access,
          ...(write ? { Origin: BACKEND_ACCESS.origin, "Content-Type": "application/json" } : {}),
        },
        ...(write ? { body: JSON.stringify(content) } : {}),
      });
      if ([301, 302, 303, 307, 308, 401, 403].includes(response.status)) {
        cached = undefined;
        await response.body?.cancel();
        return reply(res, 403, { error: "backend_sign_in_required" });
      }
      const value = await boundedJson(response);
      if (!response.ok)
        return reply(res, response.status, {
          error: safeErrors.has(value?.error) ? value.error : "repository_operation_failed",
        });
      return reply(res, response.status, cleanResponse(url.pathname, value));
    } catch {
      cached = undefined;
      return reply(res, 503, { error: "repository_backend_unavailable" });
    } finally {
      active--;
      if (write) busy = false;
    }
  };
}
export function backendRelayPlugin(options = {}) {
  return {
    name: "pitcrew-backend-relay",
    configureServer(server) {
      const address = server.config.server;
      if (options.enabled && address.host !== "127.0.0.1") throw Error("relay_requires_loopback");
      server.middlewares.use(
        createBackendRelayMiddleware({
          ...options,
          origin: () => {
            const listening = server.httpServer?.address();
            return listening && typeof listening !== "string" && listening.address === "127.0.0.1"
              ? `http://127.0.0.1:${listening.port}`
              : undefined;
          },
        }),
      );
    },
  };
}
