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
  enroll(name: string, email: string, password: string): Promise<void>;
  signOut(): Promise<void>;
}

async function authRequest(path: string, body?: object): Promise<unknown> {
  const response = await fetch(`/api/auth/${path}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
    cache: "no-store",
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw Error(response.status === 429
    ? "Too many attempts. Try again later."
    : "Authentication could not be completed. Try again.");
  const text = await response.text();
  return text ? JSON.parse(text) as unknown : null;
}

export const httpAuthApi: AuthApi = {
  async session() {
    const value = await authRequest("get-session");
    if (value === null) return null;
    if (!value || typeof value !== "object" || !("user" in value)) throw Error("Session unavailable.");
    const user = value.user as Partial<AuthUser>;
    if (typeof user?.id !== "string" || typeof user.email !== "string" ||
        typeof user.emailVerified !== "boolean" || typeof user.name !== "string")
      throw Error("Session unavailable.");
    return value as AuthSession;
  },
  signIn: async (email, password) => {
    await authRequest("sign-in/email", { email, password });
  },
  enroll: async (name, email, password) => {
    await authRequest("sign-up/email", { name, email, password });
  },
  signOut: async () => {
    await authRequest("sign-out", {});
  },
};
