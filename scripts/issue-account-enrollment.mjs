// Run personally in a private terminal. Never execute this through agent tools:
// the one-time account capability must go only to its operator and recipient.
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execute = promisify(execFile);
const accountId = "004227d2029c56b084ce15356768def3";
const emails = ["dev@lilfrogdev.com", "bryan.aldair.zamora@gmail.com"];
export function enrollmentSQL({ id, email, hash, now }) {
  if (
    !/^[a-f0-9-]{36}$/.test(id) ||
    !emails.includes(email) ||
    !/^[a-f0-9]{64}$/.test(hash) ||
    !Number.isSafeInteger(now)
  )
    throw Error("Invalid enrollment parameters.");
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
  const binding = config.d1_databases?.find((db) => db.binding === "AUTH_DB");
  if (
    config.account_id !== accountId ||
    config.name !== "pitcrew-backend" ||
    config.vars?.AUTH_MODE !== "password-only" ||
    binding?.database_name !== "pitcrew-auth" ||
    !/^[a-f0-9-]{36}$/.test(binding.database_id ?? "")
  )
    throw Error("An approved Pitcrew auth config is required.");
  const code = randomBytes(32).toString("base64url"),
    id = randomUUID();
  const sql = enrollmentSQL({
    id,
    email,
    hash: createHash("sha256").update(code).digest("hex"),
    now: Date.now(),
  });
  const temp = await mkdtemp(resolve(tmpdir(), "pitcrew-private-enrollment-"));
  try {
    const sqlPath = resolve(temp, "hash-only.sql");
    await writeFile(sqlPath, sql, { mode: 0o600 });
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const { stdout } = await execute(
      resolve(root, "node_modules/.bin/wrangler"),
      ["d1", "execute", "AUTH_DB", "--remote", "--json", "--config", configPath, "--file", sqlPath],
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
    const result = JSON.parse(stdout);
    if (
      !Array.isArray(result) ||
      !result.some((entry) => entry.success === true && entry.results?.some((row) => row.id === id))
    )
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
