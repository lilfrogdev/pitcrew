import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NativeTrustedPublisher, exportCandidateBundle, publisherBundleDigest, publisherFingerprint,
  signPublisherAuthorization, verifyPublisherAuthorization, MAX_PUBLISHER_BUNDLE_BYTES }
  from "../src/trusted-publisher.ts";
import { publisherFixture, git, FAKE_SECRET, PINNED_IMAGE } from "./trusted-publisher-fixture.mjs";

async function signed(input) {
  input.bundleDigest = await publisherBundleDigest(input.bundleBase64);
  input.authorization = await signPublisherAuthorization(input, FAKE_SECRET);
  return input;
}

test("real Git publishes inert objects in a fresh publisher, with no candidate hook/config execution", async () => {
  const f = await publisherFixture();
  try {
    const result = await f.publisher.execute(f.input);
    assert.equal(result.status, "published"); assert.equal(result.cleanupVerified, true);
    assert.equal(result.bundleReference, f.input.operationId);
    assert.equal(git(f.artifact, "rev-parse", "refs/heads/candidate"), f.candidateSha);
    assert.equal(git(f.source, "rev-parse", "main"), f.baseSha);
    assert.equal(existsSync(f.marker), false);
    assert.deepEqual(f.tokens, [{ kind: "artifact", scope: "write", ttl: 60 }]);
    assert.deepEqual(f.revoked, ["fake-lease"]); assert.equal(f.container.running, false);
    assert.deepEqual(f.container.startInput.entrypoint, ["/bin/sleep", "120"]);
    const tokenExecs = f.execs.filter(({ config }) => config.env.GIT_CONFIG_VALUE_0);
    assert.equal(tokenExecs.length, 1);
    assert.equal(tokenExecs[0].config.cwd, "/publisher");
    assert.match(tokenExecs[0].config.env.GIT_CONFIG_KEY_0, /^http\.https:\/\/fixture\.artifacts/);
    assert.ok(f.execs.every(({ argv, config }) => !argv.includes("checkout") && !argv.includes("clone") &&
      config.env.GIT_CONFIG_GLOBAL === "/dev/null" && argv.includes("core.hooksPath=/dev/null") &&
      argv.includes("credential.helper=") && argv.includes("http.followRedirects=false")));
    const strict = f.execs.findIndex(({ argv }) => argv.includes("fsck"));
    const credential = f.execs.findIndex(({ config }) => config.env.GIT_CONFIG_VALUE_0);
    assert.ok(strict >= 0 && strict < credential);
  } finally { f.close(); }
});

for (const [name, mutate, code] of [
  ["spoofed candidate SHA", (i) => ({ ...i, candidateSha: "f".repeat(40) }), "BUNDLE_IDENTITY_MISMATCH"],
  ["extra bundle ref", (i) => ({ ...i, bundleBase64: Buffer.from(Buffer.from(i.bundleBase64, "base64")
    .toString("binary").replace(" HEAD\n\n", ` HEAD\n${i.baseSha} refs/replace/evil\n\n`), "binary").toString("base64") }), "BUNDLE_IDENTITY_MISMATCH"],
  ["bundle prerequisite", (i) => ({ ...i, bundleBase64: Buffer.from(Buffer.from(i.bundleBase64, "base64")
    .toString("binary").replace("# v2 git bundle\n", `# v2 git bundle\n-${i.baseSha} required\n`), "binary").toString("base64") }), "BUNDLE_IDENTITY_MISMATCH"],
  ["config attempt as bundle", (i) => ({ ...i, bundleBase64: Buffer.from("[credential]\nhelper=!bad\n").toString("base64") }), "BUNDLE_IDENTITY_MISMATCH"],
  ["alternate destination", (i) => ({ ...i, artifactRemote: "https://attacker.invalid/git/pitcrew/pc-fork.git" }), "INVALID_ARTIFACT_REMOTE"],
  ["encoded path attempt", (i) => ({ ...i, artifactRemote: "https://fixture.artifacts.cloudflare.net/git/pitcrew/%2e%2e.git" }), "INVALID_ARTIFACT_REMOTE"],
  ["source/fork alias", (i) => ({ ...i, artifactRepositoryId: i.sourceRepositoryId }), "DESTINATION_CONFLICT"],
  ["expired operation", (i) => ({ ...i, deadline: Date.now() - 1 }), "PUBLISHER_EXPIRED"],
  ["unbounded lifetime", (i) => ({ ...i, deadline: Date.now() + 121_000 }), "PUBLISHER_EXPIRED"],
  ["oversized bundle", (i) => ({ ...i, bundleBase64: Buffer.alloc(MAX_PUBLISHER_BUNDLE_BYTES + 1).toString("base64") }), "INVALID_BUNDLE"],
]) test(`${name} is rejected before any container or credential`, async () => {
  const f = await publisherFixture();
  try {
    await assert.rejects(async () => f.publisher.execute(await signed(mutate(f.input))), { code });
    assert.equal(f.tokens.length, 0); assert.equal(f.execs.length, 0); assert.equal(f.container.running, false);
  } finally { f.close(); }
});

for (const options of [
  { artifactInfo: { id: "wrong-immutable-id" } },
  { artifactInfo: { remote: "https://fixture.artifacts.cloudflare.net/git/pitcrew/other.git" } },
  { artifactInfo: { source: "artifacts:pitcrew/other" } },
  { sourceInfo: { defaultBranch: "alternate" } },
  { artifactInfo: { readOnly: true } },
]) test("fresh destination identity is verified before any token", async () => {
  const f = await publisherFixture(options);
  try {
    const result = await f.publisher.execute(f.input);
    assert.equal(result.status, "rejected"); assert.equal(result.cleanupVerified, true);
    assert.equal(f.tokens.length, 0); assert.equal(f.execs.length, 0);
  } finally { f.close(); }
});

test("invalid pack contents fail strict index-pack before a token", async () => {
  const f = await publisherFixture();
  try {
    const bytes = Buffer.from(f.input.bundleBase64, "base64"); bytes[bytes.length - 1] ^= 1;
    const result = await f.publisher.execute(await signed({ ...f.input, bundleBase64: bytes.toString("base64") }));
    assert.equal(result.status, "rejected"); assert.equal(result.code, "INVALID_GIT_OBJECTS");
    assert.equal(f.tokens.length, 0); assert.equal(result.cleanupVerified, true);
  } finally { f.close(); }
});

test("unrelated candidate ancestry fails before a token", async () => {
  const f = await publisherFixture();
  try {
    git(f.candidate, "checkout", "--orphan", "unrelated"); git(f.candidate, "commit", "-m", "unrelated");
    const sha = git(f.candidate, "rev-parse", "HEAD"), bundle = join(f.root, "orphan.bundle");
    git(f.candidate, "bundle", "create", "--version=2", bundle, "HEAD");
    const result = await f.publisher.execute(await signed({ ...f.input, candidateSha: sha,
      bundleBase64: readFileSync(bundle).toString("base64") }));
    assert.equal(result.status, "rejected"); assert.equal(f.tokens.length, 0);
    assert.match(result.code, /COMMIT_IDENTITY_MISMATCH|NON_FAST_FORWARD/);
  } finally { f.close(); }
});

test("exact signed tuple binds destination, deadline, SHA, phase and authorization", async () => {
  const f = await publisherFixture();
  try {
    await verifyPublisherAuthorization(f.input, FAKE_SECRET);
    for (const patch of [{ artifactRepositoryId: "spoof" }, { deadline: f.input.deadline + 1 },
      { candidateSha: f.baseSha }, { sourceRemote: f.input.artifactRemote }, { kind: "land", authorizationId: "spoof" }])
      await assert.rejects(verifyPublisherAuthorization({ ...f.input, ...patch }, FAKE_SECRET), { code: "PUBLISHER_UNAUTHORIZED" });
    await assert.rejects(verifyPublisherAuthorization(f.input, "other-local-key-01234567890123456789"), { code: "PUBLISHER_UNAUTHORIZED" });
  } finally { f.close(); }
});

test("complete replay returns receipt and pending replay cannot push", async () => {
  const f = await publisherFixture();
  try {
    const result = await f.publisher.execute(f.input), count = f.execs.length;
    assert.deepEqual(await f.publisher.execute(f.input), result); assert.equal(f.execs.length, count);
    const record = await f.journal.read(f.input.operationId); delete record.result; record.state = "pending";
    f.journal.records.set(f.input.operationId, record);
    assert.equal((await f.publisher.execute(f.input)).code, "PUBLISHER_PENDING_RECONCILIATION");
    assert.equal(f.execs.length, count);
    await assert.rejects(f.publisher.execute(await signed({ ...f.input, configurationRevision: "other" })),
      { code: "PUBLISHER_REPLAY_CONFLICT" });
  } finally { f.close(); }
});

test("input fingerprint is frozen before awaited admission", async () => {
  let resolve; const wait = new Promise((r) => { resolve = r; }); let started;
  const admittedStarted = new Promise((r) => { started = r; });
  const f = await publisherFixture({ admitted: async () => { started(); await wait; } });
  try {
    const originalSha = f.input.candidateSha;
    const operation = f.publisher.execute(f.input); await admittedStarted;
    f.input.candidateSha = "e".repeat(40); f.input.artifactRemote = "https://attacker.invalid";
    resolve(); const result = await operation;
    assert.equal(result.status, "published"); assert.equal(git(f.artifact, "rev-parse", "refs/heads/candidate"), originalSha);
  } finally { resolve(); f.close(); }
});

test("cancellation while admission awaits prevents subsequent effects", async () => {
  const f = await publisherFixture(); let first = true;
  const publisher = new NativeTrustedPublisher(f.artifacts, f.container, PINNED_IMAGE, f.journal, async (input) => {
    if (first) { first = false; await f.journal.update(input.operationId,
      await publisherFingerprint(f.input), { cancelled: true }); }
  });
  try {
    const result = await publisher.execute(f.input);
    assert.equal(result.code, "PUBLISHER_CANCELLED"); assert.equal(f.execs.length, 0); assert.equal(f.tokens.length, 0);
  } finally { f.close(); }
});

test("admission revoked after object validation fences write-token issuance", async () => {
  const f = await publisherFixture();
  const publisher = new NativeTrustedPublisher(f.artifacts, f.container, PINNED_IMAGE, f.journal, async () => {
    if (f.execs.some(({ argv }) => argv.includes("fsck"))) throw Error("durable admission stopped");
  });
  try {
    const result = await publisher.execute(f.input);
    assert.equal(result.status, "rejected"); assert.equal(f.tokens.length, 0); assert.equal(result.cleanupVerified, true);
  } finally { f.close(); }
});

test("hung native exec times out and destroys owned container", async () => {
  const f = await publisherFixture({ exec: () => new Promise(() => {}) });
  try {
    const result = await f.publisher.execute(await signed({ ...f.input, deadline: Date.now() + 100 }));
    assert.equal(result.code, "PUBLISHER_TIMEOUT"); assert.equal(result.cleanupVerified, true);
    assert.equal(f.container.running, false); assert.equal(f.tokens.length, 0);
  } finally { f.close(); }
});

test("expired continuation cannot start an owned container", async () => {
  let clock = Date.now();
  const f = await publisherFixture({ now: () => clock, admitted: async () => { clock += 120_000; } });
  try {
    clock = Date.now(); await signed(Object.assign(f.input, { deadline: clock + 120_000 }));
    const result = await f.publisher.execute(f.input);
    assert.equal(result.code, "PUBLISHER_EXPIRED"); assert.equal(f.tokens.length, 0); assert.equal(f.execs.length, 0);
  } finally { f.close(); }
});

for (const options of [{ revoke: false }, { destroyFailure: true }, { inspectFailure: true }])
  test("cleanup failure retains uncertain receipt and cannot replay push", async () => {
    const f = await publisherFixture(options);
    try {
      const result = await f.publisher.execute(f.input), count = f.execs.length;
      assert.equal(result.status, "uncertain"); assert.equal(result.cleanupVerified, false);
      assert.equal(result.code, "PUBLISHER_CLEANUP_UNVERIFIED");
      assert.deepEqual(await f.publisher.execute(f.input), result); assert.equal(f.execs.length, count);
    } finally { f.close(); }
  });

test("source landing validates exact base and updates only the approved ref", async () => {
  const f = await publisherFixture();
  try {
    const input = await signed({ ...f.input, kind: "land", operationId: "land-one", authorizationId: "approval-one",
      targetRef: "refs/heads/main", expectedTargetSha: f.baseSha });
    const result = await f.publisher.execute(input);
    assert.equal(result.status, "landed"); assert.equal(result.cleanupVerified, true);
    assert.equal(git(f.source, "rev-parse", "main"), f.candidateSha);
    assert.equal(git(f.source, "rev-parse", "main^{tree}"), git(f.candidate, "rev-parse", "HEAD^{tree}"));
    assert.deepEqual(f.tokens, [{ kind: "source", scope: "write", ttl: 60 }]);
    const push = f.execs.find(({ argv }) => argv.includes("push"));
    assert.ok(push.argv.includes(`--force-with-lease=refs/heads/main:${f.baseSha}`));
    assert.ok(!push.argv.includes("--force"));
  } finally { f.close(); }
});

test("source race before push is rejected by Git old-ref comparison", async () => {
  let raced = false;
  const f = await publisherFixture({ exec: (argv, _config, { source, candidate, git }) => {
    if (argv.includes("push") && !raced) { raced = true;
      writeFileSync(join(candidate, "competing.txt"), "competing\n"); git(candidate, "add", "competing.txt");
      git(candidate, "commit", "-m", "competing"); git(candidate, "-c", "core.hooksPath=/dev/null", "push", source, "HEAD:main"); }
  } });
  try {
    const result = await f.publisher.execute(await signed({ ...f.input, kind: "land", operationId: "land-race",
      authorizationId: "approval-one", targetRef: "refs/heads/main", expectedTargetSha: f.baseSha }));
    assert.equal(result.status, "uncertain"); assert.equal(result.code, "RECONCILIATION_REQUIRED");
    assert.notEqual(git(f.source, "rev-parse", "main"), f.candidateSha);
    const count = f.execs.length;
    // Local receive-pack evidence only; no Cloudflare provider conformance claim.
    assert.equal(count > 0, true);
  } finally { f.close(); }
});

test("candidate export uses a bounded credential-free port and rejects substituted HEAD", async () => {
  const f = await publisherFixture();
  try {
    let command;
    const workspace = { runId: "run", projectId: "project", repository: "source", workerId: "worker",
      artifactId: "artifact", baseSha: f.baseSha, configurationRevision: "revision" };
    const port = async (_workspace, input) => { command = input; return { status: "completed", exitCode: 0,
      stdout: f.bundleBase64, stderr: "", truncated: false }; };
    assert.equal(await exportCandidateBundle(workspace, f.candidateSha, port, async () => {}), f.bundleBase64);
    assert.equal(command.maxOutputBytes, 1_024_000); assert.equal(command.timeoutMs, 30_000);
    assert.ok(!JSON.stringify(command).includes("Authorization"));
    await assert.rejects(exportCandidateBundle(workspace, "f".repeat(40), port, async () => {}),
      { code: "BUNDLE_IDENTITY_MISMATCH" });
    await assert.rejects(exportCandidateBundle(workspace, f.candidateSha, async () => ({ status: "completed",
      exitCode: 0, stdout: f.bundleBase64, stderr: "", truncated: true }), async () => {}), { code: "BUNDLE_EXPORT_FAILED" });
  } finally { f.close(); }
});

test("unknown resource cleanup never claims proof", async () => {
  const f = await publisherFixture();
  try { assert.equal(await f.publisher.cleanup("unknown"), false); }
  finally { f.close(); }
});
