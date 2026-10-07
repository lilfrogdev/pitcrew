import { sql } from "drizzle-orm";
import { user } from "./auth-schema";
import { NATIVE_AUTH_RECIPIENTS } from "../../../packages/protocol/src/native-auth-recipients.mjs";
import { sqliteTable, text, integer, check } from "drizzle-orm/sqlite-core";

// Private operator-issued capabilities establish account eligibility without
// pretending to verify a mailbox or a Cloudflare Access identity.
export const authEnrollment = sqliteTable(
  "auth_enrollment",
  {
    id: text("id").primaryKey(),
    recipientEmail: text("recipient_email").notNull().unique(),
    tokenSha256: text("token_sha256").notNull().unique(),
    expiresAt: integer("expires_at").notNull(),
    consumedAt: integer("consumed_at"),
    consumedUserId: text("consumed_user_id")
      .unique()
      .references(() => user.id),
  },
  (table) => [
    check(
      "auth_enrollment_recipient_check",
      sql`${table.recipientEmail} IN (${sql.join(
        NATIVE_AUTH_RECIPIENTS.map((value) => sql.raw(`'${value}'`)),
        sql`, `,
      )})`,
    ),
    check("auth_enrollment_hash_length_check", sql`length(${table.tokenSha256}) = 64`),
    check(
      "auth_enrollment_consumption_check",
      sql`${table.consumedUserId} IS NULL OR ${table.consumedAt} IS NOT NULL`,
    ),
  ],
);
