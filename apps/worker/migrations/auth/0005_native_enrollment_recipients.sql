-- Wrangler applies each migration as one transaction. Keep this table rebuild
-- in that migration transaction (or one D1 batch), never statement by statement.
-- auth_enrollment has only an outbound FK to user. No FK deferral or disabled
-- enforcement is needed, and no user/session/credential rows are rewritten.
CREATE TABLE auth_enrollment_next (
  id TEXT PRIMARY KEY NOT NULL,
  recipient_email TEXT NOT NULL UNIQUE CHECK(recipient_email IN ('dev@lilfrogdev.com','bryan.aldair.zamora@gmail.com','john.cena@example.com','lara.croft@example.com')),
  token_sha256 TEXT NOT NULL UNIQUE CHECK(length(token_sha256)=64),
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  consumed_user_id TEXT UNIQUE REFERENCES user(id),
  CHECK(consumed_user_id IS NULL OR consumed_at IS NOT NULL)
);
INSERT INTO auth_enrollment_next (id,recipient_email,token_sha256,expires_at,consumed_at,consumed_user_id)
SELECT id,recipient_email,token_sha256,expires_at,consumed_at,consumed_user_id FROM auth_enrollment;
DROP TABLE auth_enrollment;
ALTER TABLE auth_enrollment_next RENAME TO auth_enrollment;
