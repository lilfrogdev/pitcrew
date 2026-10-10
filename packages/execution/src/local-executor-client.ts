import { ExecutionError } from "./contracts.ts";
import type {
  Command,
  CommandResult,
  ForkTransport,
  Workspace,
  WorkspaceTransport,
} from "./contracts.ts";

const tokenHeader = "x-pitcrew-local-executor";

export class LocalExecutorClient implements WorkspaceTransport, ForkTransport {
  constructor(
    private readonly url: string,
    private readonly token = "local-agent-v1",
  ) {}

  fork(source: string, target: string, baseSha: string): Promise<void> {
    return this.call("fork", { source, target, baseSha });
  }
  prepare(workspace: Workspace): Promise<void> {
    return this.call("prepare", { workspace });
  }
  run(workspace: Workspace, command: Command, signal?: AbortSignal): Promise<CommandResult> {
    return this.call("run", { workspace, command }, signal);
  }
  inspect(workspace: Workspace): Promise<{ sha: string; clean: boolean }> {
    return this.call("inspect", { workspace });
  }
  publish(workspace: Workspace, candidateSha: string): Promise<void> {
    return this.call("publish", { workspace, candidateSha });
  }
  readFile(workspace: Workspace, path: string): Promise<string> {
    return this.call("readFile", { workspace, path });
  }
  writeFile(workspace: Workspace, path: string, content: string): Promise<void> {
    return this.call("writeFile", { workspace, path, content });
  }
  stop(workspace: Workspace): Promise<void> {
    return this.call("stop", { workspace });
  }
  duplicate(source: Workspace, target: Workspace): Promise<void> {
    return this.call("duplicate", { source, target });
  }
  discard(workspace: Workspace): Promise<void> {
    return this.call("discard", { workspace });
  }

  private async call<T>(op: string, body: unknown, signal?: AbortSignal): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.url.replace(/\/$/, "")}/${op}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [tokenHeader]: this.token,
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch {
      throw new ExecutionError("executor_unavailable");
    }
    const payload = (await response.json().catch(() => undefined)) as
      | { ok: true; result: T }
      | { ok: false; error: string }
      | undefined;
    if (!response.ok || !payload || payload.ok !== true)
      throw new ExecutionError(
        payload && "error" in payload && payload.error ? payload.error : "executor_failed",
      );
    return payload.result;
  }
}
