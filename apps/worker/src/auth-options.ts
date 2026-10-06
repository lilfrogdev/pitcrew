import type { BetterAuthOptions } from "better-auth";

// Enrollment is gated by the verified Cloudflare Access subject and exact
// email in the Worker, before Better Auth sees a request.
export const authOptions = {
  emailAndPassword: {
    enabled: true,
    autoSignIn: false,
    requireEmailVerification: true,
    revokeSessionsOnPasswordReset: true,
    minPasswordLength: 12,
    maxPasswordLength: 128,
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
      "/request-password-reset": { window: 3600, max: 3 },
      "/send-verification-email": { window: 3600, max: 3 },
    },
  },
} satisfies BetterAuthOptions;
