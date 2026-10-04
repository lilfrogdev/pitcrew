import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { GitLandingTransport, verifyLandingConformance } from "../src/index.ts";

const execute = promisify(execFile);
const env = {
  PATH: process.env.PATH,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
};
async function git(cwd, argv) {
  try {
    const { stdout } = await execute(
      "git",
      ["--no-replace-objects", "-c", "commit.gpgsign=false", ...argv],
      { cwd, env, timeout: 5000, maxBuffer: 65536 },
    );
    return { exitCode: 0, stdout };
  } catch (error) {
    return {
      exitCode: typeof error.code === "number" ? error.code : 1,
      stdout: error.stdout ?? "",
    };
  }
}
async function must(cwd, argv) {
  const result = await git(cwd, argv);
  assert.equal(result.exitCode, 0, JSON.stringify(argv));
  return result.stdout.trim();
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pitcrew-landing-"));
  const seed = join(root, "seed"),
    target = join(root, "target.git"),
    candidate = join(root, "candidate.git"),
    competingFork = join(root, "competing.git");
  await mkdir(seed);
  await must(seed, ["init", "-b", "main"]);
  await writeFile(join(seed, "app.txt"), "base\n");
  await must(seed, ["add", "."]);
  const commit = async (message) =>
    must(seed, [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@invalid",
      "commit",
      "-m",
      message,
    ]);
  await commit("base");
  const baseSha = await must(seed, ["rev-parse", "HEAD"]);
  await must(seed, ["switch", "-c", "candidate"]);
  await writeFile(join(seed, "app.txt"), "reviewed candidate\n");
  await mkdir(join(seed, ".githooks"));
  await writeFile(
    join(seed, ".githooks", "pre-push"),
    "#!/bin/sh\ntouch " + join(root, "candidate-code-executed") + "\n",
  );
  await must(seed, ["add", "."]);
  await commit("candidate");
  const candidateSha = await must(seed, ["rev-parse", "HEAD"]);
  await must(seed, ["switch", "-c", "competing", baseSha]);
  await writeFile(join(seed, "other.txt"), "competitor\n");
  await must(seed, ["add", "."]);
  await commit("competitor");
  const competingSha = await must(seed, ["rev-parse", "HEAD"]);
  await must(seed, ["switch", "--orphan", "divergent"]);
  await writeFile(join(seed, "unrelated.txt"), "different history\n");
  await must(seed, ["add", "."]);
  await commit("divergent");
  const divergentSha = await must(seed, ["rev-parse", "HEAD"]);
  await must(root, ["clone", "--bare", seed, target]);
  await must(root, ["clone", "--bare", seed, candidate]);
  await must(root, ["clone", "--bare", seed, competingFork]);
  await must(competingFork, ["update-ref", "refs/heads/candidate", competingSha]);
  await must(target, ["update-ref", "refs/heads/main", baseSha]);
  await must(target, ["config", "receive.denyNonFastForwards", "true"]);
  let race,
    receiveCommand,
    loseAck = false;
  const sessions = [],
    accesses = [];
  const factory = {
    async open(authorization) {
      const cwd = await mkdtemp(join(root, "trusted-bare-"));
      await must(cwd, ["init", "--bare"]);
      sessions.push(cwd);
      return {
        targetRemote: target,
        candidateRemote: authorization.artifactId === "competing-fork" ? competingFork : candidate,
        async run(argv, access) {
          accesses.push({ argv, access });
          if (argv[0] === "push" && race) {
            const action = race;
            race = undefined;
            await action();
          }
          const command =
            argv[0] === "push" && receiveCommand
              ? [argv[0], `--receive-pack=${receiveCommand}`, ...argv.slice(1)]
              : argv;
          const result = await git(cwd, [
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "credential.helper=",
            ...command,
          ]);
          if (argv[0] === "push" && loseAck) {
            loseAck = false;
            throw new Error("write acknowledgement lost");
          }
          return result;
        },
        close: async () => {
          await rm(cwd, { recursive: true, force: true });
        },
      };
    },
  };
  const authorization = {
    authorizationId: "auth",
    runId: "run",
    actor: "human",
    projectId: "project",
    repository: "canonical",
    artifactId: "fork",
    targetRef: "refs/heads/main",
    expectedTargetSha: baseSha,
    candidateSha,
    configurationRevision: "revision",
    expiresAt: Date.now() + 300000,
  };
  return {
    root,
    target,
    candidate,
    factory,
    authorization,
    competingSha,
    divergentSha,
    sessions,
    accesses,
    transport: new GitLandingTransport(factory),
    setRace: (action) => {
      race = action;
    },
    loseAck: () => {
      loseAck = true;
    },
    async raceDuringPush(sha) {
      const hooks = join(root, "receive-hooks");
      await mkdir(hooks, { recursive: true });
      await writeFile(
        join(hooks, "pre-receive"),
        '#!/bin/sh\ntouch "' +
          join(root, "receive-race-fired") +
          '"\nenv -u GIT_QUARANTINE_PATH -u GIT_OBJECT_DIRECTORY -u GIT_ALTERNATE_OBJECT_DIRECTORIES git --git-dir="' +
          target +
          '" update-ref refs/heads/main ' +
          sha +
          "\n",
        { mode: 0o755 },
      );
      receiveCommand = `git -c core.hooksPath="${hooks}" receive-pack`;
    },
    resetTarget: (sha) => {
      receiveCommand = undefined;
      return must(target, ["update-ref", "refs/heads/main", sha]);
    },
    publishCandidate: (sha) => must(candidate, ["update-ref", "refs/heads/candidate", sha]),
    head: () => must(target, ["rev-parse", "refs/heads/main"]),
    targetTree: () => must(target, ["rev-parse", "refs/heads/main^{tree}"]),
    candidateTree: () => must(candidate, ["rev-parse", `${candidateSha}^{tree}`]),
    close: () => rm(root, { recursive: true, force: true }),
  };
}

test("real Git lands the exact reviewed commit/tree without checkout or candidate execution", async () => {
  const f = await fixture();
  try {
    assert.deepEqual(await f.transport.land(f.authorization), { status: "landed" });
    assert.equal(await f.head(), f.authorization.candidateSha);
    assert.equal(await f.targetTree(), await f.candidateTree());
    await assert.rejects(stat(join(f.root, "candidate-code-executed")));
    assert.ok(
      f.accesses.every(
        (call) => !["checkout", "merge", "rebase", "cherry-pick"].includes(call.argv[0]),
      ),
    );
    const push = f.accesses.find((call) => call.argv[0] === "push");
    assert.ok(
      push.argv.includes(`--force-with-lease=refs/heads/main:${f.authorization.expectedTargetSha}`),
    );
    assert.ok(!push.argv.includes("--force") && !push.argv.includes("--atomic"));
  } finally {
    await f.close();
  }
});

test("real Git rejects stale target and divergent candidate without rewriting history", async () => {
  const f = await fixture();
  try {
    await f.resetTarget(f.competingSha);
    assert.equal((await f.transport.land(f.authorization)).code, "STALE_TARGET");
    assert.equal(await f.head(), f.competingSha);
    await f.resetTarget(f.authorization.expectedTargetSha);
    await f.publishCandidate(f.divergentSha);
    assert.equal(
      (await f.transport.land({ ...f.authorization, candidateSha: f.divergentSha })).code,
      "NON_FAST_FORWARD",
    );
    assert.equal(await f.head(), f.authorization.expectedTargetSha);
  } finally {
    await f.close();
  }
});

test("real Git lease rejects competing target after preflight and before advertisement", async () => {
  const f = await fixture();
  try {
    f.setRace(() => f.resetTarget(f.competingSha));
    assert.equal((await f.transport.land(f.authorization)).status, "uncertain");
    assert.equal(await f.head(), f.competingSha);
  } finally {
    await f.close();
  }
});

test("real Git lost push acknowledgement remains uncertain despite exact landed tree", async () => {
  const f = await fixture();
  try {
    f.loseAck();
    assert.equal((await f.transport.land(f.authorization)).status, "uncertain");
    assert.equal(await f.head(), f.authorization.candidateSha);
    assert.equal(await f.targetTree(), await f.candidateTree());
  } finally {
    await f.close();
  }
});

test("real receive-pack rejects old-ref race after advertisement without rewriting competitor", async () => {
  const f = await fixture();
  try {
    await f.raceDuringPush(f.competingSha);
    assert.equal((await f.transport.land(f.authorization)).status, "uncertain");
    assert.equal(await f.head(), f.competingSha);
    assert.ok((await stat(join(f.root, "receive-race-fired"))).isFile());
  } finally {
    await f.close();
  }
});

test("real Git parallel pushes with one expected base land at most one candidate", async () => {
  const f = await fixture();
  try {
    const outcomes = await Promise.all([
      f.transport.land(f.authorization),
      f.transport.land({
        ...f.authorization,
        artifactId: "competing-fork",
        candidateSha: f.competingSha,
      }),
    ]);
    assert.equal(outcomes.filter((result) => result.status === "landed").length, 1);
    assert.ok([f.authorization.candidateSha, f.competingSha].includes(await f.head()));
  } finally {
    await f.close();
  }
});

test("provider conformance probe is executed only against disposable local repositories", async () => {
  const f = await fixture();
  try {
    await verifyLandingConformance(f);
  } finally {
    await f.close();
  }
});
