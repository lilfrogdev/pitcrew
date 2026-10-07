// Run personally in a private terminal. Never execute this through agent tools:
// the one-time account capability must go only to its operator and recipient.
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { NATIVE_AUTH_RECIPIENTS as emails } from "../packages/protocol/src/native-auth-recipients.mjs";
const execute = promisify(execFile);
const accountId = "004227d2029c56b084ce15356768def3";
const databaseId = "2bddc1ef-cddd-47bb-b368-e8ad1bad0095";
// An inherited CLOUDFLARE_ENV must not replace the validated default binding.
export const enrollmentD1Args = Object.freeze([
  "d1",
  "execute",
  "AUTH_DB",
  "--remote",
  "--json",
  "--env",
  "",
]);
function validateEnrollment({ id, email, hash, now }) {
  if (
    !/^[a-f0-9-]{36}$/.test(id) ||
    !emails.includes(email) ||
    !/^[a-f0-9]{64}$/.test(hash) ||
    !Number.isSafeInteger(now) ||
    now < 0 ||
    !Number.isSafeInteger(now + 1800000)
  )
    throw Error("Invalid enrollment parameters.");
}
export function enrollmentSQL(data) {
  validateEnrollment(data);
  const { id, email, hash, now } = data;
  // Existing accounts never get replacement enrollment through an email match.
  // Only an unused expired capability can be replaced by this operator action.
  return `INSERT INTO auth_enrollment(id,recipient_email,token_sha256,expires_at)
    SELECT '${id}','${email}','${hash}',${now + 1800000}
    WHERE NOT EXISTS(SELECT 1 FROM user WHERE email='${email}')
    ON CONFLICT(recipient_email) DO UPDATE SET id=excluded.id,token_sha256=excluded.token_sha256,
      expires_at=excluded.expires_at
    WHERE auth_enrollment.consumed_at IS NULL AND auth_enrollment.expires_at<=${now}
    RETURNING id;`;
}
export function enrollmentConfirmationSQL(data) {
  validateEnrollment(data);
  const { id, email, hash, now } = data;
  // The command query goes directly to D1's primary query endpoint. A bulk
  // import receipt cannot confirm that the guarded INSERT actually wrote a row.
  return `SELECT id FROM auth_enrollment
    WHERE id='${id}' AND recipient_email='${email}' AND token_sha256='${hash}'
      AND expires_at=${now + 1800000} AND expires_at>cast(unixepoch('subsecond') * 1000 as integer)
      AND consumed_at IS NULL AND consumed_user_id IS NULL
      AND NOT EXISTS(SELECT 1 FROM user WHERE email='${email}');`;
}
export function enrollmentConfirmed(stdout, data, completedAt = Date.now()) {
  try {
    validateEnrollment(data);
    if (!Number.isSafeInteger(completedAt) || completedAt < 0 || completedAt >= data.now + 1800000)
      return false;
    const entries = JSON.parse(stdout);
    return (
      Array.isArray(entries) &&
      entries.length === 1 &&
      entries[0].success === true &&
      Array.isArray(entries[0].results) &&
      entries[0].results.length === 1 &&
      entries[0].results[0]?.id === data.id
    );
  } catch {
    return false;
  }
}
export function assertEnrollmentConfig(config) {
  const bindings = config.d1_databases?.filter((db) => db.binding === "AUTH_DB");
  const binding = bindings?.[0];
  if (
    bindings?.length !== 1 ||
    config.account_id !== accountId ||
    config.name !== "pitcrew-backend" ||
    config.vars?.AUTH_MODE !== "password-only" ||
    binding?.database_name !== "pitcrew-auth" ||
    binding.database_id !== databaseId
  )
    throw Error("An approved Pitcrew auth config is required.");
}
async function main() {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw Error("Use your own private interactive terminal.");
  const [configArg, email, ...rest] = process.argv.slice(2);
  if (!configArg || !emails.includes(email) || rest.length)
    throw Error(
      "Usage: node scripts/issue-account-enrollment.mjs <approved-config.json> <exact-recipient-email>",
    );
  const configPath = resolve(configArg);
  const config = JSON.parse(await readFile(configPath, "utf8"));
  assertEnrollmentConfig(config);
  const code = randomBytes(32).toString("base64url"),
    id = randomUUID();
  const data = {
    id,
    email,
    hash: createHash("sha256").update(code).digest("hex"),
    now: Date.now(),
  };
  const sql = enrollmentSQL(data);
  const temp = await mkdtemp(resolve(tmpdir(), "pitcrew-private-enrollment-"));
  try {
    const sqlPath = resolve(temp, "hash-only.sql");
    await writeFile(sqlPath, sql, { mode: 0o600 });
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    await execute(
      resolve(root, "node_modules/.bin/wrangler"),
      [...enrollmentD1Args, "--config", configPath, "--file", sqlPath],
      {
        cwd: root,
        env: {
          ...process.env,
          WRANGLER_SEND_METRICS: "false",
          WRANGLER_LOG_PATH: resolve(temp, "vendor.log"),
        },
        maxBuffer: 1048576,
      },
    );
    // --remote --file uses Wrangler's bulk import path: it prints upload
    // progress and aggregate statistics, not the INSERT's RETURNING rows.
    // Confirm separately through a fresh primary query before releasing code.
    const { stdout } = await execute(
      resolve(root, "node_modules/.bin/wrangler"),
      [...enrollmentD1Args, "--config", configPath, "--command", enrollmentConfirmationSQL(data)],
      {
        cwd: root,
        env: {
          ...process.env,
          WRANGLER_SEND_METRICS: "false",
          WRANGLER_LOG_PATH: resolve(temp, "vendor.log"),
        },
        maxBuffer: 1048576,
      },
    );
    if (!enrollmentConfirmed(stdout, data))
      throw Error(
        "Enrollment was not issued. Existing accounts or active/consumed invitations cannot be replaced.",
      );
    process.stdout.write(
      `Private setup for ${email} (expires in 30 minutes):\nhttp://127.0.0.1:5173/auth/enroll#code=${code}\nHand this link only to its intended recipient. Do not paste it into chat.\n`,
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.stderr.write(
      "Private enrollment failed. No setup link was released; inspect the approved database state before retrying.\n",
    );
    process.exitCode = 1;
  });
}
