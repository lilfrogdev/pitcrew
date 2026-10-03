import { ExecutionError, assertCommand, assertSha } from "./contracts.ts";
import type {
  Command,
  CommandResult,
  ForkTransport,
  Workspace,
  WorkspaceTransport,
} from "./contracts.ts";

// These are projections of current generated Workers types, not invented SDK methods.
// https://developers.cloudflare.com/artifacts/api/workers-binding/
// https://developers.cloudflare.com/containers/api/durable-object-container/
export type ArtifactsBinding = Pick<Artifacts, "get">;
export type NativeContainer = Pick<Container, "start" | "exec" | "destroy">;
export type ContainerResolver = (workerId: string) => NativeContainer;

export class CloudflareArtifacts implements ForkTransport {
  constructor(private readonly binding: ArtifactsBinding) {}

  async fork(source: string, target: string, baseSha: string): Promise<void> {
    assertSha(baseSha);
    using repo = await this.binding.get(source);
    const info = await repo.info();
    const [head] = await repo.log({ ref: info.defaultBranch, limit: 1 });
    if (head?.hash !== baseSha) throw new ExecutionError("STALE_BASE");
    const created = await repo.fork(target, { defaultBranchOnly: true, readOnly: false });
    using fork = await this.binding.get(created.name);
    // The creation token may have the platform's default long TTL: revoke it immediately.
    if (!(await fork.revokeToken(created.token)))
      throw new ExecutionError("TOKEN_REVOCATION_FAILED");
    if (!(await fork.readCommit(baseSha))) throw new ExecutionError("BASE_UNAVAILABLE");
  }
}

function safeRemote(remote: string): string {
  const url = new URL(remote);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^[a-zA-Z0-9-]+\.artifacts\.cloudflare\.net$/.test(url.hostname) ||
    !/^\/git\/[^/]+\/[^/]+\.git$/.test(url.pathname)
  )
    throw new ExecutionError("INVALID_ARTIFACT_REMOTE");
  return remote;
}

export class CloudflareSandbox implements WorkspaceTransport {
  constructor(
    private readonly binding: ArtifactsBinding,
    private readonly resolve: ContainerResolver,
    private readonly image: string,
  ) {
    if (!image) throw new ExecutionError("IMAGE_REQUIRED");
  }

  async prepare(workspace: Workspace): Promise<void> {
    using fork = await this.binding.get(workspace.artifactId);
    const info = await fork.info();
    const remote = safeRemote(info.remote);
    const token = await fork.createToken("read", 300);
    const container = this.resolve(workspace.workerId);
    try {
      this.assertLease(token, "read");
      // Internet is needed for Git/dependency installation. No account credential is supplied.
      container.start({
        image: this.image,
        entrypoint: ["sleep", "infinity"],
        enableInternet: true,
      });
      // Per-process environment avoids storing the short-lived token in .git/config or a URL.
      const env = {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "http.extraHeader",
        GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token.plaintext}`,
        GIT_TERMINAL_PROMPT: "0",
      };
      const clone = await this.execute(
        container,
        {
          commandId: "clone",
          argv: ["git", "clone", "--", remote, "/workspace"],
          timeoutMs: 60_000,
          maxOutputBytes: 16_384,
        },
        undefined,
        undefined,
        env,
      );
      if (clone.exitCode !== 0 || clone.status !== "completed")
        throw new ExecutionError("CLONE_FAILED");
      const checkout = await this.execute(
        container,
        {
          commandId: "checkout",
          argv: ["git", "checkout", "--detach", workspace.baseSha],
          timeoutMs: 10_000,
          maxOutputBytes: 16_384,
        },
        "/workspace",
      );
      if (checkout.exitCode !== 0 || checkout.status !== "completed")
        throw new ExecutionError("CHECKOUT_FAILED");
    } catch {
      await container.destroy("workspace preparation failed");
      throw new ExecutionError("WORKSPACE_PREPARATION_FAILED");
    } finally {
      // Revocation must succeed before any worker task is started.
      await this.revokeLease(fork, token.id, container);
    }
  }

  async run(workspace: Workspace, command: Command, signal?: AbortSignal): Promise<CommandResult> {
    assertCommand(command);
    try {
      return await this.execute(this.resolve(workspace.workerId), command, "/workspace", signal);
    } catch {
      throw new ExecutionError("COMMAND_FAILED");
    }
  }

  async inspect(workspace: Workspace): Promise<{ sha: string; clean: boolean }> {
    const container = this.resolve(workspace.workerId);
    const head = await this.execute(
      container,
      {
        commandId: "head",
        argv: ["git", "rev-parse", "HEAD"],
        timeoutMs: 5_000,
        maxOutputBytes: 128,
      },
      "/workspace",
    );
    const status = await this.execute(
      container,
      {
        commandId: "status",
        argv: ["git", "status", "--porcelain", "--untracked-files=all"],
        timeoutMs: 5_000,
        maxOutputBytes: 16_384,
      },
      "/workspace",
    );
    if (
      head.exitCode !== 0 ||
      status.exitCode !== 0 ||
      head.status !== "completed" ||
      status.status !== "completed"
    )
      throw new ExecutionError("INSPECTION_FAILED");
    const sha = head.stdout.trim();
    assertSha(sha);
    return { sha, clean: status.stdout === "" && !status.truncated };
  }

  async readFile(workspace: Workspace, path: string): Promise<string> {
    this.assertPath(path);
    const script =
      "import pathlib,sys; root=pathlib.Path('/workspace').resolve(); p=(root/sys.argv[1]).resolve(); " +
      "assert p.is_relative_to(root); assert p.stat().st_size<=65536; sys.stdout.write(p.read_text())";
    const result = await this.run(workspace, {
      commandId: "read-file",
      argv: ["python3", "-c", script, path],
      timeoutMs: 5_000,
      maxOutputBytes: 65_536,
    });
    if (result.exitCode !== 0 || result.status !== "completed")
      throw new ExecutionError("FILE_READ_FAILED");
    return result.stdout;
  }

  async writeFile(workspace: Workspace, path: string, content: string): Promise<void> {
    this.assertPath(path);
    if (new TextEncoder().encode(content).byteLength > 8192)
      throw new ExecutionError("FILE_TOO_LARGE");
    const script =
      "import pathlib,sys; root=pathlib.Path('/workspace').resolve(); p=(root/sys.argv[1]).resolve(); " +
      "assert p.is_relative_to(root); p.parent.mkdir(parents=True,exist_ok=True); p.write_text(sys.argv[2])";
    const result = await this.run(workspace, {
      commandId: "write-file",
      argv: ["python3", "-c", script, path, content],
      timeoutMs: 5_000,
      maxOutputBytes: 4096,
    });
    if (result.exitCode !== 0 || result.status !== "completed")
      throw new ExecutionError("FILE_WRITE_FAILED");
  }

  private assertPath(path: string): void {
    if (
      !path ||
      path.startsWith("/") ||
      path.includes("\0") ||
      path.split("/").some((part) => part === ".." || part === ".git") ||
      path.length > 1024
    )
      throw new ExecutionError("INVALID_PATH");
  }

  async stop(workspace: Workspace): Promise<void> {
    try {
      await this.resolve(workspace.workerId).destroy("change stopped");
    } catch {
      throw new ExecutionError("STOP_FAILED");
    }
  }

  async publish(workspace: Workspace, candidateSha: string): Promise<void> {
    assertSha(candidateSha);
    using fork = await this.binding.get(workspace.artifactId);
    const remote = safeRemote((await fork.info()).remote);
    const token = await fork.createToken("write", 300);
    const container = this.resolve(workspace.workerId);
    try {
      this.assertLease(token, "write");
      const result = await this.execute(
        container,
        {
          commandId: "publish",
          argv: ["git", "push", "--", remote, `${candidateSha}:refs/heads/candidate`],
          timeoutMs: 60_000,
          maxOutputBytes: 16_384,
        },
        "/workspace",
        undefined,
        {
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "http.extraHeader",
          GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token.plaintext}`,
          GIT_TERMINAL_PROMPT: "0",
        },
      );
      if (
        result.exitCode !== 0 ||
        result.status !== "completed" ||
        !(await fork.readCommit(candidateSha))
      )
        throw new ExecutionError("PUBLISH_UNCERTAIN");
    } catch {
      throw new ExecutionError("PUBLISH_UNCERTAIN");
    } finally {
      await this.revokeLease(fork, token.id, container);
    }
  }

  private async revokeLease(
    fork: Pick<ArtifactsRepo, "revokeToken">,
    id: string,
    container: NativeContainer,
  ): Promise<void> {
    let revoked = false;
    try {
      revoked = await fork.revokeToken(id);
    } catch {
      /* fail closed below */
    }
    if (!revoked) {
      await container.destroy("token revocation failed");
      throw new ExecutionError("TOKEN_REVOCATION_FAILED");
    }
  }

  private assertLease(token: ArtifactsCreateTokenResult, scope: "read" | "write"): void {
    if (
      token.scope !== scope ||
      Date.parse(token.expiresAt) > Date.now() + 301_000 ||
      Date.parse(token.expiresAt) <= Date.now() ||
      !Number.isFinite(Date.parse(token.expiresAt))
    )
      throw new ExecutionError("INVALID_TOKEN_LEASE");
  }

  private async execute(
    container: NativeContainer,
    command: Command,
    cwd?: string,
    signal?: AbortSignal,
    env?: Record<string, string>,
  ): Promise<CommandResult> {
    assertCommand(command);
    if (signal?.aborted) throw new ExecutionError("STOPPED");
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopping: Promise<CommandResult> | undefined;
    let resolveStop!: (result: CommandResult) => void;
    let rejectStop!: (error: unknown) => void;
    const stopped = new Promise<CommandResult>((resolve, reject) => {
      resolveStop = resolve;
      rejectStop = reject;
    });
    let bytes = 0;
    let stdout = "";
    let stderr = "";
    let active = true;
    const stop = (status: "timed_out" | "stopped" | "output_limit") => {
      if (!active || stopping) return;
      // Destroy the whole isolated instance: aborting exec alone leaves descendants alive.
      stopping = container.destroy(status).then(() => ({
        exitCode: null,
        stdout,
        stderr,
        truncated: status === "output_limit",
        status,
      }));
      stopping.then(resolveStop, rejectStop);
    };
    const onAbort = () => stop("stopped");
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => stop("timed_out"), command.timeoutMs);
    try {
      const completed = (async (): Promise<CommandResult> => {
        // GNU timeout is a second guard, with process-group semantics. The registered image
        // must contain git, coreutils timeout and the project's toolchain.
        const process = await container.exec(
          ["timeout", "--kill-after=1", `${command.timeoutMs / 1000}s`, ...command.argv],
          { cwd, env, stdout: "pipe", stderr: "pipe" },
        );
        const collect = async (stream: ReadableStream | null, channel: "stdout" | "stderr") => {
          if (!stream) return;
          const reader = stream.getReader();
          const decoder = new TextDecoder();
          try {
            while (active && !stopping) {
              const chunk = await reader.read();
              if (chunk.done) break;
              const data = new Uint8Array(chunk.value);
              const room = command.maxOutputBytes - bytes;
              const accepted = data.subarray(0, Math.max(0, room));
              bytes += accepted.byteLength;
              const text = decoder.decode(accepted, { stream: true });
              if (channel === "stdout") stdout += text;
              else stderr += text;
              if (data.byteLength > room) {
                stop("output_limit");
                break;
              }
            }
            const tail = decoder.decode();
            if (channel === "stdout") stdout += tail;
            else stderr += tail;
          } finally {
            reader.releaseLock();
          }
        };
        const [exitCode] = await Promise.all([
          process.exitCode,
          collect(process.stdout, "stdout"),
          collect(process.stderr, "stderr"),
        ]);
        if (stopping) return stopping;
        return {
          exitCode,
          stdout,
          stderr,
          truncated: false,
          status: exitCode === 124 || exitCode === 137 ? "timed_out" : "completed",
        };
      })();
      return await Promise.race([completed, stopped]);
    } catch {
      await container.destroy("command failed");
      throw new ExecutionError("COMMAND_FAILED");
    } finally {
      active = false;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
}
