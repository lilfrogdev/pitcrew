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
  enroll(name: string, username: string, code: string, password: string): Promise<void>;
  signOut(): Promise<void>;
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
async function authRequest(path: string, body?: object, retrySession = true): Promise<unknown> {
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
  if (!response.ok) {
    // Only a session read is safe to retry. A newer sign-in/logout may have
    // superseded the relay request while its backend response was pending.
    if (path === "get-session" && response.status === 409 && retrySession) {
      const value = (await response.json().catch(() => null)) as { error?: unknown } | null;
      if (value?.error === "auth_request_superseded") return authRequest(path, undefined, false);
    }
    throw Error(
      response.status === 429
        ? "Too many attempts. Try again later."
        : "Authentication could not be completed. Try again.",
    );
  }
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
      typeof user.emailVerified !== "boolean" ||
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
        emailVerified: user.emailVerified,
        name: user.name,
        username: user.username,
        image: user.image ?? null,
      },
    };
  },
  signIn: async (email, password) => {
    await authRequest("sign-in/email", { email, password });
  },
  enroll: async (name, username, code, password) => {
    await authRequest("enroll", { name, username, code, password });
  },
  signOut: async () => {
    await authRequest("sign-out", {});
  },
  updateUser: async (profile) => {
    await authRequest("update-user", profile);
    window.dispatchEvent(new Event("pitcrew-auth-updated"));
  },
};
