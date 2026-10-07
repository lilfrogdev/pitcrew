import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  enrollmentSQL,
  enrollmentConfirmationSQL,
  enrollmentConfirmed,
  assertEnrollmentConfig,
  enrollmentD1Args,
} from "./issue-account-enrollment.mjs";
import { NATIVE_AUTH_RECIPIENTS } from "../packages/protocol/src/native-auth-recipients.mjs";
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

test("only four exact native identifiers can issue capabilities, with existing-account and replacement protections for each", () => {
  assert.deepEqual(NATIVE_AUTH_RECIPIENTS, [
    "dev@lilfrogdev.com",
    "bryan.aldair.zamora@gmail.com",
    "john.cena@example.com",
    "lara.croft@example.com",
  ]);
  assert.equal(Object.isFrozen(NATIVE_AUTH_RECIPIENTS), true);
  for (const email of NATIVE_AUTH_RECIPIENTS) {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(
        "CREATE TABLE user(email TEXT); CREATE TABLE auth_enrollment(id TEXT,recipient_email TEXT UNIQUE,token_sha256 TEXT,expires_at INTEGER,consumed_at INTEGER)",
      );
      const data = {
        id: "12345678-1234-1234-1234-123456789abc",
        email,
        hash: "a".repeat(64),
        now: 1000,
      };
      assert.equal(db.prepare(enrollmentSQL(data)).all().length, 1);
      assert.equal(
        db.prepare(enrollmentSQL({ ...data, now: 2000, hash: "b".repeat(64) })).all().length,
        0,
      );
      db.exec("UPDATE auth_enrollment SET expires_at=0");
      assert.equal(db.prepare(enrollmentSQL({ ...data, hash: "b".repeat(64) })).all().length, 1);
      db.exec("UPDATE auth_enrollment SET expires_at=0,consumed_at=1");
      assert.equal(db.prepare(enrollmentSQL(data)).all().length, 0);
      db.exec("DELETE FROM auth_enrollment");
      db.prepare("INSERT INTO user(email) VALUES(?)").run(email);
      assert.equal(db.prepare(enrollmentSQL(data)).all().length, 0);
      for (const variant of [
        email.toUpperCase(),
        ` ${email}`,
        `${email} `,
        email.replace("@", "+other@"),
        "outsider@example.com",
      ])
        assert.throws(() => enrollmentSQL({ ...data, email: variant }));
    } finally {
      db.close();
    }
  }
});

test("bulk upload receipts never confirm issuance; only an exact fresh query result does", () => {
  const data = {
    id: "12345678-1234-1234-1234-123456789abc",
    email: "john.cena@example.com",
    hash: "a".repeat(64),
    now: 1000,
  };
  // Captured Wrangler 4.147.0 remote --file output shape: progress text followed
  // by aggregate import statistics, rather than the guarded RETURNING row.
  const aggregate = JSON.stringify([
    {
      results: [
        {
          "Total queries executed": 4,
          "Rows read": 36,
          "Rows written": 0,
          "Database size (MB)": "0.14",
        },
      ],
      success: true,
      meta: { served_by_primary: true },
    },
  ]);
  const bulk =
    "├ Checking if file needs uploading\n│\n├ 🌀 Uploading synthetic.sql\n│ 🌀 Uploading complete.\n│\n" +
    aggregate;
  assert.equal(enrollmentConfirmed(bulk, data, 2000), false);
  assert.equal(enrollmentConfirmed(aggregate, data, 2000), false);
  const success = JSON.stringify([{ success: true, results: [{ id: data.id }] }]);
  assert.equal(enrollmentConfirmed(success, data, 2000), true);
  assert.equal(enrollmentConfirmed(success, data, data.now + 1800000), false);
  assert.equal(enrollmentConfirmed(success, data, data.now + 1800001), false);
  for (const stdout of [
    "invalid",
    "null",
    "[]",
    '{"success":true}',
    JSON.stringify([{ success: false, results: [{ id: data.id }] }]),
    JSON.stringify([{ success: true, results: [] }]),
    JSON.stringify([{ success: true, results: [{ id: "different" }] }]),
    JSON.stringify([{ success: true, results: [{ id: data.id }, { id: data.id }] }]),
    JSON.stringify([
      { success: true, results: [{ id: data.id }] },
      { success: false, results: [] },
    ]),
    "upload progress\n" + success,
  ])
    assert.equal(enrollmentConfirmed(stdout, data, 2000), false);
  assert.throws(() => enrollmentConfirmationSQL({ ...data, email: "outsider@example.com" }));
  assert.throws(() => enrollmentConfirmationSQL({ ...data, now: Number.MAX_SAFE_INTEGER }));
});
test("private issuer pins the exact approved account, worker and AUTH_DB database", () => {
  const approved = {
    account_id: "004227d2029c56b084ce15356768def3",
    name: "pitcrew-backend",
    vars: { AUTH_MODE: "password-only" },
    d1_databases: [
      {
        binding: "AUTH_DB",
        database_name: "pitcrew-auth",
        database_id: "2bddc1ef-cddd-47bb-b368-e8ad1bad0095",
      },
    ],
  };
  assert.doesNotThrow(() => assertEnrollmentConfig(approved));
  for (const config of [
    { ...approved, account_id: "other-account" },
    { ...approved, name: "other-worker" },
    { ...approved, vars: { AUTH_MODE: "better-auth" } },
    { ...approved, d1_databases: [] },
    {
      ...approved,
      d1_databases: [
        { ...approved.d1_databases[0], database_id: "00000000-0000-0000-0000-000000000005" },
      ],
    },
    {
      ...approved,
      d1_databases: [{ ...approved.d1_databases[0], database_name: "other-database" }],
    },
    { ...approved, d1_databases: [approved.d1_databases[0], approved.d1_databases[0]] },
  ])
    assert.throws(() => assertEnrollmentConfig(config));
});
test(
  "actual local Wrangler file issuance and command readback confirm only exact eligible synthetic grants",
  { timeout: 120000 },
  async () => {
    const temp = await mkdtemp(join(tmpdir(), "pitcrew-synthetic-issuer-confirmation-"));
    try {
      const config = join(temp, "wrangler.json"),
        sqlPath = join(temp, "hash-only.sql"),
        state = join(temp, "state");
      await writeFile(
        config,
        JSON.stringify({
          name: "synthetic-issuer-confirmation",
          compatibility_date: "2026-10-03",
          d1_databases: [
            {
              binding: "AUTH_DB",
              database_name: "synthetic-issuer-confirmation",
              database_id: "00000000-0000-0000-0000-000000000005",
            },
          ],
          env: {
            other: {
              d1_databases: [
                {
                  binding: "AUTH_DB",
                  database_name: "synthetic-other",
                  database_id: "00000000-0000-0000-0000-000000000006",
                },
              ],
            },
          },
        }),
      );
      const execute = promisify(execFile);
      const cli = async (args, pinDefault = true) =>
        execute(
          process.execPath,
          [
            resolve("node_modules/wrangler/bin/wrangler.js"),
            ...enrollmentD1Args
              .slice(0, pinDefault ? enrollmentD1Args.length : -2)
              .map((arg) => (arg === "--remote" ? "--local" : arg)),
            "--persist-to",
            state,
            "--config",
            config,
            ...args,
          ],
          {
            cwd: temp,
            env: {
              PATH: process.env.PATH,
              CLOUDFLARE_ENV: "other",
              WRANGLER_SEND_METRICS: "false",
              WRANGLER_LOG_PATH: join(temp, "vendor.log"),
              CI: "true",
              NO_COLOR: "1",
            },
            maxBuffer: 1048576,
          },
        );
      const migrations = new URL("../apps/worker/migrations/auth/", import.meta.url);
      let schema = "";
      for (const file of (await readdir(migrations)).filter((file) => file.endsWith(".sql")).sort())
        schema += (await readFile(new URL(file, migrations), "utf8")) + "\n";
      await writeFile(sqlPath, schema, { mode: 0o600 });
      await cli(["--file", sqlPath]);
      const alternate = await cli(
        ["--command", "SELECT name FROM sqlite_master WHERE name='auth_enrollment';"],
        false,
      );
      assert.deepEqual(JSON.parse(alternate.stdout)[0].results, []);
      const data = {
        id: "12345678-1234-1234-1234-123456789abc",
        email: "john.cena@example.com",
        hash: "a".repeat(64),
        now: Date.now(),
      };
      const issue = async (value) => {
        await writeFile(sqlPath, enrollmentSQL(value), { mode: 0o600 });
        await cli(["--file", sqlPath]);
      };
      const confirm = async (value) => {
        const { stdout } = await cli(["--command", enrollmentConfirmationSQL(value)]);
        return enrollmentConfirmed(stdout, value);
      };
      await issue(data);
      assert.equal(await confirm(data), true);
      for (const value of [
        { ...data, id: "22345678-1234-1234-1234-123456789abc" },
        { ...data, email: "lara.croft@example.com" },
        { ...data, hash: "b".repeat(64) },
        { ...data, now: data.now + 1 },
      ])
        assert.equal(await confirm(value), false);
      const attempted = {
        ...data,
        id: "22345678-1234-1234-1234-123456789abc",
        hash: "b".repeat(64),
      };
      await issue(attempted);
      assert.equal(await confirm(attempted), false); // Active grant cannot be replaced.
      await cli(["--command", "UPDATE auth_enrollment SET consumed_at=1,expires_at=1;"]);
      await issue(attempted);
      assert.equal(await confirm(attempted), false); // Partially burned grant cannot be replaced.
      assert.equal(await confirm(data), false); // A consumed or expired row cannot confirm.
      await cli([
        "--command",
        `DELETE FROM auth_enrollment;
      INSERT INTO user(id,name,email,email_verified,created_at,updated_at,access_actor,username)
      VALUES('synthetic-existing','Existing','john.cena@example.com',0,1,1,'synthetic-existing','existing');`,
      ]);
      await issue(attempted);
      assert.equal(await confirm(attempted), false); // Email match never adopts an account.
      await cli(["--command", "DELETE FROM user;"]);
      const expired = { ...data, now: Date.now() - 1800001 };
      await issue(expired);
      assert.equal(await confirm(expired), false);
      const replacement = { ...attempted, now: Date.now() };
      await issue(replacement);
      assert.equal(await confirm(replacement), true); // Only unused expired capability replaces.
      await cli([
        "--command",
        `INSERT INTO user(id,name,email,email_verified,created_at,updated_at,access_actor,username)
      VALUES('synthetic-bound','Bound','lara.croft@example.com',0,1,1,'synthetic-bound','bound');
      UPDATE auth_enrollment SET consumed_at=1,consumed_user_id='synthetic-bound';`,
      ]);
      assert.equal(await confirm(replacement), false); // Bound grant cannot release a fresh link.
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  },
);
