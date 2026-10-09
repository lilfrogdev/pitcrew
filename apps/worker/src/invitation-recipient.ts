import { invitationSelector, type ResolvedInvitationRecipient } from "@pitcrew/protocol";
import { AdmissionError } from "./coordinator";
import { AUTH_EMAILS } from "./auth";

/** Lookup selects an existing account, never a claim to ownership of an email. */
export async function resolveInvitationRecipient(
  db: D1Database,
  input: unknown,
  passwordMode: boolean,
): Promise<ResolvedInvitationRecipient> {
  const selector = invitationSelector(input);
  if (!selector) throw new AdmissionError("invalid_recipient");
  // LIMIT 2 detects imported case variants even though the email UNIQUE constraint
  // is case sensitive. Never choose the first eligible account from an ambiguous pair.
  const result = await db
    .prepare(`SELECT u.id,u.username,u.email,u.access_actor AS provenance,
    u.email_verified AS verified,
    EXISTS(SELECT 1 FROM account a WHERE a.user_id=u.id AND a.provider_id='credential'
      AND a.password IS NOT NULL) AS credential,
    EXISTS(SELECT 1 FROM auth_enrollment e WHERE e.consumed_user_id=u.id
      AND e.recipient_email=u.email AND e.consumed_at IS NOT NULL
      AND u.access_actor='enrollment:'||e.id) AS enrolled
    FROM user u WHERE lower(u.${selector.kind === "username" ? "username" : "email"})=? LIMIT 2`)
    .bind(selector.value)
    .all<{
      id: string;
      username: string;
      email: string;
      provenance: string;
      verified: number;
      credential: number;
      enrolled: number;
    }>();
  const row = result.results.length === 1 ? result.results[0] : undefined;
  if (
    !row ||
    !/^[A-Za-z0-9:_-]{1,128}$/.test(row.id) ||
    !/^[a-zA-Z0-9_]{3,32}$/.test(row.username) ||
    (passwordMode
      ? row.enrolled !== 1 || row.credential !== 1
      : row.verified !== 1 ||
        !/^access:[^\s]{1,256}$/.test(row.provenance) ||
        !AUTH_EMAILS.some((email) => email === row.email.toLowerCase()))
  )
    throw new AdmissionError("recipient_unavailable");
  return {
    actor: `account:${row.id}`,
    recipient: selector.kind === "username" ? `@${row.username.toLowerCase()}` : selector.value,
  };
}
