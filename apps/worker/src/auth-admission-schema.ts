import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

// Application admission precedes Better Auth token/body validation. Kept apart
// from the generated schema and the library's IP-bucket cleanup.
export const authAdmission = sqliteTable("auth_admission", {
  key: text("key").primaryKey(),
  count: integer("count").notNull(),
  startedAt: integer("started_at").notNull(),
});
