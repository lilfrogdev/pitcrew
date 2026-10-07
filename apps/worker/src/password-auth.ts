import { betterAuth } from "better-auth";
import { username } from "better-auth/plugins";
import { normalizeUsername, validUsername } from "./auth-username";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./auth-schema";
import { authOptions } from "./auth-options";
import type { AuthEnv } from "./auth";

const recipients = ["dev@lilfrogdev.com", "bryan.aldair.zamora@gmail.com"];
type Grant = { id: string; recipient_email: string };
export const passwordAuthPaths = new Map([
  ["/api/auth/enroll", "POST"],
  ["/api/auth/sign-in/username", "POST"],
  ["/api/auth/get-session", "GET"],
  ["/api/auth/sign-out", "POST"],
  ["/api/auth/revoke-sessions", "POST"],
  ["/api/auth/update-user", "POST"],
  ["/api/auth/change-password", "POST"],
]);
const fields: Record<string, string[]> = {
  enroll: ["code", "password", "name", "username", "image"],
  "sign-in/username": ["username", "password"],
  "sign-out": [],
  "revoke-sessions": [],
  "update-user": ["name", "username", "image"],
  "change-password": ["currentPassword", "newPassword", "revokeOtherSessions"],
};
function errorResponse(error: string, status: number, retryAfter?: number) {
  return Response.json(
    { error },
    {
      status,
      headers: {
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        ...(retryAfter ? { "X-Retry-After": String(retryAfter) } : {}),
      },
    },
  );
}
export async function capabilityHash(code: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
function buildAuth(
  env: AuthEnv & { AUTH_DB: D1Database; BETTER_AUTH_SECRET: string },
  origin: string,
  waitUntil: (task: Promise<unknown>) => void,
  grant?: Grant,
) {
  return betterAuth({
    ...authOptions,
    plugins: [
      username({
        displayUsername: false,
        minUsernameLength: 3,
        maxUsernameLength: 32,
        usernameValidator: validUsername,
        usernameNormalization: normalizeUsername,
      }),
    ],
    disabledPaths: ["/is-username-available"],
    database: drizzleAdapter(drizzle(env.AUTH_DB, { schema }), {
      provider: "sqlite",
      schema,
      transaction: false,
    }),
    secret: env.BETTER_AUTH_SECRET,
    baseURL: origin,
    trustedOrigins: [origin],
    logger: { disabled: true },
    emailAndPassword: {
      ...authOptions.emailAndPassword,
      disableSignUp: !grant,
      requireEmailVerification: false,
      autoSignIn: false,
    },
    // No callbacks or delivery bindings exist in password-only mode.
    emailVerification: { sendOnSignUp: false, sendOnSignIn: false },
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
            if (
              !grant ||
              !recipients.includes(grant.recipient_email) ||
              user.email !== grant.recipient_email
            )
              return false;
            // This legacy column stores a distinct provenance key, not a claim
            // that Access authenticated anyone. Eligibility also needs the D1
            // grant's consumed_user_id binding below.
            return {
              data: { ...user, emailVerified: false, accessActor: `enrollment:${grant.id}` },
            };
          },
        },
      },
    },
  });
}
export function configuredPasswordAuth(
  env: AuthEnv,
  request: Request,
  waitUntil: (task: Promise<unknown>) => void,
) {
  let base: URL;
  try {
    base = new URL(env.BETTER_AUTH_URL ?? "");
  } catch {
    return;
  }
  if (
    env.AUTH_MODE !== "password-only" ||
    !env.AUTH_DB ||
    !env.BETTER_AUTH_SECRET ||
    env.BETTER_AUTH_SECRET.length < 32 ||
    base.protocol !== "https:" ||
    base.origin !== env.BETTER_AUTH_URL ||
    new URL(request.url).origin !== base.origin
  )
    return;
  const configured = { ...env, AUTH_DB: env.AUTH_DB, BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET };
  const auth = buildAuth(configured, base.origin, waitUntil);
  const db = configured.AUTH_DB;
  async function consume(key: string, window: number, max: number) {
    const now = Date.now(),
      cutoff = now - window * 1000;
    const row = await db
      .prepare(`INSERT INTO auth_admission(key,count,started_at) VALUES(?,1,?)
      ON CONFLICT(key) DO UPDATE SET
        count=CASE WHEN started_at<=? THEN 1 ELSE count+1 END,
        started_at=CASE WHEN started_at<=? THEN excluded.started_at ELSE started_at END
      WHERE started_at<=? OR count<? RETURNING count`)
      .bind(key, now, cutoff, cutoff, cutoff, max)
      .first();
    if (row) return null;
    const existing = await db
      .prepare("SELECT started_at FROM auth_admission WHERE key=?")
      .bind(key)
      .first<{ started_at: number }>();
    return Math.max(1, Math.ceil(((existing?.started_at ?? now) + window * 1000 - now) / 1000));
  }
  return Object.assign(auth, {
    passwordMode: true as const,
    enrollmentDB: db,
    async consumeAdmission(action: string, ip: string) {
      // Fixed global buckets run first so spoofed identifiers cannot grow an
      // unbounded number of per-IP/email/capability rows in one window.
      let retry = await consume("password:global", 60, 600);
      if (retry !== null) return retry;
      // Delete a bounded batch using the indexed timestamp. Publicly supplied
      // identifiers cannot leave permanent rate-key rows. Twenty-four hours
      // exceeds every admission window, including legacy mail mode's hour.
      await db
        .prepare(`DELETE FROM auth_admission WHERE key IN (
        SELECT key FROM auth_admission WHERE started_at<? ORDER BY started_at LIMIT 128
      )`)
        .bind(Date.now() - 86400000)
        .run();
      const rule =
        action === "enroll"
          ? { window: 3600, max: 30 }
          : ["sign-in/username", "change-password"].includes(action)
            ? { window: 300, max: 120 }
            : { window: 60, max: 300 };
      retry = await consume(`password:global:${action}`, rule.window, rule.max);
      if (retry !== null) return retry;
      const sensitive = ["enroll", "sign-in/username", "change-password"].includes(action);
      return consume(
        `password:ip:${await capabilityHash(JSON.stringify([ip, action]))}`,
        sensitive ? 300 : 60,
        sensitive ? 5 : 120,
      );
    },
    async consumePurpose(action: string, value: string) {
      return consume(
        `password:purpose:${await capabilityHash(JSON.stringify([action, value]))}`,
        300,
        5,
      );
    },
    async enroll(body: Record<string, unknown>, headers: Headers) {
      const hash = await capabilityHash(body.code as string);
      const now = Date.now();
      // Atomic UPDATE prevents concurrent and repeated redemption. D1 signup
      // cannot span a transaction; partial creation stays ineligible and the
      // consumed grant is never restored automatically.
      const grant = await db
        .prepare(`UPDATE auth_enrollment SET consumed_at=?
        WHERE token_sha256=? AND consumed_at IS NULL AND expires_at>?
        RETURNING id,recipient_email`)
        .bind(now, hash, now)
        .first<Grant>();
      if (!grant || !recipients.includes(grant.recipient_email))
        return errorResponse("invalid_invitation", 400);
      const enrollmentAuth = buildAuth(configured, base.origin, waitUntil, grant);
      const context = await enrollmentAuth.$context;
      if (await context.internalAdapter.findUserByEmail(grant.recipient_email))
        return errorResponse("enrollment_unavailable", 409);
      const response = await enrollmentAuth.api.signUpEmail({
        body: {
          email: grant.recipient_email,
          password: body.password as string,
          name: (body.name as string | undefined) ?? "",
          username: body.username as string,
          ...(body.image ? { image: body.image as string } : {}),
        },
        headers,
        asResponse: true,
      });
      if (!response.ok) return errorResponse("enrollment_unavailable", 400);
      const found = await context.internalAdapter.findUserByEmail(grant.recipient_email);
      if (
        !found ||
        (found.user as { accessActor?: unknown }).accessActor !== `enrollment:${grant.id}` ||
        found.user.emailVerified
      )
        return errorResponse("enrollment_unavailable", 503);
      const bound = await db
        .prepare(`UPDATE auth_enrollment SET consumed_user_id=?
        WHERE id=? AND consumed_at=? AND consumed_user_id IS NULL RETURNING id`)
        .bind(found.user.id, grant.id, now)
        .first();
      if (!bound) return errorResponse("enrollment_unavailable", 503);
      return Response.json({ status: true }, { headers: { "Cache-Control": "private, no-store" } });
    },
  });
}
export type PasswordAuth = NonNullable<ReturnType<typeof configuredPasswordAuth>>;
async function eligible(
  auth: PasswordAuth,
  user: { id: string; email: string; accessActor?: unknown },
) {
  const row = await auth.enrollmentDB
    .prepare(`SELECT id,recipient_email FROM auth_enrollment
    WHERE consumed_user_id=? AND consumed_at IS NOT NULL`)
    .bind(user.id)
    .first<Grant>();
  return (
    !!row &&
    recipients.includes(row.recipient_email) &&
    row.recipient_email === user.email &&
    user.accessActor === `enrollment:${row.id}`
  );
}
export async function passwordAuthUser(auth: PasswordAuth, request: Request) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session || !(await eligible(auth, session.user))) return;
  return session.user;
}
async function bodyJSON(request: Request) {
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
function validProfile(body: Record<string, unknown>, required: boolean) {
  return (
    (body.name === undefined || (typeof body.name === "string" && body.name.length <= 80)) &&
    ((!required && !("username" in body)) || validUsername(body.username)) &&
    (body.image === undefined ||
      body.image === null ||
      (typeof body.image === "string" && /^\/avatars\/[a-z0-9_-]{1,40}\.svg$/.test(body.image)))
  );
}
const validPassword = (value: unknown) =>
  typeof value === "string" && value.length >= 12 && value.length <= 128;
export async function passwordAuthRequest(
  auth: PasswordAuth,
  request: Request,
  exclusive: (operation: () => Promise<Response>) => Promise<Response>,
) {
  const url = new URL(request.url);
  if (passwordAuthPaths.get(url.pathname) !== request.method)
    return errorResponse("not_found", 404);
  if (request.method === "POST" && request.headers.get("origin") !== url.origin)
    return errorResponse("origin_denied", 403);
  const action = url.pathname.slice("/api/auth/".length);
  // Cloudflare supplies this header at its edge. Absence fails closed instead
  // of trusting user-supplied forwarded-IP or actor headers.
  const ip = request.headers.get("cf-connecting-ip");
  if (!ip || ip.length > 64 || !/^[a-fA-F0-9:.]+$/.test(ip))
    return errorResponse("auth_unavailable", 503);
  try {
    const retry = await auth.consumeAdmission(action, ip);
    if (retry !== null) return errorResponse("rate_limited", 429, retry);
    if (url.search) return errorResponse("invalid_request", 400);
    let body: Record<string, unknown> = {};
    if (request.method === "POST") {
      try {
        body = await bodyJSON(request);
      } catch {
        return errorResponse("invalid_request", 400);
      }
      if (Object.keys(body).some((key) => !fields[action]?.includes(key)))
        return errorResponse("invalid_request", 400);
    }
    // Caller streams and admission finish before entering the shared authority
    // queue. Fresh session reads, enrollment and revocation finish inside it.
    return await exclusive(async () => {
      let currentUserId: string | undefined;
      if (action === "enroll") {
        if (
          typeof body.code !== "string" ||
          !/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(body.code) ||
          !validPassword(body.password) ||
          !validProfile(body, true)
        )
          return errorResponse("invalid_request", 400);
        const retry = await auth.consumePurpose("enroll", body.code);
        if (retry !== null) return errorResponse("rate_limited", 429, retry);
        return await auth.enroll(body, request.headers);
      }
      if (action === "sign-in/username") {
        if (
          !validUsername(body.username) ||
          typeof body.password !== "string" ||
          body.password.length > 128
        )
          return errorResponse("invalid_credentials", 401);
        const normalized = normalizeUsername(body.username as string);
        const retry = await auth.consumePurpose("sign-in/username", normalized);
        if (retry !== null) return errorResponse("rate_limited", 429, retry);
        const context = await auth.$context;
        const found = await context.adapter.findOne<{
          id: string;
          email: string;
          accessActor?: unknown;
        }>({
          model: "user",
          where: [{ field: "username", value: normalized }],
        });
        // Username lookup never grants authority: only the original consumed
        // enrollment capability and immutable account ID admit a principal.
        if (!found || !(await eligible(auth, found))) {
          await context.password.hash(body.password);
          return errorResponse("invalid_credentials", 401);
        }
        body.username = normalized;
      } else if (action !== "get-session") {
        const user = await passwordAuthUser(auth, request);
        if (!user) return errorResponse("unauthorized", 401);
        currentUserId = user.id;
      }
      if (action === "update-user" && !validProfile(body, false))
        return errorResponse("invalid_profile", 400);
      if (typeof body.username === "string") body.username = normalizeUsername(body.username);
      if (action === "change-password") {
        if (
          !validPassword(body.newPassword) ||
          typeof body.currentPassword !== "string" ||
          body.currentPassword.length > 128 ||
          (body.revokeOtherSessions !== undefined && typeof body.revokeOtherSessions !== "boolean")
        )
          return errorResponse("invalid_request", 400);
        body.revokeOtherSessions = true;
      }
      if (action === "get-session") {
        const user = await passwordAuthUser(auth, request);
        return Response.json(
          user
            ? {
                user: {
                  id: user.id,
                  email: user.email,
                  emailVerified: user.emailVerified,
                  name: user.name,
                  username: user.username,
                  image: user.image ?? null,
                },
              }
            : null,
          { headers: { "Cache-Control": "private, no-store" } },
        );
      }
      const response = await auth.handler(
        new Request(request, { method: "POST", body: JSON.stringify(body) }),
      );
      if (!response.ok)
        return errorResponse(
          response.status === 429
            ? "rate_limited"
            : action === "sign-in/username"
              ? "invalid_credentials"
              : "auth_request_failed",
          response.status >= 500
            ? 503
            : action === "sign-in/username" && response.status !== 429
              ? 401
              : response.status,
        );
      if (action === "sign-out") {
        // The library can swallow a failed deletion; success requires its
        // original session to be absent from the primary store.
        if (await auth.api.getSession({ headers: request.headers }))
          return errorResponse("auth_unavailable", 503);
      }
      if (action === "revoke-sessions") {
        const remains = await auth.enrollmentDB
          .prepare("SELECT id FROM session WHERE user_id=? LIMIT 1")
          .bind(currentUserId!)
          .first();
        if (remains) return errorResponse("auth_unavailable", 503);
      }
      const headers = new Headers({ "Cache-Control": "private, no-store" });
      for (const cookie of response.headers.getSetCookie()) headers.append("Set-Cookie", cookie);
      return Response.json({ status: true }, { headers });
    });
  } catch {
    return errorResponse("auth_unavailable", 503);
  }
}
