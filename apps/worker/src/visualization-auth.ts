import { authUser, type Auth, type AccessIdentity } from "./auth";
import type { VisualizationPrincipal } from "./visualization-api";

// Use only behind protectedFetch's freshly verified Access identity. Better Auth
// cookie-cache is disabled by auth-options.ts. No secret/token enters an envelope.
export async function visualizationSession(
  auth: Auth,
  request: Request,
  access: AccessIdentity,
): Promise<VisualizationPrincipal | undefined> {
  const user = await authUser(auth, request, access);
  if (!user) return;
  const current = await auth.api.getSession({ headers: request.headers });
  if (!current || current.user.id !== user.id || !current.user.emailVerified) return;
  const expiresAt = new Date(current.session.expiresAt).getTime();
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return;
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`visualization-session:${current.session.id}`),
  );
  return {
    actor: `account:${user.id}`,
    accessEpoch: Array.from(new Uint8Array(bytes), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join(""),
    expiresAt,
  };
}
