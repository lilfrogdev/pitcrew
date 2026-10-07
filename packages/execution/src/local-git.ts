import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { cp, mkdir, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { ExecutionError, assertCommand, assertSha } from "./contracts.ts";
import type {
  Command,
  CommandResult,
  ForkTransport,
  Workspace,
  WorkspaceTransport,
} from "./contracts.ts";

const identity = {
  GIT_AUTHOR_NAME: "Pitcrew",
  GIT_AUTHOR_EMAIL: "pitcrew@localhost",
  GIT_AUTHOR_DATE: "2026-10-06T00:00:00Z",
  GIT_COMMITTER_NAME: "Pitcrew",
  GIT_COMMITTER_EMAIL: "pitcrew@localhost",
  GIT_COMMITTER_DATE: "2026-10-06T00:00:00Z",
};

export function resolveLocalPaths(fixtureDir: string, workspaceRoot: string) {
  let dir = process.cwd();
  for (let i = 0; i < 6; i += 1) {
    const fixture = resolve(dir, fixtureDir);
    if (existsSync(resolve(fixture, "package.json")))
      return { fixture, root: resolve(dir, workspaceRoot) };
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("execution_not_configured");
}

function commandEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    ...identity,
  };
}

function assertPath(path: string): void {
  if (
    !path ||
    path.startsWith("/") ||
    path.includes("\0") ||
    path.split("/").some((part) => part === ".." || part === ".git") ||
    path.length > 1024
  )
    throw new ExecutionError("INVALID_PATH");
}

function networkCommand(argv: string[]): boolean {
  if (argv[0] !== "git") return ["curl", "wget", "ssh", "nc", "scp"].includes(argv[0] ?? "");
  if (["push", "fetch", "pull", "clone", "ls-remote"].includes(argv[1] ?? "")) return true;
  return argv[1] === "remote" && argv.length > 2;
}

function runProcess(
  cwd: string,
  argv: string[],
  timeoutMs: number,
  maxOutputBytes: number,
  signal?: AbortSignal,
): Promise<CommandResult> {
  return new Promise((done) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      env: commandEnv(),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let truncated = false;
    const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
    const take = (chunk: Uint8Array, current: string) => {
      const next = current + new TextDecoder().decode(chunk);
      if (bytes(next) <= maxOutputBytes) return next;
      truncated = true;
      return next.slice(0, maxOutputBytes);
    };
    child.stdout?.on("data", (chunk: Uint8Array) => {
      stdout = take(chunk, stdout);
    });
    child.stderr?.on("data", (chunk: Uint8Array) => {
      stderr = take(chunk, stderr);
    });
    let settled = false;
    const finish = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      done(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({
        exitCode: null,
        stdout,
        stderr,
        truncated,
        status: "timed_out",
      });
    }, timeoutMs);
    const onAbort = () => {
      child.kill("SIGKILL");
      finish({ exitCode: null, stdout, stderr, truncated, status: "stopped" });
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", () => {
      clearTimeout(timer);
      finish({ exitCode: null, stdout, stderr, truncated, status: "stopped" });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (truncated) {
        finish({ exitCode: code, stdout, stderr, truncated: true, status: "output_limit" });
        return;
      }
      finish({
        exitCode: code,
        stdout,
        stderr,
        truncated: false,
        status: "completed",
      });
    });
  });
}

export class LocalGitWorkspace implements WorkspaceTransport {
  constructor(private readonly root: string) {}

  location(artifactId: string): string {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(artifactId)) throw new ExecutionError("INVALID_WORKSPACE");
    return resolve(this.root, artifactId);
  }

  directory(workspace: Workspace): string {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(workspace.artifactId))
      throw new ExecutionError("INVALID_WORKSPACE");
    return this.location(workspace.artifactId);
  }

  async prepare(workspace: Workspace): Promise<void> {
    const inspected = await this.inspect(workspace);
    if (inspected.sha !== workspace.baseSha || !inspected.clean)
      throw new ExecutionError("STALE_BASE");
  }

  async run(workspace: Workspace, command: Command, signal?: AbortSignal): Promise<CommandResult> {
    assertCommand(command);
    if (networkCommand(command.argv)) throw new ExecutionError("NETWORK_COMMAND");
    if (signal?.aborted)
      return { exitCode: null, stdout: "", stderr: "", truncated: false, status: "stopped" };
    return runProcess(
      this.directory(workspace),
      command.argv,
      command.timeoutMs,
      command.maxOutputBytes,
      signal,
    );
  }

  async inspect(workspace: Workspace): Promise<{ sha: string; clean: boolean }> {
    const head = await this.git(workspace, ["rev-parse", "HEAD"]);
    const status = await this.git(workspace, ["status", "--porcelain", "--untracked-files=all"]);
    if (head.status !== "completed" || head.exitCode !== 0 || status.status !== "completed")
      throw new ExecutionError("INSPECTION_FAILED");
    const sha = head.stdout.trim();
    assertSha(sha);
    return { sha, clean: status.stdout === "" && !status.truncated };
  }

  async publish(workspace: Workspace, candidateSha: string): Promise<void> {
    assertSha(candidateSha);
    const inspected = await this.inspect(workspace);
    if (inspected.sha !== candidateSha || !inspected.clean)
      throw new ExecutionError("STALE_CANDIDATE");
  }

  async readFile(workspace: Workspace, path: string): Promise<string> {
    assertPath(path);
    const { readFile } = await import("node:fs/promises");
    try {
      return await readFile(resolve(this.directory(workspace), path), "utf8");
    } catch {
      throw new ExecutionError("FILE_READ_FAILED");
    }
  }

  async readAt(workspace: Workspace, revision: string, path: string): Promise<string> {
    assertSha(revision);
    assertPath(path);
    const result = await this.git(workspace, ["show", `${revision}:${path}`]);
    if (result.status !== "completed" || result.exitCode !== 0 || result.truncated)
      throw new ExecutionError("FILE_READ_FAILED");
    return result.stdout;
  }

  async writeFile(workspace: Workspace, path: string, content: string): Promise<void> {
    assertPath(path);
    if (new TextEncoder().encode(content).byteLength > 8192)
      throw new ExecutionError("FILE_TOO_LARGE");
    const { writeFile, mkdir: makeDirectory } = await import("node:fs/promises");
    const file = resolve(this.directory(workspace), path);
    await makeDirectory(dirname(file), { recursive: true });
    await writeFile(file, content);
  }

  async stop(_workspace: Workspace): Promise<void> {}

  private git(workspace: Workspace, args: string[]): Promise<CommandResult> {
    return runProcess(this.directory(workspace), ["git", ...args], 10_000, 65_536);
  }
}

async function hasDirectory(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

export async function committedBaselineSha(fixtureDir: string): Promise<string> {
  const root = resolve(tmpdir(), "pitcrew-baseline-sha");
  const workspaces = new LocalGitWorkspace(root);
  const forks = new LocalBaselineFork(fixtureDir, workspaces);
  const probe = "baseline";
  await forks.seed(probe);
  const inspected = await workspaces.inspect({
    runId: "local",
    projectId: "local",
    repository: "pitcrew-baseline",
    baseSha: "a".repeat(40),
    configurationRevision: "local",
    workerId: probe,
    artifactId: probe,
  });
  return inspected.sha;
}

export class LocalBaselineFork implements ForkTransport {
  constructor(
    private readonly fixtureDir: string,
    private readonly workspaces: LocalGitWorkspace,
  ) {}

  async fork(_source: string, target: string, baseSha: string): Promise<void> {
    assertSha(baseSha);
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(target)) throw new ExecutionError("INVALID_WORKSPACE");
    await this.seed(target);
    const inspected = await this.workspaces.inspect({
      runId: "local",
      projectId: "local",
      repository: "pitcrew-baseline",
      baseSha,
      configurationRevision: "local",
      workerId: target,
      artifactId: target,
    });
    if (inspected.sha !== baseSha || !inspected.clean) throw new ExecutionError("STALE_BASE");
  }

  async seed(target: string): Promise<void> {
    const destination = this.workspaces.location(target);
    await mkdir(dirname(destination), { recursive: true });
    if (!(await hasDirectory(destination)))
      await cp(resolve(this.fixtureDir), destination, { recursive: true });
    const workspace = {
      runId: "local",
      projectId: "local",
      repository: "pitcrew-baseline",
      baseSha: "a".repeat(40),
      configurationRevision: "local",
      workerId: target,
      artifactId: target,
    };
    const existing = await this.workspaces.inspect(workspace).catch(() => undefined);
    if (existing?.clean) return;
    if (existing) throw new ExecutionError("STALE_BASE");
    const init = await this.workspaces.run(workspace, {
      commandId: "git-init",
      argv: ["git", "init", "-b", "main"],
      timeoutMs: 10_000,
      maxOutputBytes: 4096,
    });
    const add = await this.workspaces.run(workspace, {
      commandId: "git-add",
      argv: ["git", "add", "--all"],
      timeoutMs: 10_000,
      maxOutputBytes: 4096,
    });
    const commit = await this.workspaces.run(workspace, {
      commandId: "git-commit",
      argv: ["git", "commit", "--message", "Baseline"],
      timeoutMs: 10_000,
      maxOutputBytes: 4096,
    });
    if (
      [init, add, commit].some((result) => result.status !== "completed" || result.exitCode !== 0)
    )
      throw new ExecutionError("BASELINE_COMMIT_FAILED");
  }
}
