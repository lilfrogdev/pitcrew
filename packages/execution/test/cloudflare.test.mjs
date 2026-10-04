import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { Readable } from "node:stream";
import { CloudflareArtifacts, CloudflareSandbox } from "../src/index.ts";

const baseSha = "a".repeat(40);
const candidateSha = "b".repeat(40);
const workspace = {
  projectId: "project",
  runId: "run",
  repository: "canonical",
  baseSha,
  configurationRevision: "1",
  workerId: "worker-1",
  artifactId: "fork-1",
};
const cmd = { commandId: "test", argv: ["npm", "test"], timeoutMs: 1000, maxOutputBytes: 1024 };
const bytes = (text) => new TextEncoder().encode(text);
const stream = (chunks) =>
  new ReadableStream({
    start(controller) {
      for (const chunk of chunks)
        controller.enqueue(typeof chunk === "string" ? bytes(chunk) : chunk);
      controller.close();
    },
  });

function fixture() {
  const calls = {
    get: [],
    revoke: [],
    tokens: [],
    forks: [],
    exec: [],
    destroy: [],
    start: [],
    disposed: 0,
  };
  const binding = {
    get: async (name) => {
      calls.get.push(name);
      return {
        [Symbol.dispose]() {
          calls.disposed++;
        },
        info: async () => ({
          name,
          defaultBranch: "main",
          remote: `https://account.artifacts.cloudflare.net/git/default/${name}.git`,
        }),
        log: async () => [{ hash: baseSha }],
        fork: async (target, options) => {
          calls.forks.push({ target, options });
          return { name: target, token: "initial-fork-only-secret" };
        },
        revokeToken: async (token) => {
          calls.revoke.push({ name, token });
          return true;
        },
        createToken: async (scope, ttl) => {
          calls.tokens.push({ name, scope, ttl });
          return {
            id: "lease-id",
            plaintext: "fork-only-token",
            scope,
            expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
          };
        },
        readCommit: async (hash) => ({ hash }),
      };
    },
  };
  const container = {
    start: (options) => calls.start.push(options),
    destroy: async (reason) => {
      calls.destroy.push(reason);
    },
    exec: async (argv, options) => {
      calls.exec.push({ argv, options });
      return { stdout: stream([]), stderr: stream([]), exitCode: Promise.resolve(0) };
    },
  };
  const sandbox = new CloudflareSandbox(
    binding,
    (id) => {
      assert.equal(id, workspace.workerId);
      return container;
    },
    "registered-tests-image",
  );
  return { calls, binding, container, sandbox };
}

test("Artifacts uses documented fork API, checks base, revokes creation token and disposes capabilities", async () => {
  const f = fixture();
  await new CloudflareArtifacts(f.binding).fork("canonical", "fork-1", baseSha);
  assert.deepEqual(f.calls.forks, [
    { target: "fork-1", options: { defaultBranchOnly: true, readOnly: false } },
  ]);
  assert.deepEqual(f.calls.revoke, [{ name: "fork-1", token: "initial-fork-only-secret" }]);
  assert.equal(f.calls.disposed, 2);
});

test("Artifacts rejects stale canonical base before fork creation", async () => {
  const f = fixture();
  await assert.rejects(
    new CloudflareArtifacts(f.binding).fork("canonical", "fork-1", candidateSha),
    { code: "STALE_BASE" },
  );
  assert.equal(f.calls.forks.length, 0);
});

test("bootstrap gets only fork read lease, no canonical/account token, revokes before task runs", async () => {
  const f = fixture();
  await f.sandbox.prepare(workspace);
  assert.deepEqual(f.calls.tokens, [{ name: "fork-1", scope: "read", ttl: 300 }]);
  assert.deepEqual(f.calls.get, ["fork-1"]);
  assert.deepEqual(f.calls.revoke, [{ name: "fork-1", token: "lease-id" }]);
  assert.equal(f.calls.start[0].image, "registered-tests-image");
  assert.equal(
    f.calls.exec[0].options.env.GIT_CONFIG_VALUE_0,
    "Authorization: Bearer fork-only-token",
  );
  assert.ok(!JSON.stringify(f.calls.exec[0].argv).includes("fork-only-token"));
  assert.equal(f.calls.exec[1].options.env, undefined);
  await f.sandbox.run(workspace, cmd);
  assert.equal(f.calls.exec.at(-1).options.env, undefined);
  assert.ok(!JSON.stringify(f.calls.exec.at(-1)).includes("fork-only-token"));
});

test("token revocation error destroys sandbox and fails closed without leaking token", async () => {
  const f = fixture();
  const get = f.binding.get;
  f.binding.get = async (name) => ({
    ...(await get(name)),
    revokeToken: async () => {
      throw new Error("fork-only-token");
    },
  });
  await assert.rejects(f.sandbox.prepare(workspace), { message: "TOKEN_REVOCATION_FAILED" });
  assert.equal(f.calls.destroy.at(-1), "token revocation failed");
});

test("invalid or overly long token lease is revoked without running task code", async () => {
  const f = fixture();
  const get = f.binding.get;
  f.binding.get = async (name) => ({
    ...(await get(name)),
    createToken: async () => ({
      id: "invalid-id",
      plaintext: "secret",
      scope: "read",
      expiresAt: "invalid",
    }),
  });
  await assert.rejects(f.sandbox.prepare(workspace));
  assert.equal(f.calls.exec.length, 0);
  assert.equal(f.calls.revoke[0].token, "invalid-id");
});

test("unexpected authenticated or external Git remote rejected before minting token", async () => {
  const f = fixture();
  const get = f.binding.get;
  f.binding.get = async (name) => ({
    ...(await get(name)),
    info: async () => ({ remote: "https://secret@example.org/repository.git" }),
  });
  await assert.rejects(f.sandbox.prepare(workspace), { code: "INVALID_ARTIFACT_REMOTE" });
  assert.equal(f.calls.tokens.length, 0);
});

test("publish pushes exact SHA to fork only with expiring write lease, then revokes", async () => {
  const f = fixture();
  await f.sandbox.publish(workspace, candidateSha);
  assert.deepEqual(f.calls.tokens, [{ name: "fork-1", scope: "write", ttl: 300 }]);
  assert.ok(f.calls.exec[0].argv.includes(`${candidateSha}:refs/heads/candidate`));
  assert.ok(!f.calls.exec[0].argv.includes("canonical"));
  assert.equal(f.calls.revoke.length, 1);
});

test("streams stdout and stderr concurrently within a shared output budget", async () => {
  const f = fixture();
  f.container.exec = async () => ({
    stdout: stream(["abc", "def"]),
    stderr: stream(["error"]),
    exitCode: Promise.resolve(0),
  });
  const result = await f.sandbox.run(workspace, { ...cmd, maxOutputBytes: 5 });
  assert.equal(result.status, "output_limit");
  assert.equal(result.truncated, true);
  assert.ok(bytes(result.stdout + result.stderr).length <= 5);
  assert.equal(f.calls.destroy.length, 1);
});

test("UTF-8 chunks decode across boundaries without corrupting successful evidence", async () => {
  const f = fixture();
  const utf8 = bytes("snow ☃");
  f.container.exec = async () => ({
    stdout: stream([utf8.slice(0, 6), utf8.slice(6)]),
    stderr: stream([]),
    exitCode: Promise.resolve(0),
  });
  assert.equal((await f.sandbox.run(workspace, cmd)).stdout, "snow ☃");
});

test("hard watchdog destroys instance including descendants when exec cannot settle", async () => {
  const f = fixture();
  f.container.exec = async () => new Promise(() => {});
  const result = await f.sandbox.run(workspace, { ...cmd, timeoutMs: 10 });
  assert.equal(result.status, "timed_out");
  assert.equal(result.exitCode, null);
  assert.deepEqual(f.calls.destroy, ["timed_out"]);
});

test("abort destroys instance and listeners are removed after normal completion", async () => {
  const f = fixture();
  f.container.exec = async () => new Promise(() => {});
  const controller = new AbortController();
  const pending = f.sandbox.run(workspace, cmd, controller.signal);
  controller.abort();
  assert.equal((await pending).status, "stopped");
  assert.equal(f.calls.destroy.length, 1);
  const g = fixture();
  const later = new AbortController();
  await g.sandbox.run(workspace, cmd, later.signal);
  later.abort();
  assert.equal(g.calls.destroy.length, 0);
});

test("runtime errors sanitized and whole instance stopped", async () => {
  const f = fixture();
  f.container.exec = async () => {
    throw new Error("canonical-secret-must-not-leak");
  };
  await assert.rejects(f.sandbox.run(workspace, cmd), { message: "COMMAND_FAILED" });
  assert.equal(f.calls.destroy.length, 1);
});

test("native argv does not interpolate shell syntax and uses process-group timeout", async () => {
  const f = fixture();
  await f.sandbox.run(workspace, { ...cmd, argv: ["printf", "$(secret) ; rm -rf /"] });
  assert.deepEqual(f.calls.exec[0].argv, [
    "timeout",
    "--kill-after=1",
    "1s",
    "printf",
    "$(secret) ; rm -rf /",
  ]);
});

test("file tool paths/size bounded before exec; content is passed as an argument", async () => {
  const f = fixture();
  for (const path of ["/etc/passwd", "../escape", "src/../../escape", ".git/config"])
    await assert.rejects(f.sandbox.writeFile(workspace, path, "x"), { code: "INVALID_PATH" });
  await assert.rejects(f.sandbox.writeFile(workspace, "source.ts", "x".repeat(8193)), {
    code: "FILE_TOO_LARGE",
  });
  assert.equal(f.calls.exec.length, 0);
  await f.sandbox.writeFile(workspace, "src/file.ts", "literal $(shell)");
  assert.equal(f.calls.exec[0].argv.at(-1), "literal $(shell)");
});

test("native abort port stops a real owned process and descendant while unrelated work continues", async () => {
  const f = fixture();
  const unrelated = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { shell: false });
  const unrelatedExit = once(unrelated, "exit");
  let owned;
  let ownedExit;
  let descendant;
  let ready;
  const started = new Promise((resolve) => {
    ready = resolve;
  });
  f.container.exec = async () => {
    owned = spawn(
      process.execPath,
      [
        "-e",
        `
      const { spawn } = require("node:child_process");
      const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
      process.stdout.write(String(child.pid));
      process.on("SIGTERM", () => {
        child.once("exit", () => process.exit(0));
        child.kill();
      });
    `,
      ],
      { shell: false, detached: true },
    );
    ownedExit = once(owned, "exit");
    owned.stdout.once("data", (data) => {
      descendant = Number(data.toString());
      ready();
    });
    return {
      stdout: Readable.toWeb(owned.stdout),
      stderr: Readable.toWeb(owned.stderr),
      exitCode: ownedExit.then(([code]) => code),
    };
  };
  f.container.destroy = async () => {
    process.kill(-owned.pid, "SIGTERM");
    await ownedExit;
  };
  const controller = new AbortController();
  try {
    const pending = f.sandbox.run(workspace, { ...cmd, timeoutMs: 5000 }, controller.signal);
    await started;
    assert.ok(descendant > 0);
    controller.abort();
    assert.equal((await pending).status, "stopped");
    assert.throws(() => process.kill(descendant, 0), { code: "ESRCH" });
    assert.doesNotThrow(() => process.kill(unrelated.pid, 0));
  } finally {
    if (owned && owned.exitCode === null) {
      process.kill(-owned.pid, "SIGTERM");
      await ownedExit;
    }
    unrelated.kill();
    await unrelatedExit;
  }
});

for (const code of [124, 137]) {
  test(`in-container timeout exit ${code} destroys the instance before acknowledging timeout`, async () => {
    const f = fixture();
    let release;
    const destroyed = new Promise((resolve) => {
      release = resolve;
    });
    f.container.exec = async () => ({
      stdout: stream(["partial"]),
      stderr: stream([]),
      exitCode: Promise.resolve(code),
    });
    f.container.destroy = async (reason) => {
      f.calls.destroy.push(reason);
      await destroyed;
    };
    let acknowledged = false;
    const pending = f.sandbox.run(workspace, cmd).then((result) => {
      acknowledged = true;
      return result;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(f.calls.destroy, ["timed_out"]);
    assert.equal(acknowledged, false);
    release();
    assert.deepEqual(await pending, {
      status: "timed_out",
      exitCode: null,
      stdout: "partial",
      stderr: "",
      truncated: false,
    });
  });
}
