import { expect, it } from "vite-plus/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

const execute = promisify(execFile);
it("actual local Wrangler applies fresh and populated recipient migrations and atomically rolls back a rebuild failure", async () => {
  const temp = await mkdtemp(join(tmpdir(), "pitcrew-synthetic-enrollment-migration-"));
  try {
    const migrations = join(temp, "migrations"),
      config = join(temp, "wrangler.json"),
      state = join(temp, "state");
    await mkdir(migrations);
    await writeFile(
      config,
      JSON.stringify({
        name: "synthetic-enrollment-migration",
        compatibility_date: "2026-10-03",
        d1_databases: [
          {
            binding: "AUTH_DB",
            database_name: "synthetic-enrollment-migration",
            database_id: "00000000-0000-0000-0000-000000000005",
            migrations_dir: "migrations",
          },
        ],
      }),
    );
    const source = new URL("../migrations/auth/", import.meta.url);
    const files = (await readdir(source)).filter((file) => file.endsWith(".sql")).sort();
    const migration = "0005_native_enrollment_recipients.sql";
    const replacement = await readFile(new URL(migration, source), "utf8");
    for (const file of files.filter((file) => file !== migration))
      await writeFile(join(migrations, file), await readFile(new URL(file, source)));
    const cli = async (command: string[], persist = state) =>
      execute(
        process.execPath,
        [
          resolve("node_modules/wrangler/bin/wrangler.js"),
          "d1",
          ...command,
          "AUTH_DB",
          "--local",
          "--persist-to",
          persist,
          "--config",
          config,
        ],
        {
          cwd: temp,
          env: {
            PATH: process.env.PATH,
            WRANGLER_SEND_METRICS: "false",
            WRANGLER_LOG_PATH: join(temp, "wrangler.log"),
            CI: "true",
            NO_COLOR: "1",
          },
          maxBuffer: 1048576,
        },
      );
    const query = async (sql: string, persist = state) => {
      const { stdout } = await cli(["execute", "--json", "--command", sql], persist);
      const results = JSON.parse(stdout) as {
        success: boolean;
        results: Record<string, unknown>[];
      }[];
      expect(results.every((result) => result.success)).toBe(true);
      return results.flatMap((result) => result.results);
    };
    await cli(["migrations", "apply"]);
    await query(`INSERT INTO user(id,name,email,email_verified,created_at,updated_at,access_actor,username)
      VALUES('synthetic-owner','Owner','dev@lilfrogdev.com',0,1,1,'enrollment:owner-grant','owner');
      INSERT INTO auth_enrollment(id,recipient_email,token_sha256,expires_at,consumed_at,consumed_user_id)
      VALUES('owner-grant','dev@lilfrogdev.com','${"a".repeat(64)}',12345,123,'synthetic-owner'),
      ('burned-grant','bryan.aldair.zamora@gmail.com','${"b".repeat(64)}',1,321,NULL);`);
    const before = await query("SELECT * FROM auth_enrollment ORDER BY id;");
    await writeFile(join(migrations, migration), replacement);
    await cli(["migrations", "apply"]);
    expect(await query("SELECT * FROM auth_enrollment ORDER BY id;")).toEqual(before);
    expect(await query("PRAGMA foreign_key_check;")).toEqual([]);
    expect(
      await query(
        "SELECT name FROM d1_migrations WHERE name='0005_native_enrollment_recipients.sql';",
      ),
    ).toEqual([{ name: migration }]);
    await query(`INSERT INTO auth_enrollment(id,recipient_email,token_sha256,expires_at)
      VALUES('john-grant','john.cena@example.com','${"c".repeat(64)}',12345),
      ('lara-grant','lara.croft@example.com','${"d".repeat(64)}',12345);`);
    await expect(
      query(
        "UPDATE auth_enrollment SET consumed_user_id='missing',consumed_at=1 WHERE id='john-grant';",
      ),
    ).rejects.toThrow();
    const upgraded = await query("SELECT * FROM auth_enrollment ORDER BY id;"),
      schema = await query(
        "SELECT name,sql FROM sqlite_master WHERE tbl_name='auth_enrollment' ORDER BY name;",
      ),
      journal = await query("SELECT * FROM d1_migrations ORDER BY id;");
    // Wrangler appends its journal INSERT after the migration SQL. This fault
    // occurs after DROP/RENAME and before that INSERT, exercising the CLI path.
    await writeFile(
      join(migrations, "0006_synthetic_failure.sql"),
      replacement + "\nINSERT INTO missing_table VALUES(1);\n",
    );
    await expect(cli(["migrations", "apply"])).rejects.toThrow();
    expect(await query("SELECT * FROM auth_enrollment ORDER BY id;")).toEqual(upgraded);
    expect(
      await query(
        "SELECT name,sql FROM sqlite_master WHERE tbl_name='auth_enrollment' ORDER BY name;",
      ),
    ).toEqual(schema);
    expect(await query("SELECT * FROM d1_migrations ORDER BY id;")).toEqual(journal);
    expect(
      await query("SELECT name FROM sqlite_master WHERE name='auth_enrollment_next';"),
    ).toEqual([]);
    await rm(join(migrations, "0006_synthetic_failure.sql"));
    const freshState = join(temp, "fresh-state");
    await cli(["migrations", "apply"], freshState);
    expect(await query("SELECT name FROM d1_migrations ORDER BY id;", freshState)).toEqual(
      files.map((name) => ({ name })),
    );
    expect(await query("SELECT count(*) count FROM auth_enrollment;", freshState)).toEqual([
      { count: 0 },
    ]);
    await query(
      `INSERT INTO auth_enrollment(id,recipient_email,token_sha256,expires_at)
      VALUES('fresh-john','john.cena@example.com','${"e".repeat(64)}',12345),
      ('fresh-lara','lara.croft@example.com','${"f".repeat(64)}',12345);`,
      freshState,
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}, 120000);
