import { betterAuth } from "better-auth";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./auth-schema";
import { authOptions } from "./auth-options";

export interface AuthEnv {
  AUTH_MODE?: string;
  AUTH_DB?: D1Database;
  BETTER_AUTH_SECRET?: string;
  BETTER_AUTH_URL?: string;
  AUTH_EMAIL_FROM?: string;
  EMAIL?: SendEmail;
}
export type AccessIdentity = { actor: string; email: string };
const authPaths = new Map([
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
]);
export function configuredAuth(env: AuthEnv, request: Request, waitUntil: (task: Promise<unknown>) => void) {
  if (env.AUTH_MODE !== "better-auth" || !env.AUTH_DB ||
      !env.BETTER_AUTH_SECRET || env.BETTER_AUTH_SECRET.length < 32 ||
      !env.BETTER_AUTH_URL || new URL(request.url).origin !== env.BETTER_AUTH_URL ||
      !env.EMAIL || !env.AUTH_EMAIL_FROM ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(env.AUTH_EMAIL_FROM))
    return;
  const email = env.EMAIL, from = env.AUTH_EMAIL_FROM;
  const deliver = (to: string, subject: string, url: string) => {
    // Tokens remain in the outbound message only. Neither URLs nor provider
    // errors are logged or returned through application APIs.
    waitUntil(email.send({ to, from, subject, text: `${subject}: ${url}` }));
  };
  return betterAuth({
    ...authOptions,
    database: drizzleAdapter(drizzle(env.AUTH_DB, { schema }), { provider: "sqlite", schema }),
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    trustedOrigins: [env.BETTER_AUTH_URL, "http://localhost:5173", "http://127.0.0.1:5173"],
    advanced: { ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] } },
    emailVerification: {
      sendOnSignUp: true,
      sendOnSignIn: true,
      sendVerificationEmail: async ({ user, url }) => deliver(user.email, "Verify your Pitcrew email", url),
    },
    emailAndPassword: {
      ...authOptions.emailAndPassword,
      sendResetPassword: async ({ user, url }) => deliver(user.email, "Reset your Pitcrew password", url),
    },
  });
}
type Auth = NonNullable<ReturnType<typeof configuredAuth>>;
export async function authUser(auth: Auth, request: Request, access: AccessIdentity) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session || !session.user.emailVerified || session.user.email.toLowerCase() !== access.email)
    return;
  return session.user;
}
export async function authRequest(auth: Auth, request: Request, access: AccessIdentity) {
  const path = new URL(request.url).pathname;
  if (authPaths.get(path) !== request.method)
    return Response.json({ error: "not_found" }, { status: 404 });
  if (["/api/auth/sign-up/email", "/api/auth/sign-in/email",
       "/api/auth/request-password-reset", "/api/auth/send-verification-email"].includes(path)) {
    try {
      if (Number(request.headers.get("content-length") ?? 0) > 8192) throw Error();
      const body = await request.clone().json() as { email?: unknown };
      if (typeof body.email !== "string" || body.email.toLowerCase() !== access.email)
        return Response.json({ error: "identity_mismatch" }, { status: 403 });
    } catch {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }
  } else if (!["/api/auth/get-session", "/api/auth/verify-email",
                "/api/auth/reset-password"].includes(path) &&
             !(await authUser(auth, request, access))) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const response = await auth.handler(request);
  // Keep login failure details and auth cookies out of shared caches.
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "private, no-store");
  if (path === "/api/auth/sign-in/email" && response.status >= 400 && response.status < 500)
    return Response.json({ error: "invalid_credentials" }, { status: 401, headers });
  return new Response(response.body, { status: response.status, headers });
}
