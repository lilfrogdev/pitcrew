import { authUser, type Auth, type AccessIdentity } from "./auth";
import type { VisualizationPrincipal } from "./visualization-api";

// Legacy callers supply freshly verified Access identity; scoped password
// callers use their independent consumed-enrollment binding. No client payload
// selects either mode. Cookie-cache stays disabled and no token is exposed.
export async function visualizationSession(
  auth: Auth,
  request: Request,
  access?: AccessIdentity,
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
type GrantIdentity = {
  actor: string;
  userId: string;
  sessionId: string;
  accessActor: string;
  email: string;
  expiresAt: number;
};
export type VisualizationGrant = GrantIdentity &
  ({ mode?: "access"; enrollmentId?: never } | { mode: "password-only"; enrollmentId: string });
// Internal identifiers only: no raw session token, cookie, credential or request headers.
export async function visualizationGrant(
  auth: Auth,
  request: Request,
  access?: AccessIdentity,
): Promise<VisualizationGrant | undefined> {
  const user = await authUser(auth, request, access);
  if (!user) return;
  const current = await auth.api.getSession({ headers: request.headers });
  if (!current || current.user.id !== user.id) return;
  const expiresAt = new Date(current.session.expiresAt).getTime();
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return;
  if (auth.passwordMode) {
    const enrollment = await auth.enrollmentDB
      .prepare(`SELECT id FROM auth_enrollment
      WHERE consumed_user_id=? AND recipient_email=? AND consumed_at IS NOT NULL`)
      .bind(user.id, user.email)
      .first<{ id: string }>();
    if (!enrollment || current.user.accessActor !== `enrollment:${enrollment.id}`) return;
    const grant: VisualizationGrant = {
      mode: "password-only",
      enrollmentId: enrollment.id,
      actor: `account:${user.id}`,
      userId: user.id,
      sessionId: current.session.id,
      // Existing frozen turn records call this credential actor accessActor.
      // Its explicit account prefix carries no Access/SSO claim in this mode.
      accessActor: `account:${user.id}`,
      email: user.email,
      expiresAt,
    };
    try {
      await requireVisualizationSession(auth.enrollmentDB, grant);
    } catch {
      return;
    }
    return grant;
  }
  if (
    !access ||
    !current.user.emailVerified ||
    current.user.accessActor !== access.actor ||
    current.user.email.toLowerCase() !== access.email.toLowerCase()
  )
    return;
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
  if (grant.mode === "password-only") {
    const row = await db
      .prepare(`SELECT s.expires_at AS expiresAt,u.email,u.access_actor AS provenance,
      e.id AS enrollmentId,e.recipient_email AS recipient FROM session s
      JOIN user u ON u.id=s.user_id JOIN auth_enrollment e ON e.consumed_user_id=u.id
      WHERE s.id=? AND s.user_id=? AND e.consumed_at IS NOT NULL`)
      .bind(grant.sessionId, grant.userId)
      .first<{
        expiresAt: number;
        email: string;
        provenance: string;
        enrollmentId: string;
        recipient: string;
      }>();
    if (
      !row ||
      row.expiresAt <= Date.now() ||
      grant.expiresAt <= Date.now() ||
      grant.actor !== `account:${grant.userId}` ||
      grant.accessActor !== grant.actor ||
      row.email !== grant.email ||
      row.recipient !== row.email ||
      row.enrollmentId !== grant.enrollmentId ||
      row.provenance !== `enrollment:${row.enrollmentId}`
    )
      throw Error("visualization_session_revoked");
    return;
  }
  if (grant.mode !== undefined && grant.mode !== "access")
    throw Error("visualization_session_revoked");
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
