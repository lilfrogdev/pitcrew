import type { ArtifactsBinding, NativeContainer } from "./cloudflare.ts";
import type { LandingAuthorization } from "./landing.ts";
import type {
  LandingGitAccess,
  TrustedGitSession,
  TrustedGitSessionFactory,
} from "./landing-git.ts";
import { ExecutionError } from "./contracts.ts";

function artifactRemote(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.port ||
    !/^[a-zA-Z0-9-]+\.artifacts\.cloudflare\.net$/.test(url.hostname) ||
    !/^\/git\/[^/]+\/[^/]+\.git$/.test(url.pathname)
  )
    throw new ExecutionError("INVALID_ARTIFACT_REMOTE");
  return value;
}

// Source-only cloud adapter, deliberately not wired to a Worker route. Artifacts
// documents receive-pack v1, but its old-ref comparison semantics require a separately
// authorized conformance run before this can become a configured landing backend.
export class NativeTrustedGitSessionFactory implements TrustedGitSessionFactory {
  constructor(
    private readonly artifacts: ArtifactsBinding,
    private readonly resolveTrustedContainer: (id: string) => NativeContainer,
    private readonly registeredImage: string,
  ) {}

  async open(authorization: LandingAuthorization): Promise<TrustedGitSession> {
    using target = await this.artifacts.get(authorization.repository);
    using candidate = await this.artifacts.get(authorization.artifactId);
    const targetRemote = artifactRemote((await target.info()).remote);
    const candidateRemote = artifactRemote((await candidate.info()).remote);
    const container = this.resolveTrustedContainer(`landing-git-${crypto.randomUUID()}`);
    // A unique instance with a trusted image, no checkout, scripts, task mounts or
    // test execution. Canonical credentials never enter a ChangeWorker sandbox.
    container.start({
      image: this.registeredImage,
      entrypoint: ["sleep", "infinity"],
      enableInternet: true,
    });
    const run = async (
      argv: string[],
      access: LandingGitAccess,
    ): Promise<{ exitCode: number; stdout: string }> => {
      using repo =
        access === "none"
          ? undefined
          : await this.artifacts.get(
              access === "candidate-read" ? authorization.artifactId : authorization.repository,
            );
      const scope = access === "target-write" ? "write" : "read";
      const lease = repo ? await repo.createToken(scope, 300) : undefined;
      try {
        if (
          lease &&
          (lease.scope !== scope ||
            !Number.isFinite(Date.parse(lease.expiresAt)) ||
            Date.parse(lease.expiresAt) <= Date.now() ||
            Date.parse(lease.expiresAt) > Date.now() + 301_000)
        )
          throw new ExecutionError("INVALID_TOKEN_LEASE");
        const env: Record<string, string> = {
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_TERMINAL_PROMPT: "0",
        };
        if (lease)
          Object.assign(env, {
            GIT_CONFIG_COUNT: "1",
            GIT_CONFIG_KEY_0: "http.extraHeader",
            GIT_CONFIG_VALUE_0: `Authorization: Bearer ${lease.plaintext}`,
          });
        return await boundedGit(container, argv, env);
      } finally {
        await revokeTrustedLease(repo, lease?.id, container);
      }
    };
    try {
      if ((await run(["init", "--bare", "/landing"], "none")).exitCode !== 0)
        throw new ExecutionError("TRUSTED_GIT_INIT_FAILED");
    } catch {
      await container.destroy("landing initialization failed");
      throw new ExecutionError("TRUSTED_GIT_INIT_FAILED");
    }
    return {
      targetRemote,
      candidateRemote,
      run,
      close: () => container.destroy("trusted landing session closed"),
    };
  }
}

async function revokeTrustedLease(
  repo: Pick<ArtifactsRepo, "revokeToken"> | undefined,
  id: string | undefined,
  container: NativeContainer,
): Promise<void> {
  if (!repo || !id) return;
  let revoked = false;
  try {
    revoked = await repo.revokeToken(id);
  } catch {
    /* fail closed below */
  }
  if (!revoked) {
    await container.destroy("landing lease revocation failed");
    throw new ExecutionError("TOKEN_REVOCATION_FAILED");
  }
}

async function boundedGit(
  container: NativeContainer,
  argv: string[],
  env: Record<string, string>,
): Promise<{ exitCode: number; stdout: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      void container.destroy("trusted git timeout").then(
        () => reject(new ExecutionError("TRUSTED_GIT_TIMEOUT")),
        () => reject(new ExecutionError("TRUSTED_GIT_TIMEOUT")),
      );
    }, 30_000);
  });
  try {
    const operation = (async () => {
      const process = await container.exec(
        [
          "git",
          "--no-replace-objects",
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "credential.helper=",
          "-c",
          "protocol.version=1",
          ...argv,
        ],
        { cwd: argv[0] === "init" ? "/" : "/landing", env, stdout: "pipe", stderr: "pipe" },
      );
      let total = 0;
      const read = async (stream: ReadableStream | null, keep: boolean): Promise<string> => {
        if (!stream) return "";
        const reader = stream.getReader();
        const decoder = new TextDecoder();
        let text = "";
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            const data = new Uint8Array(chunk.value);
            total += data.byteLength;
            if (total > 65_536) throw new ExecutionError("TRUSTED_GIT_OUTPUT_LIMIT");
            if (keep) text += decoder.decode(data, { stream: true });
          }
          return text + (keep ? decoder.decode() : "");
        } finally {
          reader.releaseLock();
        }
      };
      const [exitCode, stdout] = await Promise.all([
        process.exitCode,
        read(process.stdout, true),
        read(process.stderr, false),
      ]);
      // Never emit raw authentication diagnostics or canonical token strings.
      if (
        env.GIT_CONFIG_VALUE_0 &&
        stdout.includes(env.GIT_CONFIG_VALUE_0.slice("Authorization: Bearer ".length))
      )
        throw new ExecutionError("TRUSTED_GIT_OUTPUT_REJECTED");
      return { exitCode, stdout };
    })();
    return await Promise.race([operation, deadline]);
  } catch {
    await container.destroy("trusted git failed");
    throw new ExecutionError("TRUSTED_GIT_FAILED");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
