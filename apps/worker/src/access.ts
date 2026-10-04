import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { fixtureAccess } from "./api";
export interface AccessEnv {
  ENVIRONMENT: string;
  FIXTURE_IDENTITY?: string;
  ACCESS_ISSUER?: string;
  ACCESS_AUDIENCE?: string;
  ACCESS_EMAIL?: string;
  ACCESS_HOSTNAME?: string;
}
let cached: { issuer: string; keys: JWTVerifyGetKey } | undefined;
export async function principal(
  request: Request,
  env: AccessEnv,
  keys?: JWTVerifyGetKey,
): Promise<{ actor: string } | undefined> {
  if (fixtureAccess(request, env)) return { actor: "lilfrogdev" };
  if (
    env.ENVIRONMENT !== "production" ||
    !env.ACCESS_ISSUER ||
    !/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(env.ACCESS_ISSUER) ||
    !env.ACCESS_AUDIENCE ||
    !env.ACCESS_EMAIL ||
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
      payload.email.toLowerCase() !== env.ACCESS_EMAIL.toLowerCase() ||
      typeof payload.sub !== "string" ||
      !payload.sub ||
      typeof payload.iat !== "number" ||
      payload.iat > Math.floor(Date.now() / 1000)
    )
      return;
    return { actor: `access:${payload.sub}` };
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
  const response = new URL(request.url).pathname.startsWith("/api/")
    ? await api(request)
    : assets
      ? await assets.fetch(request)
      : Response.json({ error: "assets_unconfigured" }, { status: 503 });
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "private, no-store");
  return new Response(response.body, { status: response.status, headers });
}
