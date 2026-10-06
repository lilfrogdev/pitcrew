export type AuthUser = {
  id: string;
  email: string;
  emailVerified: boolean;
  name: string;
  username?: string;
  image?: string | null;
};
export type AuthSession = { user: AuthUser };
export interface AuthApi {
  session(): Promise<AuthSession | null>;
  signIn(email: string, password: string): Promise<void>;
  enroll(name: string, username: string, email: string, password: string): Promise<void>;
  signOut(): Promise<void>;
  verifyEmail(token: string): Promise<void>;
  resendVerification(email: string): Promise<void>;
  requestPasswordReset(email: string): Promise<void>;
  resetPassword(token: string, newPassword: string): Promise<void>;
  updateUser(profile: { name: string; username: string }): Promise<void>;
}

let bootstrap: Promise<string> | undefined;
async function authNonce(): Promise<string> {
  bootstrap ??= (async () => {
    const response = await fetch("/api/auth/local-session", {
      credentials: "same-origin",
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
    });
    const value = (await response.json().catch(() => null)) as { nonce?: unknown } | null;
    if (!response.ok || typeof value?.nonce !== "string" || !/^[a-f0-9]{64}$/.test(value.nonce))
      throw Error("Account services are unavailable. Try again later.");
    return value.nonce;
  })().finally(() => {
    bootstrap = undefined;
  });
  return bootstrap;
}
async function authRequest(path: string, body?: object): Promise<unknown> {
  const nonce = await authNonce();
  const response = await fetch(`/api/auth/${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      "X-Pitcrew-Auth-Nonce": nonce,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
    cache: "no-store",
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok)
    throw Error(
      response.status === 429
        ? "Too many attempts. Try again later."
        : "Authentication could not be completed. Try again.",
    );
  const text = await response.text();
  return text ? (JSON.parse(text) as unknown) : null;
}

export const httpAuthApi: AuthApi = {
  async session() {
    const value = await authRequest("get-session");
    if (value === null) return null;
    if (!value || typeof value !== "object" || !("user" in value))
      throw Error("Session unavailable.");
    const user = value.user as Partial<AuthUser>;
    if (
      typeof user?.id !== "string" ||
      typeof user.email !== "string" ||
      user.emailVerified !== true ||
      typeof user.name !== "string" ||
      typeof user.username !== "string" ||
      (user.image != null &&
        (typeof user.image !== "string" || !/^\/avatars\/[a-z0-9_-]{1,40}\.svg$/.test(user.image)))
    )
      throw Error("Session unavailable.");
    return {
      user: {
        id: user.id,
        email: user.email,
        emailVerified: true,
        name: user.name,
        username: user.username,
        image: user.image ?? null,
      },
    };
  },
  signIn: async (email, password) => {
    await authRequest("sign-in/email", { email, password });
  },
  enroll: async (name, username, email, password) => {
    await authRequest("sign-up/email", { name, username, email, password });
  },
  signOut: async () => {
    await authRequest("sign-out", {});
  },
  verifyEmail: async (token) => {
    await authRequest(`verify-email?token=${encodeURIComponent(token)}`);
  },
  resendVerification: async (email) => {
    await authRequest("send-verification-email", { email });
  },
  requestPasswordReset: async (email) => {
    await authRequest("request-password-reset", { email });
  },
  resetPassword: async (token, newPassword) => {
    await authRequest("reset-password", { token, newPassword });
  },
  updateUser: async (profile) => {
    await authRequest("update-user", profile);
    window.dispatchEvent(new Event("pitcrew-auth-updated"));
  },
};
