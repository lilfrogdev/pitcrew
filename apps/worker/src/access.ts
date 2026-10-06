import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { fixtureAccess } from "./api";
export interface AccessEnv {
  ENVIRONMENT: string;
  FIXTURE_IDENTITY?: string;
  ACCESS_ISSUER?: string;
  ACCESS_AUDIENCE?: string;
  ACCESS_EMAIL?: string;
  ACCESS_EMAILS?: string;
  ACCESS_HOSTNAME?: string;
}
const cookieName = "pitcrew-local-nonce";
const noncePattern = /^[a-f0-9]{64}$/;
function localNonce(request: Request) {
  const values = (request.headers.get("cookie") ?? "")
    .split(";")
    .map((value) => value.trim())
    .filter((value) => value.startsWith(`${cookieName}=`));
  if (values.length !== 1) return;
  const value = values[0].slice(cookieName.length + 1);
  return noncePattern.test(value) ? value : undefined;
}
function trustedLocalOrigin(request: Request) {
  const url = new URL(request.url);
  const origin = request.headers.get("origin");
  // The fixed Vite preview port is the only separate browser admission origin.
  return (
    origin === url.origin ||
    ["http://localhost:5173", "http://127.0.0.1:5173"].includes(origin ?? "")
  );
}
let cached: { issuer: string; keys: JWTVerifyGetKey } | undefined;
function allowedEmails(env: AccessEnv): string[] {
  if (env.ACCESS_EMAILS === undefined)
    return env.ACCESS_EMAIL ? [env.ACCESS_EMAIL.toLowerCase()] : [];
  try {
    const emails: unknown = JSON.parse(env.ACCESS_EMAILS);
    return Array.isArray(emails) &&
      emails.length > 0 &&
      emails.every(
        (email) => typeof email === "string" && /^[^\s@*]+@[^\s@*]+\.[^\s@*]+$/.test(email),
      )
      ? emails.map((email: string) => email.toLowerCase())
      : [];
  } catch {
    return [];
  }
}
export async function principal(
  request: Request,
  env: AccessEnv,
  keys?: JWTVerifyGetKey,
): Promise<{ actor: string; email: string } | undefined> {
  if (fixtureAccess(request, env)) {
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
      const nonce = localNonce(request);
      if (
        !trustedLocalOrigin(request) ||
        !nonce ||
        (request.headers.get("x-pitcrew-local-nonce") ??
          request.headers.get("x-pitcrew-connection-nonce")) !== nonce
      )
        return;
    }
    return { actor: "lilfrogdev", email: "dev@lilfrogdev.com" };
  }
  if (
    env.ENVIRONMENT !== "production" ||
    !env.ACCESS_ISSUER ||
    !/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(env.ACCESS_ISSUER) ||
    !env.ACCESS_AUDIENCE ||
    !allowedEmails(env).length ||
    !env.ACCESS_HOSTNAME
  )
    return;
  const url = new URL(request.url);
  if (url.protocol !== "https:" || url.hostname !== env.ACCESS_HOSTNAME) return;
  if (
    !["GET", "HEAD", "OPTIONS"].includes(request.method) &&
    request.headers.get("origin") !== url.origin
  )
    return;
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token || token.length > 16384) return;
  try {
    if (!keys) {
      if (cached?.issuer !== env.ACCESS_ISSUER)
        cached = {
          issuer: env.ACCESS_ISSUER,
          keys: createRemoteJWKSet(new URL(`${env.ACCESS_ISSUER}/cdn-cgi/access/certs`), {
            timeoutDuration: 5000,
          }),
        };
      keys = cached.keys;
    }
    const { payload } = await jwtVerify(token, keys, {
      issuer: env.ACCESS_ISSUER,
      audience: env.ACCESS_AUDIENCE,
      algorithms: ["RS256"],
      requiredClaims: ["sub", "email", "exp", "iat"],
    });
    if (
      typeof payload.email !== "string" ||
      !allowedEmails(env).includes(payload.email.toLowerCase()) ||
      typeof payload.sub !== "string" ||
      !payload.sub ||
      typeof payload.iat !== "number" ||
      payload.iat > Math.floor(Date.now() / 1000)
    )
      return;
    return { actor: `access:${payload.sub}`, email: payload.email.toLowerCase() };
  } catch {
    return;
  }
}
export async function protectedFetch(
  request: Request,
  env: AccessEnv,
  api: (request: Request) => Promise<Response>,
  assets?: Pick<Fetcher, "fetch">,
  keys?: JWTVerifyGetKey,
) {
  if (!(await principal(request, env, keys)))
    return Response.json(
      { error: "access_not_configured_or_denied" },
      { status: 403, headers: { "Cache-Control": "no-store" } },
    );
  if (
    ["/api/local-session", "/api/provider-connection/openrouter/session"].includes(
      new URL(request.url).pathname,
    ) &&
    request.method === "GET"
  ) {
    if (!fixtureAccess(request, env))
      return Response.json({ nonce: null }, { headers: { "Cache-Control": "private, no-store" } });
    if (
      (request.headers.has("origin") && !trustedLocalOrigin(request)) ||
      ["cross-site", "same-site"].includes(request.headers.get("sec-fetch-site") ?? "")
    )
      return Response.json({ error: "local_session_denied" }, { status: 403 });
    const nonce =
      localNonce(request) ??
      Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
    return Response.json(
      { nonce },
      {
        headers: {
          "Cache-Control": "private, no-store",
          "Set-Cookie": `${cookieName}=${nonce}; HttpOnly; SameSite=Strict; Path=/api${new URL(request.url).protocol === "https:" ? "; Secure" : ""}`,
        },
      },
    );
  }
  const response = new URL(request.url).pathname.startsWith("/api/")
    ? await api(request)
    : assets
      ? await assets.fetch(request)
      : Response.json({ error: "assets_unconfigured" }, { status: 503 });
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "private, no-store");
  return new Response(response.body, { status: response.status, headers });
}
