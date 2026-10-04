import assert from "node:assert/strict";
import { test } from "node:test";
import { NativeTrustedGitSessionFactory, GitLandingTransport } from "../src/index.ts";

const baseSha = "a".repeat(40),
  candidateSha = "b".repeat(40);
const authorization = {
  authorizationId: "authorization",
  runId: "run",
  projectId: "project",
  actor: "human",
  repository: "canonical",
  artifactId: "fork",
  targetRef: "refs/heads/main",
  expectedTargetSha: baseSha,
  candidateSha,
  configurationRevision: "revision",
  expiresAt: Date.now() + 300000,
};
const stream = (text) =>
  new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
function fixture() {
  const calls = { sessions: [], start: [], exec: [], tokens: [], revoked: [], destroyed: [] };
  const binding = {
    get: async (name) => ({
      [Symbol.dispose]() {},
      info: async () => ({
        remote: `https://account.artifacts.cloudflare.net/git/default/${name}.git`,
      }),
      createToken: async (scope, ttl) => {
        calls.tokens.push({ name, scope, ttl });
        return {
          id: `${name}-${scope}`,
          plaintext: `${name}-secret`,
          scope,
          expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
        };
      },
      revokeToken: async (id) => {
        calls.revoked.push(id);
        return true;
      },
    }),
  };
  const container = {
    start: (options) => calls.start.push(options),
    destroy: async (reason) => calls.destroyed.push(reason),
    exec: async (argv, options) => {
      calls.exec.push({ argv, options });
      const command = argv[8];
      const text =
        command === "ls-remote"
          ? `${baseSha}\trefs/heads/main\n`
          : command === "rev-parse"
            ? baseSha
            : command === "cat-file"
              ? "commit\n"
              : command === "push"
                ? `To remote\n \t${candidateSha}:refs/heads/main\tbase..candidate\nDone\n`
                : "";
      return {
        stdout: stream(text),
        stderr: stream("private diagnostic"),
        exitCode: Promise.resolve(0),
      };
    },
  };
  const factory = new NativeTrustedGitSessionFactory(
    binding,
    (id) => {
      calls.sessions.push(id);
      return container;
    },
    "registered-trusted-git-image",
  );
  return { calls, binding, container, factory, transport: new GitLandingTransport(factory) };
}

test("native landing runs only Git in fresh bare trusted sessions, keeping canonical leases out of task code", async () => {
  const f = fixture();
  assert.equal(await f.transport.targetHead(authorization), baseSha);
  assert.deepEqual(await f.transport.land(authorization), { status: "landed" });
  assert.equal(new Set(f.calls.sessions).size, 2);
  assert.ok(f.calls.sessions.every((id) => id.startsWith("landing-git-") && !id.startsWith("pc-")));
  assert.ok(
    f.calls.start.every(
      (options) => options.image === "registered-trusted-git-image" && !options.env,
    ),
  );
  assert.ok(
    f.calls.exec.every(
      (call) => call.argv[0] === "git" && !["checkout", "merge", "test"].includes(call.argv[8]),
    ),
  );
  assert.ok(f.calls.tokens.every((token) => token.ttl === 300));
  assert.ok(f.calls.tokens.some((token) => token.name === "canonical" && token.scope === "write"));
  assert.ok(f.calls.tokens.some((token) => token.name === "fork" && token.scope === "read"));
  assert.ok(!f.calls.tokens.some((token) => token.name === "fork" && token.scope === "write"));
  assert.equal(f.calls.tokens.length, f.calls.revoked.length);
  assert.ok(
    f.calls.exec
      .filter((call) => call.argv[8] === "init")
      .every((call) => !call.options.env.GIT_CONFIG_VALUE_0),
  );
});

test("native trusted runner discards diagnostic output and rejects leaked canonical token", async () => {
  const f = fixture();
  const exec = f.container.exec;
  f.container.exec = async (argv, options) =>
    argv[8] === "ls-remote"
      ? {
          stdout: stream("canonical-secret"),
          stderr: stream("canonical-secret"),
          exitCode: Promise.resolve(0),
        }
      : exec(argv, options);
  await assert.rejects(f.transport.targetHead(authorization), { code: "TRUSTED_GIT_FAILED" });
  assert.ok(f.calls.destroyed.includes("trusted git failed"));
  assert.equal(f.calls.revoked.length, 1);
});

test("native revocation exception destroys trusted instance and keeps landing uncertain", async () => {
  const f = fixture();
  const get = f.binding.get;
  f.binding.get = async (name) => ({
    ...(await get(name)),
    revokeToken: async () => {
      throw new Error("canonical-secret");
    },
  });
  assert.equal((await f.transport.land(authorization)).status, "rejected");
  assert.ok(f.calls.destroyed.includes("landing lease revocation failed"));
});

test("native trusted Git output is bounded before returning any landing receipt", async () => {
  const f = fixture(),
    exec = f.container.exec;
  f.container.exec = async (argv, options) =>
    argv[8] === "ls-remote"
      ? { stdout: stream("x".repeat(65537)), stderr: stream(""), exitCode: Promise.resolve(0) }
      : exec(argv, options);
  await assert.rejects(f.transport.targetHead(authorization), { code: "TRUSTED_GIT_FAILED" });
  assert.ok(f.calls.destroyed.includes("trusted git failed"));
});
