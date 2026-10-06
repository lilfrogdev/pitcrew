import { assertSha, ExecutionError } from "./contracts.ts";
import type { Command, CommandResult, Workspace } from "./contracts.ts";
import type { ArtifactsBinding } from "./cloudflare.ts";
import { assertTargetRef } from "./landing-git.ts";

export const MAX_PUBLISHER_BUNDLE_BYTES = 750 * 1024;
export const MAX_PUBLISHER_LIFETIME_MS = 120_000;
export type PublisherContainer = Pick<Container, "start" | "exec" | "destroy" | "inspect" | "running">;

export interface PublisherInput {
  operationId: string;
  runId: string;
  repositoryAgentName: string;
  admissionFingerprint: string;
  artifactId: string;
  artifactRepositoryId: string;
  artifactRemote: string;
  sourceId: string;
  sourceRepositoryId: string;
  sourceRemote: string;
  baseSha: string;
  candidateSha: string;
  configurationRevision: string;
  deadline: number;
  bundleBase64: string;
  bundleDigest: string;
  authorization: string;
}
export interface PublisherLandingInput extends PublisherInput {
  authorizationId: string;
  targetRef: string;
  expectedTargetSha: string;
}
export type PublisherRequest =
  | (PublisherInput & { kind: "publish" })
  | (PublisherLandingInput & { kind: "land" });
export interface PublisherResult {
  status: "published" | "landed" | "rejected" | "uncertain";
  fingerprint: string;
  cleanupVerified: boolean;
  code?: string;
  bundleReference?: string;
}
export interface PublisherRecord {
  fingerprint: string;
  input: PublisherIdentity;
  state: "pending" | "complete";
  cancelled: boolean;
  containerOwned: boolean;
  lease?: { repository: string; id?: string; state: "creating" | "active" | "revoked" | "uncertain" };
  writeAttempted: boolean;
  result?: PublisherResult;
}
export type PublisherIdentity =
  | Omit<PublisherInput & { kind: "publish" }, "bundleBase64">
  | Omit<PublisherLandingInput & { kind: "land" }, "bundleBase64">;
// claim/update/cancel must be SQLite transactions in the separate publisher DO.
export interface PublisherJournal {
  claim(id: string, record: PublisherRecord): Promise<{ claimed: boolean; record: PublisherRecord }>;
  read(id: string): Promise<PublisherRecord | undefined>;
  update(id: string, fingerprint: string, patch: Partial<PublisherRecord>): Promise<void>;
}
export type PublisherAdmission = (input: Readonly<PublisherRecord["input"]>) => Promise<void>;

export function publisherRemote(remote: string): string {
  let url: URL;
  try { url = new URL(remote); } catch { throw new ExecutionError("INVALID_ARTIFACT_REMOTE"); }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash ||
      !/^[a-zA-Z0-9-]+\.artifacts\.cloudflare\.net$/.test(url.hostname) ||
      !/^\/git\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+\.git$/.test(url.pathname) || url.href !== remote)
    throw new ExecutionError("INVALID_ARTIFACT_REMOTE");
  return remote;
}

function bundleBytes(encoded: string, candidateSha: string): Uint8Array {
  if (typeof encoded !== "string" || encoded.length > Math.ceil(MAX_PUBLISHER_BUNDLE_BYTES / 3) * 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))
    throw new ExecutionError("INVALID_BUNDLE");
  const binary = atob(encoded);
  if (!binary.length || binary.length > MAX_PUBLISHER_BUNDLE_BYTES || btoa(binary) !== encoded)
    throw new ExecutionError("INVALID_BUNDLE");
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  const header = new TextEncoder().encode(`# v2 git bundle\n${candidateSha} HEAD\n\n`);
  if (header.some((byte, i) => bytes[i] !== byte) ||
      new TextDecoder().decode(bytes.subarray(header.length, header.length + 4)) !== "PACK")
    throw new ExecutionError("BUNDLE_IDENTITY_MISMATCH");
  return bytes.subarray(header.length);
}

function validate(input: PublisherRequest, now: number): Uint8Array {
  assertSha(input.baseSha); assertSha(input.candidateSha);
  for (const key of ["operationId", "runId", "repositoryAgentName", "admissionFingerprint", "artifactId",
    "artifactRepositoryId", "sourceId", "sourceRepositoryId", "configurationRevision"] as const) {
    if (typeof input[key] !== "string" || !/^[A-Za-z0-9_.:-]{1,200}$/.test(input[key]))
      throw new ExecutionError("INVALID_PUBLISHER_IDENTITY");
  }
  if (input.artifactId === input.sourceId || input.artifactRepositoryId === input.sourceRepositoryId ||
      input.artifactRemote === input.sourceRemote) throw new ExecutionError("DESTINATION_CONFLICT");
  publisherRemote(input.artifactRemote); publisherRemote(input.sourceRemote);
  if (!Number.isSafeInteger(input.deadline) || input.deadline <= now ||
      input.deadline > now + MAX_PUBLISHER_LIFETIME_MS) throw new ExecutionError("PUBLISHER_EXPIRED");
  if (input.kind === "land") {
    assertTargetRef(input.targetRef); assertSha(input.expectedTargetSha);
    if (input.expectedTargetSha !== input.baseSha || !/^[A-Za-z0-9_.:-]{1,200}$/.test(input.authorizationId))
      throw new ExecutionError("LANDING_IDENTITY_MISMATCH");
  }
  if (!/^[a-f0-9]{64}$/.test(input.bundleDigest) || !/^[A-Za-z0-9_-]{43}$/.test(input.authorization))
    throw new ExecutionError("INVALID_PUBLISHER_AUTHORIZATION");
  return bundleBytes(input.bundleBase64, input.candidateSha);
}

export async function publisherBundleDigest(encoded: string): Promise<string> {
  if (typeof encoded !== "string" || encoded.length > Math.ceil(MAX_PUBLISHER_BUNDLE_BYTES / 3) * 4)
    throw new ExecutionError("INVALID_BUNDLE");
  let binary: string;
  try { binary = atob(encoded); } catch { throw new ExecutionError("INVALID_BUNDLE"); }
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",
    Uint8Array.from(binary, (char) => char.charCodeAt(0)))), (n) => n.toString(16).padStart(2, "0")).join("");
}

function authorizationPayload(input: Omit<PublisherRequest, "bundleBase64" | "authorization">): string {
  const landing = input as Partial<PublisherLandingInput>;
  return JSON.stringify([input.kind, input.operationId, input.runId, input.repositoryAgentName,
    input.admissionFingerprint, input.artifactId, input.artifactRepositoryId, input.artifactRemote,
    input.sourceId, input.sourceRepositoryId, input.sourceRemote, input.baseSha, input.candidateSha,
    input.configurationRevision, input.deadline, input.bundleDigest,
    input.kind === "land" ? landing.authorizationId : null,
    input.kind === "land" ? landing.targetRef : null,
    input.kind === "land" ? landing.expectedTargetSha : null]);
}
async function authorizationKey(secret: string): Promise<CryptoKey> {
  if (!secret || new TextEncoder().encode(secret).byteLength < 32)
    throw new ExecutionError("PUBLISHER_AUTH_KEY_REQUIRED");
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
export async function signPublisherAuthorization(
  input: Omit<PublisherRequest, "bundleBase64" | "authorization">, secret: string): Promise<string> {
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", await authorizationKey(secret),
    new TextEncoder().encode(authorizationPayload(input))));
  return btoa(String.fromCharCode(...signature)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export async function verifyPublisherAuthorization(input: PublisherRequest, secret: string): Promise<void> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(input.authorization)) throw new ExecutionError("PUBLISHER_UNAUTHORIZED");
  const bytes = Uint8Array.from(atob(input.authorization.replace(/-/g, "+").replace(/_/g, "/") + "="),
    (char) => char.charCodeAt(0));
  if (!await crypto.subtle.verify("HMAC", await authorizationKey(secret), bytes,
    new TextEncoder().encode(authorizationPayload(input)))) throw new ExecutionError("PUBLISHER_UNAUTHORIZED");
}

export async function publisherFingerprint(input: PublisherRequest): Promise<string> {
  // Fixed field ordering avoids caller property-order changes, and includes inert payload bytes.
  const values = [input.kind, input.operationId, input.runId, input.repositoryAgentName,
    input.admissionFingerprint, input.artifactId, input.artifactRepositoryId, input.artifactRemote,
    input.sourceId, input.sourceRepositoryId, input.sourceRemote, input.baseSha, input.candidateSha,
    input.configurationRevision, input.deadline, input.bundleBase64, input.bundleDigest, input.authorization,
    input.kind === "land" ? input.authorizationId : null,
    input.kind === "land" ? input.targetRef : null,
    input.kind === "land" ? input.expectedTargetSha : null];
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",
    new TextEncoder().encode(JSON.stringify(values)))), (n) => n.toString(16).padStart(2, "0")).join("");
}

const GIT_ENV = Object.freeze({
  PATH: "/usr/bin:/bin", HOME: "/nonexistent", LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0",
  GIT_NO_REPLACE_OBJECTS: "1", GIT_ATTR_NOSYSTEM: "1",
});
const GIT_PREFIX = ["git", "--no-replace-objects", "-c", "core.hooksPath=/dev/null",
  "-c", "credential.helper=", "-c", "core.attributesFile=/dev/null", "-c", "core.useReplaceRefs=false",
  "-c", "http.followRedirects=false", "-c", "protocol.allow=never", "-c", "protocol.https.allow=always",
  "-c", "protocol.file.allow=never", "-c", "protocol.ext.allow=never", "-c", "protocol.version=1",
  "-c", "fetch.fsckObjects=true", "-c", "transfer.fsckObjects=true"];

export class NativeTrustedPublisher {
  constructor(private readonly artifacts: ArtifactsBinding, private readonly container: PublisherContainer,
    private readonly image: string, private readonly journal: PublisherJournal,
    private readonly admitted: PublisherAdmission, private readonly now = () => Date.now()) {
  }

  async execute(raw: PublisherRequest): Promise<PublisherResult> {
    // Snapshot synchronously before any await or effects. The task cannot mutate this snapshot.
    const input = structuredClone(raw);
    if (!/^[A-Za-z0-9./:_-]+@sha256:[a-f0-9]{64}$/.test(this.image))
      throw new ExecutionError("PINNED_PUBLISHER_IMAGE_REQUIRED");
    const pack = validate(input, this.now());
    if (await publisherBundleDigest(input.bundleBase64) !== input.bundleDigest)
      throw new ExecutionError("BUNDLE_DIGEST_MISMATCH");
    const fingerprint = await publisherFingerprint(input);
    const { bundleBase64: _bundle, ...identity } = input;
    const claimed = await this.journal.claim(input.operationId, { fingerprint, input: identity,
      state: "pending", cancelled: false, containerOwned: false, writeAttempted: false });
    if (claimed.record.fingerprint !== fingerprint) throw new ExecutionError("PUBLISHER_REPLAY_CONFLICT");
    if (!claimed.claimed) return claimed.record.result ?? { status: "uncertain", fingerprint,
      cleanupVerified: false, code: "PUBLISHER_PENDING_RECONCILIATION" };
    let writeAttempted = false;
    let result: PublisherResult = { status: "rejected", fingerprint, cleanupVerified: false };
    let lease: { repo: ArtifactsRepo; token: ArtifactsCreateTokenResult } | undefined;
    const repos: ArtifactsRepo[] = [];
    const fence = async () => {
      if (this.now() >= input.deadline) throw new ExecutionError("PUBLISHER_EXPIRED");
      const record = await this.journal.read(input.operationId);
      if (!record || record.fingerprint !== fingerprint || record.cancelled)
        throw new ExecutionError("PUBLISHER_CANCELLED");
      await this.admitted(identity);
      if (this.now() >= input.deadline) throw new ExecutionError("PUBLISHER_EXPIRED");
    };
    const stage = async <T>(operation: () => Promise<T>): Promise<T> => {
      await fence();
      const value = await this.bounded(operation(), input.deadline);
      await fence();
      return value;
    };
    const git = async (argv: string[], token?: string, remote?: string, stdin?: Uint8Array) =>
      stage(() => this.git(argv, input.deadline, token, remote, stdin));
    try {
      await fence();
      const artifact = await stage(() => this.artifacts.get(input.artifactId)); repos.push(artifact);
      const source = await stage(() => this.artifacts.get(input.sourceId)); repos.push(source);
      const artifactInfo = await stage(() => artifact.info());
      const sourceInfo = await stage(() => source.info());
      this.destination(artifactInfo, input.artifactId, input.artifactRepositoryId, input.artifactRemote);
      this.destination(sourceInfo, input.sourceId, input.sourceRepositoryId, input.sourceRemote);
      const sourceUrl = new URL(input.sourceRemote), artifactUrl = new URL(input.artifactRemote);
      const namespace = sourceUrl.pathname.split("/")[2];
      if (sourceInfo.defaultBranch !== "main" || artifactInfo.source !== `artifacts:${namespace}/${input.sourceId}` ||
          sourceUrl.origin !== artifactUrl.origin || namespace !== artifactUrl.pathname.split("/")[2] ||
          (input.kind === "land" && input.targetRef !== "refs/heads/main"))
        throw new ExecutionError("FORK_SOURCE_IDENTITY_MISMATCH");
      // Independent canonical base existence is checked without a credential.
      if (!(await stage(() => source.readCommit(input.baseSha)))) throw new ExecutionError("BASE_UNAVAILABLE");
      await stage(() => this.journal.update(input.operationId, fingerprint, { containerOwned: true }));
      if (this.container.running || await stage(() => this.container.inspect()))
        throw new ExecutionError("PUBLISHER_NOT_FRESH");
      await fence();
      this.container.start({ image: this.image, entrypoint: ["/bin/sleep", "120"],
        instance: "lite", enableInternet: true });
      if ((await git(["init", "--bare", "--object-format=sha1", "--template=/dev/null", "/publisher"])).exitCode !== 0)
        throw new ExecutionError("PUBLISHER_INIT_FAILED");
      const running = await stage(() => this.container.inspect());
      if (!running || running.image !== this.image) throw new ExecutionError("PUBLISHER_IMAGE_MISMATCH");
      if ((await git(["index-pack", "--strict", "--stdin"], undefined, undefined, pack)).exitCode !== 0)
        throw new ExecutionError("INVALID_GIT_OBJECTS");
      for (const sha of [input.baseSha, input.candidateSha]) {
        const type = await git(["cat-file", "-t", sha]);
        if (type.exitCode !== 0 || type.stdout !== "commit\n") throw new ExecutionError("COMMIT_IDENTITY_MISMATCH");
      }
      if ((await git(["fsck", "--strict", "--full", "--no-reflogs", input.candidateSha])).exitCode !== 0)
        throw new ExecutionError("INVALID_GIT_OBJECTS");
      if ((await git(["merge-base", "--is-ancestor", input.baseSha, input.candidateSha])).exitCode !== 0)
        throw new ExecutionError("NON_FAST_FORWARD");
      if (input.candidateSha === input.baseSha) throw new ExecutionError("NO_CHANGE");
      const target = input.kind === "publish" ? artifact : source;
      const repository = input.kind === "publish" ? input.artifactId : input.sourceId;
      const remote = input.kind === "publish" ? input.artifactRemote : input.sourceRemote;
      const targetRef = input.kind === "publish" ? "refs/heads/candidate" : input.targetRef;
      // Current head is read without issuing credentials through the Artifacts binding.
      const heads = await stage(() => target.log({ ref: targetRef, limit: 1 }));
      const expected = input.kind === "publish" ? (heads[0]?.hash ?? "") : input.expectedTargetSha;
      if (input.kind === "land" && heads[0]?.hash !== expected) throw new ExecutionError("STALE_TARGET");
      if (expected === input.candidateSha) throw new ExecutionError("ALREADY_PRESENT_REQUIRES_RECONCILIATION");
      if (expected && (await git(["merge-base", "--is-ancestor", expected, input.candidateSha])).exitCode !== 0)
        throw new ExecutionError("NON_FAST_FORWARD");
      // Tokens become possible only after strict inert-data and exact-destination validation.
      await stage(() => this.journal.update(input.operationId, fingerprint,
        { lease: { repository, state: "creating" } }));
      const tokenPromise = target.createToken("write", 60);
      let acceptingToken = true;
      void tokenPromise.then(async (token) => {
        if (acceptingToken) return;
        // A timed-out issuance may finish later. Revoke it, retain uncertainty until observed.
        try {
          await this.journal.update(input.operationId, fingerprint, { lease: { repository, id: token.id, state: "active" } });
          using lateRepo = await this.bounded(this.artifacts.get(repository), this.now() + 5000);
          const revoked = await this.bounded(lateRepo.revokeToken(token.id), this.now() + 5000);
          await this.journal.update(input.operationId, fingerprint, { lease: { repository, id: token.id,
            state: revoked ? "revoked" : "uncertain" } });
        } catch { /* Keep the durable unknown lease and its reservation for recovery. */ }
      }, () => undefined);
      let token: ArtifactsCreateTokenResult;
      try { token = await this.bounded(tokenPromise, input.deadline); }
      catch (error) { acceptingToken = false; throw error; }
      lease = { repo: target, token };
      await this.journal.update(input.operationId, fingerprint,
        { lease: { repository, id: token.id, state: "active" } });
      await fence();
      if (token.scope !== "write" || !token.id || !token.plaintext ||
          !Number.isFinite(Date.parse(token.expiresAt)) || Date.parse(token.expiresAt) <= this.now() ||
          Date.parse(token.expiresAt) > this.now() + 61_000) throw new ExecutionError("INVALID_TOKEN_LEASE");
      await stage(() => this.journal.update(input.operationId, fingerprint, { writeAttempted: true }));
      writeAttempted = true;
      const push = await git(["push", "--porcelain", "--no-verify", "--no-signed", "--no-recurse-submodules",
        `--force-with-lease=${targetRef}:${expected}`, "--", remote, `${input.candidateSha}:${targetRef}`],
        token.plaintext, remote);
      const updates = push.stdout.split("\n").filter((line) => /^[ =!*+-]\t/.test(line));
      const flag = expected ? " " : "*";
      if (push.exitCode !== 0 || updates.length !== 1 || !updates[0].startsWith(`${flag}\t`) ||
          updates[0].split("\t")[1] !== `${input.candidateSha}:${targetRef}`)
        throw new ExecutionError("RECONCILIATION_REQUIRED");
      const confirmed = await stage(() => target.log({ ref: targetRef, limit: 1 }));
      if (confirmed[0]?.hash !== input.candidateSha) throw new ExecutionError("RECONCILIATION_REQUIRED");
      result.status = input.kind === "publish" ? "published" : "landed";
      if (input.kind === "publish") result.bundleReference = input.operationId;
    } catch (error) {
      result = { status: writeAttempted ? "uncertain" : "rejected", fingerprint, cleanupVerified: false,
        code: error instanceof ExecutionError ? error.code : "PUBLISHER_FAILED" };
    } finally {
      let revoked = true;
      if (lease) {
        try { revoked = await this.bounded(lease.repo.revokeToken(lease.token.id), this.now() + 5000); }
        catch { revoked = false; }
        await this.journal.update(input.operationId, fingerprint, { lease: { repository:
          input.kind === "publish" ? input.artifactId : input.sourceId, id: lease.token.id,
          state: revoked ? "revoked" : "uncertain" } });
      }
      const owned = await this.journal.read(input.operationId);
      const stopped = await this.cleanupContainer();
      result.cleanupVerified = revoked && stopped && owned?.lease?.state !== "creating";
      if (!result.cleanupVerified) { result.status = "uncertain"; result.code = "PUBLISHER_CLEANUP_UNVERIFIED"; }
      await this.journal.update(input.operationId, fingerprint, { state: "complete", result,
        containerOwned: !stopped });
      for (const repo of repos) repo[Symbol.dispose]();
    }
    return result;
  }

  async cleanup(operationId: string): Promise<boolean> {
    const record = await this.journal.read(operationId);
    if (!record) return !this.container.running;
    await this.journal.update(operationId, record.fingerprint, { cancelled: true });
    let revoked = !record.lease || record.lease.state === "revoked";
    if (!revoked && record.lease?.id) {
      try {
        using repo = await this.bounded(this.artifacts.get(record.lease.repository), this.now() + 5000);
        revoked = await this.bounded(repo.revokeToken(record.lease.id), this.now() + 5000);
      } catch { revoked = false; }
    }
    const stopped = await this.cleanupContainer();
    await this.journal.update(operationId, record.fingerprint, { containerOwned: !stopped,
      ...(record.lease ? { lease: { ...record.lease, state: revoked ? "revoked" : "uncertain" } } : {}) });
    return revoked && stopped;
  }

  private destination(info: ArtifactsRepoInfo, name: string, id: string, remote: string): void {
    if (info.id !== id || info.name !== name || publisherRemote(info.remote) !== remote || info.readOnly)
      throw new ExecutionError("DESTINATION_IDENTITY_MISMATCH");
  }
  private async cleanupContainer(): Promise<boolean> {
    try {
      await this.bounded(this.container.destroy("trusted publisher cleanup"), this.now() + 5000);
      return await this.bounded(this.container.inspect(), this.now() + 5000) === null && !this.container.running;
    } catch { return false; }
  }
  private async bounded<T>(promise: Promise<T>, deadline: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ExecutionError("PUBLISHER_TIMEOUT")),
        Math.max(1, Math.min(30_000, deadline - this.now())));
    });
    try { return await Promise.race([promise, timeout]); }
    finally { if (timer !== undefined) clearTimeout(timer); }
  }
  private async git(argv: string[], deadline: number, token?: string, remote?: string, input?: Uint8Array)
    : Promise<{ exitCode: number; stdout: string }> {
    const env: Record<string, string> = { ...GIT_ENV };
    if (token) Object.assign(env, { GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: `http.${remote}.extraHeader`, GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}` });
    const stdin = input ? new ReadableStream({ start(controller) {
      controller.enqueue(input); controller.close();
    } }) : undefined;
    const process = await this.bounded(this.container.exec([
      "/usr/bin/timeout", "--kill-after=1", `${Math.max(1, Math.min(30, (deadline - this.now()) / 1000))}s`,
      ...GIT_PREFIX, ...argv], { cwd: argv[0] === "init" ? "/" : "/publisher", env, stdin,
      stdout: "pipe", stderr: "pipe" }), deadline);
    let bytes = 0;
    const read = async (stream: ReadableStream | null, keep: boolean) => {
      if (!stream) return "";
      const reader = stream.getReader(); let text = ""; const decoder = new TextDecoder();
      try {
        while (true) {
          const chunk = await this.bounded(reader.read(), deadline);
          if (chunk.done) break;
          const data = new Uint8Array(chunk.value); bytes += data.byteLength;
          if (bytes > 65_536) throw new ExecutionError("PUBLISHER_OUTPUT_LIMIT");
          if (keep) text += decoder.decode(data, { stream: true });
        }
        return text + (keep ? decoder.decode() : "");
      } finally { reader.releaseLock(); }
    };
    const [exitCode, stdout] = await this.bounded(Promise.all([
      process.exitCode, read(process.stdout, true), read(process.stderr, false)]), deadline);
    if (token && stdout.includes(token)) throw new ExecutionError("PUBLISHER_OUTPUT_REJECTED");
    if (exitCode === 124 || exitCode === 137) throw new ExecutionError("PUBLISHER_TIMEOUT");
    return { exitCode, stdout };
  }
}

export type CandidateCommandPort = (workspace: Workspace, command: Command) => Promise<CommandResult>;
export async function exportCandidateBundle(workspace: Workspace, candidateSha: string,
  run: CandidateCommandPort, fence: () => Promise<void>): Promise<string> {
  assertSha(candidateSha);
  await fence();
  // Runs only in the untrusted candidate container, never with publication credentials.
  // Any substituted executable/config/output is untrusted; the receiver verifies every object.
  const script = "import base64,os,subprocess,tempfile,sys; " +
    "p=tempfile.mktemp(prefix='pitcrew-bundle-',dir='/tmp'); " +
    "r=subprocess.run(['/usr/bin/git','--no-replace-objects','-c','core.hooksPath=/dev/null'," +
    "'bundle','create','--version=2',p,'HEAD'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); " +
    "assert r.returncode==0; assert os.stat(p).st_size<=" + MAX_PUBLISHER_BUNDLE_BYTES + "; " +
    "sys.stdout.write(base64.b64encode(open(p,'rb').read()).decode()); os.unlink(p)";
  const result = await run(workspace, { commandId: "export-publisher-bundle",
    argv: ["python3", "-I", "-c", script], timeoutMs: 30_000,
    maxOutputBytes: Math.ceil(MAX_PUBLISHER_BUNDLE_BYTES / 3) * 4 });
  await fence();
  if (result.status !== "completed" || result.exitCode !== 0 || result.truncated)
    throw new ExecutionError("BUNDLE_EXPORT_FAILED");
  bundleBytes(result.stdout, candidateSha);
  return result.stdout;
}
