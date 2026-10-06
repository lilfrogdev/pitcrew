import { betterAuth } from "better-auth";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { drizzle } from "drizzle-orm/d1";
import { jwtVerify } from "jose";
import * as schema from "./auth-schema";
import { authOptions } from "./auth-options";

export interface AuthEnv {
  AUTH_MODE?: string;
  AUTH_DB?: D1Database;
  BETTER_AUTH_SECRET?: string;
  BETTER_AUTH_URL?: string;
  AUTH_EMAIL_FROM?: string;
  AUTH_CLIENT_ORIGIN?: string;
  EMAIL?: SendEmail;
}
// This value MUST come from principal() after signature/issuer/audience checks.
export type AccessIdentity = { actor: string; email: string };
export const AUTH_EMAILS = ["dev@lilfrogdev.com", "bryan.aldair.zamora@gmail.com"] as const;
const clientOrigins = ["http://localhost:5173", "http://127.0.0.1:5173"];
export const authPaths = new Map([
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
function admitted(access: AccessIdentity) {
  return (
    /^access:[^\s]{1,256}$/.test(access.actor) &&
    AUTH_EMAILS.some((email) => email === access.email.toLowerCase())
  );
}
function bound(user: { email: string; accessActor?: unknown }, access: AccessIdentity) {
  return (
    admitted(access) &&
    user.accessActor === access.actor &&
    user.email.toLowerCase() === access.email.toLowerCase()
  );
}
function failure(error: string, status: number) {
  return Response.json({ error }, { status, headers: { "Cache-Control": "private, no-store" } });
}
export function configuredAuth(
  env: AuthEnv,
  request: Request,
  waitUntil: (task: Promise<unknown>) => void,
  access: AccessIdentity,
) {
  let base: URL;
  try {
    base = new URL(env.BETTER_AUTH_URL ?? "");
  } catch {
    return;
  }
  const clientOrigin = env.AUTH_CLIENT_ORIGIN ?? clientOrigins[0];
  if (
    env.AUTH_MODE !== "better-auth" ||
    !env.AUTH_DB ||
    !admitted(access) ||
    !env.BETTER_AUTH_SECRET ||
    env.BETTER_AUTH_SECRET.length < 32 ||
    base.protocol !== "https:" ||
    base.origin !== env.BETTER_AUTH_URL ||
    new URL(request.url).origin !== base.origin ||
    !clientOrigins.includes(clientOrigin) ||
    !env.EMAIL ||
    !env.AUTH_EMAIL_FROM ||
    !/^[a-zA-Z0-9._+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(env.AUTH_EMAIL_FROM)
  )
    return;
  const email = env.EMAIL,
    from = env.AUTH_EMAIL_FROM;
  const deliver = async (to: string, subject: string, token: string, kind: "verify" | "reset") => {
    // A fragment keeps tokens out of HTTP URLs, request logs, and referrers.
    // The local client strips it before redeeming through its authenticated relay.
    const url = `${clientOrigin}/auth/${kind}#token=${encodeURIComponent(token)}`;
    waitUntil(
      email
        .send({ to, from, subject, text: `${subject}: ${url}` })
        .then((result) => {
          if (!result || typeof result.messageId !== "string" || !result.messageId) throw Error();
        })
        .catch(() => {
          throw Error("auth_email_delivery_failed");
        }),
    );
  };
  const auth = betterAuth({
    ...authOptions,
    database: drizzleAdapter(drizzle(env.AUTH_DB, { schema }), {
      provider: "sqlite",
      schema,
      transaction: false,
    }),
    secret: env.BETTER_AUTH_SECRET,
    baseURL: base.origin,
    // Browser requests enter a same-origin loopback relay, which sets this origin.
    trustedOrigins: [base.origin],
    logger: { disabled: true },
    advanced: {
      useSecureCookies: true,
      cookiePrefix: "pitcrew-auth",
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
      backgroundTasks: {
        handler: (task) =>
          waitUntil(
            task.catch(() => {
              throw Error("auth_background_task_failed");
            }),
          ),
      },
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            if (!bound({ ...user, accessActor: access.actor }, access)) return false;
            return { data: { ...user, accessActor: access.actor } };
          },
        },
      },
    },
    emailVerification: {
      expiresIn: 900,
      autoSignInAfterVerification: false,
      sendOnSignUp: true,
      sendOnSignIn: false,
      sendVerificationEmail: async ({ user, token }) =>
        deliver(user.email, "Verify your Pitcrew email", token, "verify"),
    },
    emailAndPassword: {
      ...authOptions.emailAndPassword,
      sendResetPassword: async ({ user, token }) =>
        deliver(user.email, "Reset your Pitcrew password", token, "reset"),
    },
  });
  return Object.assign(auth, {
    // This atomic subject bucket counts malformed tokens and bodies before the
    // library's IP bucket. It is separate from Better Auth's cleanup-managed table.
    async consumeAdmission(action: string) {
      const rules: Record<string, { window: number; max: number }> =
        authOptions.rateLimit.customRules;
      const rule = rules[`/${action}`] ?? authOptions.rateLimit;
      const now = Date.now(),
        windowMs = rule.window * 1000;
      const key = JSON.stringify([access.actor, action]);
      const row = await env
        .AUTH_DB!.prepare(`INSERT INTO auth_admission(key,count,started_at) VALUES(?,1,?)
        ON CONFLICT(key) DO UPDATE SET
          count=CASE WHEN started_at<=? THEN 1 ELSE count+1 END,
          started_at=CASE WHEN started_at<=? THEN excluded.started_at ELSE started_at END
        WHERE started_at<=? OR count<? RETURNING count`)
        .bind(key, now, now - windowMs, now - windowMs, now - windowMs, rule.max)
        .first();
      if (row) return null;
      const existing = await env
        .AUTH_DB!.prepare("SELECT started_at FROM auth_admission WHERE key=?")
        .bind(key)
        .first<{ started_at: number }>();
      return Math.max(1, Math.ceil(((existing?.started_at ?? now) + windowMs - now) / 1000));
    },
  });
}
export type Auth = NonNullable<ReturnType<typeof configuredAuth>>;
export async function authUser(auth: Auth, request: Request, access: AccessIdentity) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session || !session.user.emailVerified || !bound(session.user, access)) return;
  return session.user;
}
function publicUser(user: Awaited<ReturnType<typeof authUser>>) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    emailVerified: user.emailVerified,
    name: user.name,
    username: user.username,
    image: user.image ?? null,
  };
}
async function readBody(request: Request) {
  if (request.headers.get("content-type")?.split(";", 1)[0].trim() !== "application/json")
    throw Error();
  const reader = request.clone().body?.getReader();
  if (!reader) throw Error();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 8192) throw Error();
      chunks.push(value);
    }
  } finally {
    void reader.cancel();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  const body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!body || typeof body !== "object" || Array.isArray(body)) throw Error();
  return body as Record<string, unknown>;
}
const bodyKeys: Record<string, string[]> = {
  "sign-up/email": ["email", "password", "name", "username", "image"],
  "sign-in/email": ["email", "password"],
  "sign-out": [],
  "get-session": [],
  "revoke-sessions": [],
  "update-user": ["name", "username", "image"],
  "change-password": ["currentPassword", "newPassword", "revokeOtherSessions"],
  "send-verification-email": ["email"],
  "request-password-reset": ["email"],
  "reset-password": ["token", "newPassword"],
};
export async function authRequest(
  auth: Auth,
  request: Request,
  access: AccessIdentity,
  exclusive: (operation: () => Promise<Response>) => Promise<Response>,
) {
  const url = new URL(request.url),
    path = url.pathname;
  if (!admitted(access)) return failure("identity_mismatch", 403);
  if (authPaths.get(path) !== request.method) return failure("not_found", 404);
  const action = path.slice("/api/auth/".length);
  if (request.method === "POST" && request.headers.get("origin") !== url.origin)
    return failure("origin_denied", 403);
  try {
    const retryAfter = await auth.consumeAdmission(action);
    if (retryAfter !== null)
      return Response.json(
        { error: "rate_limited" },
        {
          status: 429,
          headers: { "Cache-Control": "private, no-store", "X-Retry-After": String(retryAfter) },
        },
      );
  } catch {
    return failure("auth_unavailable", 503);
  }
  if (
    (action !== "verify-email" && url.search) ||
    (action === "verify-email" && [...url.searchParams.keys()].some((key) => key !== "token")) ||
    url.searchParams.getAll("token").length > 1
  )
    return failure("invalid_request", 400);
  let body: Record<string, unknown> = {};
  if (request.method === "POST") {
    try {
      body = await readBody(request);
    } catch {
      return failure("invalid_request", 400);
    }
    if (Object.keys(body).some((key) => !bodyKeys[action]?.includes(key)))
      return failure("invalid_request", 400);
    if (
      "email" in body &&
      (typeof body.email !== "string" || body.email.toLowerCase() !== access.email.toLowerCase())
    )
      return failure("identity_mismatch", 403);
    if (["sign-up/email", "update-user"].includes(action)) {
      if (
        (action === "sign-up/email" || "username" in body) &&
        (typeof body.username !== "string" || !/^[a-zA-Z0-9_]{3,32}$/.test(body.username))
      )
        return failure("invalid_profile", 400);
      if (
        (action === "sign-up/email" || "name" in body) &&
        (typeof body.name !== "string" || !body.name.trim() || body.name.length > 80)
      )
        return failure("invalid_profile", 400);
      // UI-owned initials/avatars. Arbitrary remote image URLs can leak client identity.
      if (
        body.image !== undefined &&
        body.image !== null &&
        (typeof body.image !== "string" || !/^\/avatars\/[a-z0-9_-]{1,40}\.svg$/.test(body.image))
      )
        return failure("invalid_profile", 400);
    }
  }
  // Ingest and bound caller-controlled streams before acquiring the shared
  // authority queue. Resolve all session/token authority again inside it.
  return exclusive(async () => {
    const context = await auth.$context;
    // No path, including token redemption, can act on a differently bound subject.
    if (typeof body.email === "string") {
      const existing = await context.internalAdapter.findUserByEmail(body.email.toLowerCase());
      if (existing && !bound(existing.user, access)) return failure("identity_mismatch", 403);
    }
    if (action === "verify-email") {
      try {
        const token = url.searchParams.get("token");
        if (!token || token.length > 4096) throw Error();
        const { payload } = await jwtVerify(token, new TextEncoder().encode(context.secret), {
          algorithms: ["HS256"],
        });
        if (typeof payload.email !== "string" || payload.updateTo || payload.requestType)
          throw Error();
        const found = await context.internalAdapter.findUserByEmail(payload.email);
        if (!found || !bound(found.user, access)) return failure("identity_mismatch", 403);
      } catch {
        return failure("invalid_token", 400);
      }
    } else if (action === "reset-password") {
      if (typeof body.token !== "string" || body.token.length > 256)
        return failure("invalid_token", 400);
      const verification = await context.internalAdapter.findVerificationValue(
        `reset-password:${body.token}`,
      );
      if (!verification || verification.expiresAt.getTime() <= Date.now())
        return failure("invalid_token", 400);
      const user = await context.internalAdapter.findUserById(verification.value);
      if (!user || !bound(user, access)) return failure("identity_mismatch", 403);
    } else if (
      ![
        "sign-up/email",
        "sign-in/email",
        "request-password-reset",
        "send-verification-email",
        "get-session",
      ].includes(action) &&
      !(await authUser(auth, request, access))
    )
      return failure("unauthorized", 401);
    let response: Response;
    try {
      response = await auth.handler(request);
    } catch {
      return failure("auth_unavailable", 503);
    }
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "private, no-store");
    if (!response.ok) {
      // Preserve throttling status and Retry-After, including on sign-in.
      return Response.json(
        {
          error:
            response.status === 429
              ? "rate_limited"
              : action === "sign-in/email"
                ? "invalid_credentials"
                : "auth_request_failed",
        },
        { status: response.status, headers },
      );
    }
    if (action === "sign-out") {
      // Better Auth catches a failed DELETE and can still return 200. Verify the
      // original session is gone before advertising completed revocation.
      try {
        if (await auth.api.getSession({ headers: request.headers }))
          return failure("auth_unavailable", 503);
      } catch {
        return failure("auth_unavailable", 503);
      }
    }
    if (action === "get-session") {
      const user = await authUser(auth, request, access);
      return Response.json(user ? { user: publicUser(user) } : null, { headers });
    }
    if (action === "sign-in/email") {
      // Better Auth's response includes a raw session token. Only its HttpOnly
      // cookie crosses this boundary and is retained by the local relay server.
      return Response.json({ status: true }, { headers });
    }
    if (action === "sign-up/email") return Response.json({ status: true }, { headers });
    return Response.json({ status: true }, { headers });
  });
}
