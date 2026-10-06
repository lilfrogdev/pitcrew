import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  NativeTrustedPublisher,
  publisherBundleDigest,
  signPublisherAuthorization,
} from "../src/trusted-publisher.ts";

export const FAKE_SECRET = "local-fixture-only-not-a-real-key-0123456789";
export const PINNED_IMAGE = "registry.example/trusted-publisher@sha256:" + "a".repeat(64);
export class MemoryPublisherJournal {
  records = new Map();
  async claim(id, record) {
    const existing = this.records.get(id);
    if (existing) return { claimed: false, record: structuredClone(existing) };
    this.records.set(id, structuredClone(record));
    return { claimed: true, record: structuredClone(record) };
  }
  async read(id) {
    return structuredClone(this.records.get(id));
  }
  async update(id, fingerprint, patch) {
    const record = this.records.get(id);
    if (!record || record.fingerprint !== fingerprint) throw Error("identity");
    this.records.set(id, {
      ...record,
      ...structuredClone(patch),
      cancelled: record.cancelled || patch.cancelled === true,
    });
  }
}

export function git(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: "/nonexistent",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      LC_ALL: "C",
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export async function publisherFixture(options = {}) {
  const root = mkdtempSync(join(tmpdir(), "pitcrew-trusted-publisher-"));
  const source = join(root, "source.git"),
    candidate = join(root, "candidate"),
    artifact = join(root, "artifact.git");
  mkdirSync(candidate);
  git(candidate, "init", "--initial-branch=main");
  writeFileSync(join(candidate, "base.txt"), "base\n");
  git(candidate, "add", "base.txt");
  git(candidate, "commit", "-m", "base");
  const baseSha = git(candidate, "rev-parse", "HEAD");
  git(root, "clone", "--bare", candidate, source);
  git(root, "clone", "--bare", source, artifact);
  const marker = join(root, "candidate-code-executed");
  writeFileSync(
    join(candidate, ".gitconfig"),
    `[core]\n hooksPath=${join(candidate, ".git/hooks")}\n[credential]\n helper=!touch ${marker}\n`,
  );
  writeFileSync(join(candidate, "run-me.sh"), `#!/bin/sh\ntouch '${marker}'\n`);
  writeFileSync(join(candidate, ".git/hooks/pre-push"), `#!/bin/sh\ntouch '${marker}'\n`, {
    mode: 0o755,
  });
  git(candidate, "config", "core.hooksPath", join(candidate, ".git/hooks"));
  git(candidate, "config", "credential.helper", `!touch '${marker}'`);
  writeFileSync(join(candidate, "candidate.txt"), "candidate\n");
  git(candidate, "add", ".");
  git(candidate, "commit", "-m", "candidate");
  const candidateSha = git(candidate, "rev-parse", "HEAD");
  const bundle = join(root, "candidate.bundle");
  git(candidate, "bundle", "create", "--version=2", bundle, "HEAD");
  const bundleBase64 = readFileSync(bundle).toString("base64");
  const sourceRemote = "https://fixture.artifacts.cloudflare.net/git/pitcrew/source.git";
  const artifactRemote = "https://fixture.artifacts.cloudflare.net/git/pitcrew/pc-fork.git";
  const journal = new MemoryPublisherJournal();
  const calls = [],
    tokens = [],
    revoked = [],
    execs = [];
  const repo = (kind) => ({
    [Symbol.dispose]() {},
    async info() {
      calls.push("info:" + kind);
      return {
        name: kind === "source" ? "source" : "pc-fork",
        id: kind + "-immutable-id",
        remote: kind === "source" ? sourceRemote : artifactRemote,
        defaultBranch: "main",
        readOnly: false,
        source: kind === "source" ? null : "artifacts:pitcrew/source",
        ...options[`${kind}Info`],
      };
    },
    async readCommit(sha) {
      calls.push("commit:" + sha);
      try {
        return { hash: git(kind === "source" ? source : artifact, "rev-parse", sha + "^{commit}") };
      } catch {
        return null;
      }
    },
    async log({ ref }) {
      if (options.log) return options.log(kind, ref, { source, artifact, git });
      try {
        return [{ hash: git(kind === "source" ? source : artifact, "rev-parse", "--verify", ref) }];
      } catch {
        return [];
      }
    },
    async createToken(scope, ttl) {
      calls.push("token:" + kind);
      tokens.push({ kind, scope, ttl });
      if (options.token) return options.token(kind, scope, ttl);
      return {
        id: "fake-lease",
        plaintext: "fixture-not-a-real-token",
        scope,
        expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
      };
    },
    async revokeToken(id) {
      revoked.push(id);
      return options.revoke !== false;
    },
  });
  const container = {
    running: false,
    image: "",
    start(input) {
      calls.push("start");
      this.running = true;
      this.image = input.image;
      this.startInput = input;
    },
    async inspect() {
      if (options.inspectFailure) throw Error("inspect unavailable");
      return this.running ? { image: this.image, labels: {} } : null;
    },
    async destroy() {
      calls.push("destroy");
      if (options.destroyFailure) throw Error("cleanup unavailable");
      this.running = false;
    },
    async exec(argv, config) {
      execs.push({ argv, config });
      calls.push("git:" + argv[argv.indexOf("protocol.https.allow=always") + 13]);
      if (options.exec) {
        const intercept = options.exec(argv, config, { source, artifact, candidate, git, journal });
        if (intercept) return intercept;
      }
      // This test-only native adapter executes real local Git in an isolated temp
      // directory. Production argv stay fixed and HTTPS-only; local remotes replace
      // them here to test object verification and receive-pack old-ref comparison.
      const args = argv.slice(3); // GNU timeout is emulated by the host test deadline.
      const actual = args
        .slice(1)
        .map((arg) =>
          arg === "/publisher"
            ? join(root, "publisher")
            : arg === "protocol.file.allow=never"
              ? "protocol.file.allow=always"
              : arg === sourceRemote
                ? source
                : arg === artifactRemote
                  ? artifact
                  : arg,
        );
      const cwd = config.cwd === "/publisher" ? join(root, "publisher") : root;
      const child = spawn("git", actual, {
        cwd,
        env: { ...config.env, PATH: process.env.PATH },
        stdio: ["pipe", "pipe", "pipe"],
      });
      if (config.stdin) {
        const reader = config.stdin.getReader();
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            child.stdin.write(chunk.value);
          }
        } finally {
          reader.releaseLock();
          child.stdin.end();
        }
      } else child.stdin.end();
      const exitCode = new Promise((resolve, reject) => {
        child.on("close", resolve);
        child.on("error", reject);
      });
      return {
        stdout: Readable.toWeb(child.stdout),
        stderr: Readable.toWeb(child.stderr),
        exitCode,
      };
    },
  };
  const input = {
    kind: "publish",
    operationId: "publish-one",
    runId: "run-one",
    repositoryAgentName: "pitcrew",
    admissionFingerprint: "frozen-admission",
    artifactId: "pc-fork",
    artifactRepositoryId: "artifact-immutable-id",
    artifactRemote,
    sourceId: "source",
    sourceRepositoryId: "source-immutable-id",
    sourceRemote,
    baseSha,
    candidateSha,
    configurationRevision: "revision",
    deadline: Date.now() + 120_000,
    bundleBase64,
    bundleDigest: await publisherBundleDigest(bundleBase64),
  };
  input.authorization = await signPublisherAuthorization(input, FAKE_SECRET);
  const artifacts = {
    async get(name) {
      return repo(name === "source" ? "source" : "artifact");
    },
  };
  const admitted = options.admitted ?? (async () => {});
  const publisher = new NativeTrustedPublisher(
    artifacts,
    container,
    PINNED_IMAGE,
    journal,
    admitted,
    options.now,
  );
  return {
    root,
    source,
    artifact,
    candidate,
    baseSha,
    candidateSha,
    bundleBase64,
    marker,
    input,
    artifacts,
    container,
    journal,
    tokens,
    revoked,
    calls,
    execs,
    publisher,
    close() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}
