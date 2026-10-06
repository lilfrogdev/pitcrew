import { authUser, type Auth, type AccessIdentity } from "./auth";
import type { VisualizationPrincipal } from "./visualization-api";

// Use only behind protectedFetch's freshly verified Access identity. Better Auth
// cookie-cache is disabled by auth-options.ts. No secret/token enters an envelope.
export async function visualizationSession(
  auth: Auth,
  request: Request,
  access: AccessIdentity,
): Promise<VisualizationPrincipal | undefined> {
  const grant = await visualizationGrant(auth, request, access);
  if (!grant) return;
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`visualization-session:${grant.sessionId}`),
  );
  return {
    actor: grant.actor,
    expiresAt: grant.expiresAt,
    accessEpoch: Array.from(new Uint8Array(bytes), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join(""),
  };
}
export type VisualizationGrant = {
  actor: string;
  userId: string;
  sessionId: string;
  accessActor: string;
  email: string;
  expiresAt: number;
};
// Internal identifiers only: no raw session token, cookie, credential or request headers.
export async function visualizationGrant(
  auth: Auth,
  request: Request,
  access: AccessIdentity,
): Promise<VisualizationGrant | undefined> {
  const user = await authUser(auth, request, access);
  if (!user) return;
  const current = await auth.api.getSession({ headers: request.headers });
  if (
    !current ||
    current.user.id !== user.id ||
    !current.user.emailVerified ||
    current.user.accessActor !== access.actor ||
    current.user.email.toLowerCase() !== access.email.toLowerCase()
  )
    return;
  const expiresAt = new Date(current.session.expiresAt).getTime();
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return;
  return {
    actor: `account:${user.id}`,
    userId: user.id,
    sessionId: current.session.id,
    accessActor: access.actor,
    email: user.email.toLowerCase(),
    expiresAt,
  };
}
export async function requireVisualizationSession(db: D1Database, grant: VisualizationGrant) {
  const row = await db
    .prepare(`SELECT s.expires_at AS expiresAt,u.email,u.email_verified AS verified,u.access_actor AS accessActor
    FROM session s JOIN user u ON u.id=s.user_id WHERE s.id=? AND s.user_id=?`)
    .bind(grant.sessionId, grant.userId)
    .first<{ expiresAt: number; email: string; verified: number; accessActor: string }>();
  if (
    !row ||
    row.expiresAt <= Date.now() ||
    grant.expiresAt <= Date.now() ||
    grant.actor !== `account:${grant.userId}` ||
    row.verified !== 1 ||
    row.email.toLowerCase() !== grant.email ||
    row.accessActor !== grant.accessActor
  )
    throw Error("visualization_session_revoked");
}
