/** Public invitation metadata never carries the account binding or token digest. */
export type PublicInvitation = {
  id: string;
  scope: "project" | "thread";
  projectId: string;
  threadId?: string;
  recipient?: string;
  /** Legacy verified-Access invitations only. New account-bound invitations omit this. */
  email?: string;
  role: "editor";
  invitedBy: string;
  expiresAt: string;
  acceptedBy?: string;
  revokedAt?: string;
};
export type InvitationRequest = { recipient: string; role: "editor" };
export type InvitationSelector = { kind: "username" | "email"; value: string };
export function invitationSelector(input: unknown): InvitationSelector | undefined {
  if (typeof input !== "string" || input.length > 256) return;
  const value = input.replace(/^[\t\n\r\f\v ]+|[\t\n\r\f\v ]+$/g, "");
  const username = value.startsWith("@") ? value.slice(1) : value;
  if (/^[a-zA-Z0-9_]{3,32}$/.test(username))
    return { kind: "username", value: username.toLowerCase() };
  if (value.length <= 254 && /^[^\s@*]+@[^\s@*]+\.[^\s@*]+$/.test(value))
    return { kind: "email", value: value.toLowerCase() };
}

/** Internal resolver result; never included in the public invitation DTO. */
export type ResolvedInvitationRecipient = { actor: string; recipient: string };
