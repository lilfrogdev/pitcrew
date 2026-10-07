import { randomBytes, timingSafeEqual } from "node:crypto";
import { createRequire } from "node:module";
import { BACKEND_ACCESS, readCachedAccessToken, verifyUserAccessToken } from "./backend-relay.mjs";
const requireWorker = createRequire(new URL("../apps/worker/package.json", import.meta.url));
const { decodeJwt } = await import(requireWorker.resolve("jose"));
const cookieName = "pitcrew-auth-relay";
const cloudCookieName = "__Secure-pitcrew-auth.session_token";
const origins = ["http://localhost:5173", "http://127.0.0.1:5173"];
const lifetime = 30 * 60 * 1000;
const routes = new Map([
  ["/api/auth/sign-up/email", "POST"],
  ["/api/auth/sign-in/email", "POST"],
  ["/api/auth/sign-out", "POST"],
  ["/api/auth/get-session", "GET"],
  ["/api/auth/update-user", "POST"],
  ["/api/auth/change-password", "POST"],
  ["/api/auth/verify-email", "GET"],
  ["/api/auth/send-verification-email", "POST"],
  ["/api/auth/request-password-reset", "POST"],
  ["/api/auth/reset-password", "POST"],
  ["/api/auth/revoke-sessions", "POST"],
]);
const passwordRoutes = new Map([
  ["/api/auth/enroll", "POST"],
  ["/api/auth/sign-in/email", "POST"],
  ["/api/auth/sign-out", "POST"],
  ["/api/auth/get-session", "GET"],
  ["/api/auth/update-user", "POST"],
  ["/api/auth/change-password", "POST"],
  ["/api/auth/revoke-sessions", "POST"],
]);
const equal = (a, b) => {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const left = Buffer.from(a),
    right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
const loopback = (ip) => ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(ip);
function admitted(req, origin) {
  const counts = new Map();
  for (let i = 0; i < (req.rawHeaders?.length ?? 0); i += 2) {
    const name = req.rawHeaders[i].toLowerCase();
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return (
    origins.includes(origin) &&
    loopback(req.socket?.localAddress) &&
    loopback(req.socket?.remoteAddress) &&
    req.headers.host === new URL(origin).host &&
    (!req.headers.origin || req.headers.origin === origin) &&
    !["cross-site", "same-site"].includes(req.headers["sec-fetch-site"]) &&
    ["host", "origin", "content-type", "x-pitcrew-auth-nonce", "cookie"].every(
      (k) => (counts.get(k) ?? 0) <= 1,
    )
  );
}
function localCookie(req) {
  const values = (req.headers.cookie ?? "")
    .split(";")
    .map((p) => p.trim())
    .filter((p) => p.startsWith(cookieName + "="));
  return values.length === 1 && /^[a-f0-9]{64}$/.test(values[0].slice(cookieName.length + 1))
    ? values[0].slice(cookieName.length + 1)
    : undefined;
}
function reply(res, status, body, headers = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  res.end(JSON.stringify(body));
}
async function jsonBody(req) {
  if (req.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase() !== "application/json")
    throw Error();
  let size = 0;
  const chunks = [];
  const timer = setTimeout(() => req.destroy(), 5000);
  try {
    for await (const chunk of req) {
      size += Buffer.byteLength(chunk);
      if (size > 8192) throw Error();
      chunks.push(chunk);
    }
    const value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    );
    if (!value || typeof value !== "object" || Array.isArray(value)) throw Error();
    return JSON.stringify(value);
  } finally {
    clearTimeout(timer);
  }
}
async function responseJson(response) {
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
      size += value.length;
      if (size > 16384) throw Error();
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    void reader.cancel();
  }
}
function safeUser(value, passwordMode) {
  if (value === null) return null;
  const u = value?.user;
  if (
    !u ||
    typeof u.id !== "string" ||
    u.id.length > 128 ||
    !BACKEND_ACCESS.emails.includes(u.email) ||
    (passwordMode ? typeof u.emailVerified !== "boolean" : u.emailVerified !== true) ||
    typeof u.name !== "string" ||
    u.name.length > 80 ||
    typeof u.username !== "string" ||
    !/^[a-zA-Z0-9_]{3,32}$/.test(u.username) ||
    (u.image !== null &&
      (typeof u.image !== "string" || !/^\/avatars\/[a-z0-9_-]{1,40}\.svg$/.test(u.image)))
  )
    throw Error();
  return {
    user: {
      id: u.id,
      email: u.email,
      emailVerified: u.emailVerified,
      name: u.name,
      username: u.username,
      image: u.image,
    },
  };
}
export function createAuthRelayMiddleware({
  enabled = false,
  userAccessSession = false,
  passwordMode = false,
  origin = origins[0],
  tokenProvider = readCachedAccessToken,
  verifyAccess = verifyUserAccessToken,
  requestBackend = fetch,
  now = Date.now,
} = {}) {
  const sessions = new Map();
  const identity = async (token) => {
    const expiresAt = await verifyAccess(token);
    const claims = decodeJwt(token);
    if (!claims.sub || !BACKEND_ACCESS.emails.includes(claims.email) || expiresAt * 1000 <= now())
      throw Error();
    return { subject: claims.sub, email: claims.email, expiresAt: expiresAt * 1000 };
  };
  const prune = () => {
    for (const [id, s] of sessions) if (s.expiresAt <= now()) sessions.delete(id);
  };
  const lookup = (req) => {
    prune();
    return sessions.get(localCookie(req));
  };
  // Backend/provider relays call this only after their own loopback admission.
  // It still checks Host/origin/loopback and verifies the current Access token.
  const sessionHeaders = async (req, token) => {
    if (!enabled || (!passwordMode && !userAccessSession) || !admitted(req, origin)) return {};
    const s = lookup(req);
    if (!s?.cloudCookie) return {};
    if (passwordMode) return { Cookie: s.cloudCookie };
    const id = localCookie(req);
    const generation = s.generation;
    const current = () =>
      sessions.get(id) === s && generation === s.generation && s.expiresAt > now();
    try {
      const who = await identity(token);
      if (!current()) return {};
      if (who.subject !== s.subject || who.email !== s.email) {
        sessions.delete(id);
        return {};
      }
      return { Cookie: s.cloudCookie };
    } catch {
      if (current()) sessions.delete(id);
      return {};
    }
  };
  const handler = async (req, res, next = () => {}) => {
    const raw = req.url ?? "";
    if (!raw.startsWith("/") || raw.startsWith("//") || /[\\#]/.test(raw))
      return reply(res, 400, { error: "invalid_request" });
    let url;
    try {
      url = new URL(raw, origin);
    } catch {
      return reply(res, 400, { error: "invalid_request" });
    }
    if (!url.pathname.startsWith("/api/auth/")) return next();
    if (!enabled || (!passwordMode && !userAccessSession))
      return reply(res, 503, { error: "auth_relay_disabled" });
    if (!admitted(req, origin)) return reply(res, 403, { error: "auth_relay_denied" });
    if (url.pathname === "/api/auth/local-session" && req.method === "GET" && !url.search) {
      prune();
      let id = localCookie(req),
        s = lookup(req);
      if (!s) {
        if (sessions.size >= 128) return reply(res, 429, { error: "rate_limited" });
        id = randomBytes(32).toString("hex");
        s = { nonce: randomBytes(32).toString("hex"), expiresAt: now() + lifetime, generation: 0 };
        sessions.set(id, s);
      }
      return reply(
        res,
        200,
        { nonce: s.nonce },
        { "Set-Cookie": `${cookieName}=${id}; HttpOnly; SameSite=Strict; Path=/api; Max-Age=1800` },
      );
    }
    if (
      (passwordMode ? passwordRoutes : routes).get(url.pathname) !== req.method ||
      ((passwordMode || url.pathname !== "/api/auth/verify-email") && url.search) ||
      [...url.searchParams.keys()].some((k) => k !== "token") ||
      url.searchParams.getAll("token").length > 1
    )
      return reply(res, 404, { error: "not_found" });
    const s = lookup(req);
    if (!s || !equal(req.headers["x-pitcrew-auth-nonce"], s.nonce))
      return reply(res, 403, { error: "auth_relay_denied" });
    const id = localCookie(req);
    let generation = s.generation;
    const current = () =>
      sessions.get(id) === s && generation === s.generation && s.expiresAt > now();
    const superseded = () => reply(res, 409, { error: "auth_request_superseded" });
    let body;
    try {
      if (req.method === "POST") body = await jsonBody(req);
    } catch {
      return reply(res, 400, { error: "invalid_request" });
    }
    let token, who;
    if (!passwordMode)
      try {
        token = await tokenProvider();
        who = await identity(token);
      } catch {
        if (!current()) return superseded();
        sessions.delete(id);
        return reply(res, 401, { error: "backend_sign_in_required" });
      }
    // Body reads and Access verification can yield to another tab's mutation.
    // An older operation must not acquire a newer session's credential.
    if (!current()) return superseded();
    if (!passwordMode && s.subject && (who.subject !== s.subject || who.email !== s.email)) {
      sessions.delete(id);
      return reply(res, 401, { error: "backend_sign_in_required" });
    }
    if (!passwordMode) {
      s.subject = who.subject;
      s.email = who.email;
      s.expiresAt = Math.min(s.expiresAt, who.expiresAt);
    }
    // Drop the local credential before logout/revocation even if transport
    // fails. Keep a private copy only to authorize that one remote request.
    const sentCookie = s.cloudCookie;
    if (
      [
        "/api/auth/sign-in/email",
        "/api/auth/sign-out",
        "/api/auth/revoke-sessions",
        "/api/auth/reset-password",
      ].includes(url.pathname)
    ) {
      s.generation++;
      s.cloudCookie = undefined;
    }
    generation = s.generation;
    try {
      const response = await requestBackend(
        BACKEND_ACCESS.origin + (passwordMode ? "/app" : "") + url.pathname + url.search,
        {
          method: req.method,
          redirect: "manual",
          signal: AbortSignal.timeout(10000),
          headers: {
            Origin: BACKEND_ACCESS.origin,
            ...(!passwordMode ? { "Cf-Access-Token": token } : {}),
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
            ...(sentCookie && url.pathname !== "/api/auth/sign-in/email"
              ? { Cookie: sentCookie }
              : {}),
          },
          ...(body === undefined ? {} : { body }),
        },
      );
      if (!current()) return superseded();
      if (response.status >= 300 && response.status < 400) {
        // An empty native session read owns no credential to revoke. Deleting
        // its nonce record would also cancel a sign-in pending in another tab.
        if (!passwordMode || url.pathname !== "/api/auth/get-session" || s.cloudCookie)
          sessions.delete(id);
        return reply(res, 401, { error: "backend_sign_in_required" });
      }
      const value = await responseJson(response);
      if (!current()) return superseded();
      if (response.ok) {
        let nextCookie = s.cloudCookie;
        const cookies = response.headers.getSetCookie();
        for (const cookie of cookies) {
          const pair = cookie.split(";", 1)[0];
          if (pair.startsWith(cloudCookieName + "=")) {
            const v = pair.slice(cloudCookieName.length + 1);
            if (v.length > 4096 || /[\s;\r\n]/.test(v)) throw Error();
            nextCookie = v ? pair : undefined;
          }
        }
        if (
          ["/api/auth/sign-out", "/api/auth/revoke-sessions", "/api/auth/reset-password"].includes(
            url.pathname,
          )
        )
          nextCookie = undefined;
        const output =
          url.pathname === "/api/auth/get-session"
            ? safeUser(value, passwordMode)
            : { status: value?.status === true };
        if (url.pathname === "/api/auth/get-session" && output === null) nextCookie = undefined;
        // Installing a sign-in cookie is a second boundary: refreshes issued
        // while sign-in was pending queried the previous (empty) state.
        if (nextCookie !== s.cloudCookie || url.pathname === "/api/auth/sign-in/email") {
          s.cloudCookie = nextCookie;
          s.generation++;
        }
        return reply(res, 200, output);
      }
      if (response.status === 401 && s.cloudCookie) {
        s.cloudCookie = undefined;
        s.generation++;
      }
      return reply(
        res,
        [400, 401, 403, 404, 409, 422, 429, 503].includes(response.status) ? response.status : 502,
        {
          error:
            response.status === 429
              ? "rate_limited"
              : response.status === 503
                ? "auth_unavailable"
                : "auth_request_failed",
        },
        response.status === 429 && /^\d{1,6}$/.test(response.headers.get("x-retry-after") ?? "")
          ? { "X-Retry-After": response.headers.get("x-retry-after") }
          : {},
      );
    } catch {
      if (!current()) return superseded();
      if (s.cloudCookie) {
        s.cloudCookie = undefined;
        s.generation++;
      }
      return reply(res, 502, { error: "auth_backend_unavailable" });
    }
  };
  return Object.assign(handler, { sessionHeaders, clearSessions: () => sessions.clear() });
}
export function authRelayPlugin(options = {}) {
  const relay = createAuthRelayMiddleware(options);
  return {
    name: "pitcrew-auth-relay",
    sessionHeaders: relay.sessionHeaders,
    configureServer(server) {
      server.middlewares.use(relay);
      server.httpServer?.once("close", relay.clearSessions);
    },
  };
}
