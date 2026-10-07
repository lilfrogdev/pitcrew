// Run personally in a private terminal. Never execute this through agent tools:
// the one-time account capability must go only to its operator and recipient.
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { readFile, mkdtemp, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
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
async function resolveEnrollmentWrangler(root) {
  const require = createRequire(resolve(root, "package.json"));
  const packagePath = require.resolve("wrangler/package.json");
  const manifest = JSON.parse(await readFile(packagePath, "utf8"));
  const script = resolve(dirname(packagePath), manifest.bin.wrangler);
  await access(script);
  return {
    script,
    version: /^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$/.test(manifest.version)
      ? manifest.version
      : "unavailable",
  };
}
export async function runEnrollmentWrangler(root, args, { env = process.env, logPath } = {}) {
  const { script } = await resolveEnrollmentWrangler(root);
  return execute(process.execPath, [script, ...args], {
    cwd: root,
    env: {
      ...env,
      WRANGLER_SEND_METRICS: "false",
      ...(logPath ? { WRANGLER_LOG_PATH: logPath } : {}),
    },
    maxBuffer: 1048576,
  });
}
export async function runEnrollmentLegacyWrangler(root, args, { env = process.env, logPath } = {}) {
  return execute(resolve(root, "node_modules/.bin/wrangler"), args, {
    cwd: root,
    env: {
      ...env,
      WRANGLER_SEND_METRICS: "false",
      ...(logPath ? { WRANGLER_LOG_PATH: logPath } : {}),
    },
    maxBuffer: 1048576,
  });
}
export function assertEnrollmentNode(version = process.versions.node) {
  if (!/^\d+\./.test(version) || Number(version.split(".")[0]) < 22)
    throw Object.assign(Error(), { enrollmentCode: "ENROLLMENT_NODE_UNSUPPORTED" });
}
export function enrollmentPreflightSQL(email) {
  if (!emails.includes(email)) throw Error("Invalid recipient.");
  return `SELECT
    (SELECT count(*) FROM d1_migrations WHERE name IN ('0004_username_identity.sql','0005_native_enrollment_recipients.sql')) AS migration_count,
    EXISTS(SELECT 1 FROM user WHERE email='${email}') AS existing_account,
    EXISTS(SELECT 1 FROM auth_enrollment WHERE recipient_email='${email}' AND (consumed_at IS NOT NULL OR consumed_user_id IS NOT NULL)) AS consumed_invitation,
    EXISTS(SELECT 1 FROM auth_enrollment WHERE recipient_email='${email}' AND expires_at>cast(unixepoch('subsecond') * 1000 as integer)) AS active_invitation;`;
}
export function assertEnrollmentPreflight(stdout) {
  const entries = JSON.parse(stdout);
  if (
    !Array.isArray(entries) ||
    entries.length !== 1 ||
    entries[0]?.success !== true ||
    !Array.isArray(entries[0].results) ||
    entries[0].results.length !== 1
  )
    throw Error();
  const row = entries[0].results[0];
  if (
    !Number.isSafeInteger(row?.migration_count) ||
    !["existing_account", "consumed_invitation", "active_invitation"].every(
      (key) => row[key] === 0 || row[key] === 1,
    )
  )
    throw Error();
  const code =
    row.migration_count !== 2
      ? "ENROLLMENT_MIGRATIONS_REQUIRED"
      : row.existing_account
        ? "ENROLLMENT_ACCOUNT_EXISTS"
        : row.consumed_invitation
          ? "ENROLLMENT_INVITATION_CONSUMED"
          : row.active_invitation
            ? "ENROLLMENT_INVITATION_ACTIVE"
            : undefined;
  if (code) throw Object.assign(Error(), { enrollmentCode: code });
}
export function enrollmentPreflightContext(env = process.env, wranglerVersion = "unavailable") {
  const present = (names) => names.some((name) => Object.hasOwn(env, name));
  return {
    code: "ENROLLMENT_PREFLIGHT_CONTEXT",
    phase: "preflight",
    node: process.versions.node,
    wrangler: wranglerVersion,
    stdinTTY: process.stdin.isTTY === true,
    stdoutTTY: process.stdout.isTTY === true,
    authEnvironment: {
      apiToken: present(["CLOUDFLARE_API_TOKEN", "CF_API_TOKEN"]),
      apiKey: present(["CLOUDFLARE_API_KEY", "CF_API_KEY"]),
      email: present(["CLOUDFLARE_EMAIL", "CF_EMAIL"]),
    },
  };
}
const failureCodes = Object.freeze({
  arguments: "ENROLLMENT_ARGUMENTS_INVALID",
  dependencies: "ENROLLMENT_DEPENDENCIES_UNAVAILABLE",
  terminal: "ENROLLMENT_PRIVATE_TTY_REQUIRED",
  configuration_read: "ENROLLMENT_CONFIG_READ_FAILED",
  configuration_validate: "ENROLLMENT_CONFIG_REJECTED",
  temporary_directory: "ENROLLMENT_TEMP_DIRECTORY_FAILED",
  preflight_write: "ENROLLMENT_PREFLIGHT_WRITE_FAILED",
  preflight_file: "ENROLLMENT_PREFLIGHT_FILE_FAILED",
  preflight_query: "ENROLLMENT_PREFLIGHT_QUERY_FAILED",
  preflight_response: "ENROLLMENT_PREFLIGHT_RESPONSE_REJECTED",
  legacy_preflight_file: "ENROLLMENT_LEGACY_PREFLIGHT_FILE_FAILED",
  legacy_preflight_query: "ENROLLMENT_LEGACY_PREFLIGHT_QUERY_FAILED",
  legacy_preflight_response: "ENROLLMENT_LEGACY_PREFLIGHT_RESPONSE_REJECTED",
  generation: "ENROLLMENT_GENERATION_FAILED",
  sql_write: "ENROLLMENT_SQL_WRITE_FAILED",
  issue: "ENROLLMENT_ISSUE_FAILED",
  confirmation_query: "ENROLLMENT_CONFIRMATION_QUERY_FAILED",
  confirmation_response: "ENROLLMENT_NOT_CONFIRMED",
  output: "ENROLLMENT_OUTPUT_FAILED",
  cleanup: "ENROLLMENT_CLEANUP_FAILED",
});
const stateCodes = [
  "ENROLLMENT_NODE_UNSUPPORTED",
  "ENROLLMENT_MIGRATIONS_REQUIRED",
  "ENROLLMENT_ACCOUNT_EXISTS",
  "ENROLLMENT_INVITATION_CONSUMED",
  "ENROLLMENT_INVITATION_ACTIVE",
];
export function safeEnrollmentFailure(phase, error) {
  const known = Object.hasOwn(failureCodes, phase);
  const result = {
    code: stateCodes.includes(error?.enrollmentCode)
      ? error.enrollmentCode
      : known
        ? failureCodes[phase]
        : "ENROLLMENT_UNKNOWN_FAILURE",
    phase: known ? phase : "unknown",
  };
  if (Number.isInteger(error?.code) && error.code >= 0 && error.code <= 255)
    result.exit = error.code;
  // D1 --json sends APIError envelopes to stdout, sometimes after progress.
  // Retain only known numeric provider codes, never any CLI output or fields.
  const codes = [];
  for (const output of [error?.stderr, error?.stdout]) {
    if (typeof output !== "string") continue;
    codes.push(...[...output.matchAll(/\[code:\s*(\d+)\]/g)].map((match) => Number(match[1])));
    try {
      const code = JSON.parse(output.slice(output.indexOf("{")))?.error?.code;
      if (Number.isInteger(code)) codes.push(code);
    } catch {
      // Ordinary CLI text and malformed JSON provide no structured code.
    }
  }
  const provider = codes.find((code) => [7403, 9106, 10000, 10021].includes(code));
  if (provider !== undefined) result.provider = provider;
  return result;
}
async function main() {
  let phase = "arguments",
    temp;
  try {
    const args = process.argv.slice(2),
      preflight = args[0] === "--preflight";
    const [configArg, email, ...rest] = preflight ? args.slice(1) : args;
    if (!configArg || !emails.includes(email) || rest.length) throw Error();
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    let runtime;
    if (preflight) {
      try {
        runtime = await resolveEnrollmentWrangler(root);
      } catch {
        /* reported by the dependencies phase below */
      }
      process.stderr.write(
        JSON.stringify(enrollmentPreflightContext(process.env, runtime?.version)) + "\n",
      );
    }
    phase = "terminal";
    if (!preflight && (!process.stdin.isTTY || !process.stdout.isTTY)) throw Error();
    const configPath = resolve(configArg);
    phase = "configuration_read";
    const config = JSON.parse(await readFile(configPath, "utf8"));
    phase = "configuration_validate";
    assertEnrollmentConfig(config);
    phase = "temporary_directory";
    temp = await mkdtemp(resolve(tmpdir(), "pitcrew-private-enrollment-"));
    phase = "dependencies";
    assertEnrollmentNode();
    runtime ??= await resolveEnrollmentWrangler(root);
    const run = (args) =>
      runEnrollmentWrangler(root, [...enrollmentD1Args, "--config", configPath, ...args], {
        logPath: resolve(temp, "vendor.log"),
      });
    // Exercise the same file import and primary query paths without generating
    // a capability or running the INSERT. These EXPLAIN literals are synthetic.
    phase = "preflight_write";
    const sqlPath = resolve(temp, "hash-only.sql");
    await writeFile(
      sqlPath,
      "EXPLAIN " +
        enrollmentSQL({
          id: "00000000-0000-0000-0000-000000000000",
          email,
          hash: "0".repeat(64),
          now: 0,
        }),
      { mode: 0o600 },
    );
    phase = "preflight_file";
    await run(["--file", sqlPath]);
    phase = "preflight_query";
    const ready = await run(["--command", enrollmentPreflightSQL(email)]);
    phase = "preflight_response";
    assertEnrollmentPreflight(ready.stdout);
    if (preflight) {
      // Compare the old shell launcher using only the same read-only requests.
      // A legacy failure is diagnostic; the direct launcher's result stays clear.
      try {
        const legacy = (args) =>
          runEnrollmentLegacyWrangler(
            root,
            [...enrollmentD1Args, "--config", configPath, ...args],
            { logPath: resolve(temp, "legacy-vendor.log") },
          );
        phase = "legacy_preflight_file";
        await legacy(["--file", sqlPath]);
        phase = "legacy_preflight_query";
        const checked = await legacy(["--command", enrollmentPreflightSQL(email)]);
        phase = "legacy_preflight_response";
        assertEnrollmentPreflight(checked.stdout);
        process.stderr.write(
          JSON.stringify({ code: "ENROLLMENT_LEGACY_PREFLIGHT_READY", phase: "legacy_preflight" }) +
            "\n",
        );
      } catch (error) {
        process.stderr.write(JSON.stringify(safeEnrollmentFailure(phase, error)) + "\n");
      }
      phase = "output";
      process.stdout.write(
        JSON.stringify({ code: "ENROLLMENT_PREFLIGHT_READY", phase: "preflight" }) + "\n",
      );
      return;
    }
    phase = "generation";
    const code = randomBytes(32).toString("base64url"),
      id = randomUUID();
    const data = {
      id,
      email,
      hash: createHash("sha256").update(code).digest("hex"),
      now: Date.now(),
    };
    phase = "sql_write";
    await writeFile(sqlPath, enrollmentSQL(data), { mode: 0o600 });
    phase = "issue";
    await run(["--file", sqlPath]);
    // Bulk import stdout contains progress/aggregate statistics, never grant rows.
    phase = "confirmation_query";
    const confirmed = await run(["--command", enrollmentConfirmationSQL(data)]);
    phase = "confirmation_response";
    if (!enrollmentConfirmed(confirmed.stdout, data)) throw Error();
    phase = "output";
    process.stdout.write(
      `Private setup for ${email} (expires in 30 minutes):\nhttp://127.0.0.1:5173/auth/enroll#code=${code}\nHand this link only to its intended recipient. Do not paste it into chat.\n`,
    );
  } catch (error) {
    process.stderr.write(JSON.stringify(safeEnrollmentFailure(phase, error)) + "\n");
    process.exitCode = 1;
  } finally {
    if (temp)
      try {
        await rm(temp, { recursive: true, force: true });
      } catch (error) {
        process.stderr.write(JSON.stringify(safeEnrollmentFailure("cleanup", error)) + "\n");
        process.exitCode = 1;
      }
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
