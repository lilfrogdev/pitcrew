import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { enrollmentSQL } from "./issue-account-enrollment.mjs";
test("operator issuance cannot replace an active/used invitation or adopt an existing account by email", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE user(email TEXT); CREATE TABLE auth_enrollment(id TEXT,recipient_email TEXT UNIQUE,token_sha256 TEXT,expires_at INTEGER,consumed_at INTEGER)",
  );
  const data = {
    id: "12345678-1234-1234-1234-123456789abc",
    email: "dev@lilfrogdev.com",
    hash: "a".repeat(64),
    now: 1000,
  };
  assert.equal(db.prepare(enrollmentSQL(data)).all().length, 1);
  assert.equal(
    db.prepare(enrollmentSQL({ ...data, id: "22345678-1234-1234-1234-123456789abc" })).all().length,
    0,
  );
  db.exec("UPDATE auth_enrollment SET expires_at=0");
  assert.equal(
    db.prepare(enrollmentSQL({ ...data, id: "22345678-1234-1234-1234-123456789abc" })).all().length,
    1,
  );
  db.exec("UPDATE auth_enrollment SET consumed_at=2,expires_at=0");
  assert.equal(db.prepare(enrollmentSQL(data)).all().length, 0);
  db.exec("DELETE FROM auth_enrollment; INSERT INTO user VALUES('dev@lilfrogdev.com')");
  assert.equal(db.prepare(enrollmentSQL(data)).all().length, 0);
  assert.throws(() => enrollmentSQL({ ...data, email: "outsider@example.com" }));
  db.close();
});
test("noninteractive agent execution fails before issuing any real capability", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/issue-account-enrollment.mjs", "synthetic-config.json", "dev@lilfrogdev.com"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.doesNotMatch(result.stderr, /#code=|[A-Za-z0-9_-]{43}/);
});
