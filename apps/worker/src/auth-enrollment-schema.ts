import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

// Private operator-issued capabilities establish account eligibility without
// pretending to verify a mailbox or a Cloudflare Access identity.
export const authEnrollment = sqliteTable("auth_enrollment", {
  id: text("id").primaryKey(),
  recipientEmail: text("recipient_email").notNull().unique(),
  tokenSha256: text("token_sha256").notNull().unique(),
  expiresAt: integer("expires_at").notNull(),
  consumedAt: integer("consumed_at"),
  consumedUserId: text("consumed_user_id").unique(),
});
