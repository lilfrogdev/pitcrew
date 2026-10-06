export interface PrepareInput {
  runId: string;
  projectId: string;
  repository: string;
  baseSha: string;
  configurationRevision: string;
}
export interface Workspace extends PrepareInput {
  workerId: string;
  artifactId: string;
}
export interface Command {
  commandId: string;
  argv: string[];
  timeoutMs: number;
  maxOutputBytes: number;
}
export interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  status: "completed" | "timed_out" | "stopped" | "output_limit";
}
export interface TestEvidence extends CommandResult {
  runId: string;
  commandId: string;
  baseSha: string;
  candidateSha: string;
  configurationRevision: string;
  argv: string[];
}
export interface WorkspaceTransport {
  prepare(workspace: Workspace): Promise<void>;
  run(workspace: Workspace, command: Command, signal?: AbortSignal): Promise<CommandResult>;
  inspect(workspace: Workspace): Promise<{ sha: string; clean: boolean }>;
  // Implementations must keep write credentials out of candidate-controlled runtime,
  // executables and Git configuration; fail closed when no trusted publisher exists.
  publish(workspace: Workspace, candidateSha: string): Promise<void>;
  readFile(workspace: Workspace, path: string): Promise<string>;
  writeFile(workspace: Workspace, path: string, content: string): Promise<void>;
  stop(workspace: Workspace): Promise<void>;
}
export interface ForkTransport {
  fork(source: string, target: string, baseSha: string): Promise<void>;
}
export interface OperationRecord {
  fingerprint: string;
  state: "pending" | "complete";
  result?: unknown;
}
// Implement claim atomically in the trusted coordinator's DO SQLite transaction.
// Pending records survive crashes and prohibit replay of uncertain writes.
export interface OperationJournal {
  claim(key: string, fingerprint: string): Promise<{ claimed: boolean; record: OperationRecord }>;
  complete(key: string, fingerprint: string, result: unknown): Promise<void>;
}
export class ExecutionError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
export function assertSha(value: string): void {
  if (!/^[a-f0-9]{40}$/.test(value)) throw new ExecutionError("INVALID_SHA");
}
export function assertCommand(command: Command): void {
  if (
    !command.commandId ||
    command.argv.length === 0 ||
    command.argv.length > 128 ||
    command.argv.some(
      (arg) => typeof arg !== "string" || arg.includes("\0") || arg.length > 8192,
    ) ||
    !Number.isInteger(command.timeoutMs) ||
    command.timeoutMs < 1 ||
    command.timeoutMs > 600_000 ||
    !Number.isInteger(command.maxOutputBytes) ||
    command.maxOutputBytes < 1 ||
    command.maxOutputBytes > 1_048_576
  )
    throw new ExecutionError("INVALID_COMMAND");
}
