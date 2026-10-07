CREATE INDEX auth_admission_started_at_idx ON auth_admission(started_at);
CREATE TABLE auth_enrollment (
  id TEXT PRIMARY KEY NOT NULL,
  recipient_email TEXT NOT NULL UNIQUE CHECK(recipient_email IN ('dev@lilfrogdev.com','bryan.aldair.zamora@gmail.com')),
  token_sha256 TEXT NOT NULL UNIQUE CHECK(length(token_sha256)=64),
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  consumed_user_id TEXT UNIQUE REFERENCES user(id),
  CHECK(consumed_user_id IS NULL OR consumed_at IS NOT NULL)
);
