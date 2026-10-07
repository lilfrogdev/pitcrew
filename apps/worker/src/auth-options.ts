import type { BetterAuthOptions } from "better-auth";

// Enrollment is gated by the verified Cloudflare Access subject and exact
// email in the Worker, before Better Auth sees a request.
export const authOptions = {
  basePath: "/api/auth",
  user: {
    additionalFields: {
      accessActor: { type: "string", input: false, required: true, defaultValue: "", unique: true },
      username: { type: "string", required: true, unique: true },
    },
    changeEmail: { enabled: false },
    deleteUser: { enabled: false },
  },
  session: {
    expiresIn: 1800,
    updateAge: 300,
    cookieCache: { enabled: false },
    disableSessionRefresh: true,
  },
  emailAndPassword: {
    enabled: true,
    autoSignIn: false,
    requireEmailVerification: true,
    revokeSessionsOnPasswordReset: true,
    minPasswordLength: 12,
    maxPasswordLength: 128,
    resetPasswordTokenExpiresIn: 900,
  },
  account: { accountLinking: { enabled: false, disableImplicitLinking: true } },
  rateLimit: {
    enabled: true,
    storage: "database",
    window: 60,
    max: 60,
    customRules: {
      "/sign-up/email": { window: 3600, max: 5 },
      "/sign-in/email": { window: 300, max: 5 },
      "/sign-in/username": { window: 300, max: 5 },
      "/request-password-reset": { window: 3600, max: 3 },
      "/send-verification-email": { window: 3600, max: 3 },
      "/reset-password": { window: 300, max: 5 },
      "/change-password": { window: 300, max: 5 },
      "/verify-email": { window: 300, max: 10 },
    },
  },
} satisfies BetterAuthOptions;
