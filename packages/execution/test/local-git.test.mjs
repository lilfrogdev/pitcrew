import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LocalBaselineFork, LocalGitWorkspace, committedBaselineSha } from "../src/index.ts";
import {
  assertMaterializedContract,
  contractDocument,
  materializeContract,
  pinContract,
} from "../../verification/src/index.ts";

const fixture = resolve(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/baseline");

test("local baseline checkout commits once, runs tests, and rejects a tampered contract", async () => {
  const sha = await committedBaselineSha(fixture);
  assert.match(sha, /^[a-f0-9]{40}$/);
  const root = await mkdtemp(resolve(tmpdir(), "pitcrew-local-"));
  try {
    const workspaces = new LocalGitWorkspace(root);
    const forks = new LocalBaselineFork(fixture, workspaces);
    const workspace = {
      runId: "run",
      projectId: "pitcrew",
      repository: "pitcrew-baseline",
      baseSha: sha,
      configurationRevision: "local-agent-v1",
      workerId: "worker",
      artifactId: "checkout",
    };
    await forks.fork("pitcrew-baseline", workspace.artifactId, sha);
    await forks.fork("pitcrew-baseline", workspace.artifactId, sha);
    await assert.rejects(
      () => forks.fork("pitcrew-baseline", "other", "b".repeat(40)),
      /STALE_BASE/,
    );
    await workspaces.prepare(workspace);
    const remotes = await workspaces.run(workspace, {
      commandId: "remotes",
      argv: ["git", "remote"],
      timeoutMs: 5000,
      maxOutputBytes: 1024,
    });
    assert.equal(remotes.stdout, "");
    await assert.rejects(
      () =>
        workspaces.run(workspace, {
          commandId: "push",
          argv: ["git", "push"],
          timeoutMs: 5000,
          maxOutputBytes: 1024,
        }),
      /NETWORK_COMMAND/,
    );
    const tests = await workspaces.run(workspace, {
      commandId: "tests",
      argv: ["pnpm", "test"],
      timeoutMs: 30000,
      maxOutputBytes: 16384,
    });
    assert.equal(tests.status, "completed");
    assert.equal(tests.exitCode, 0);
    const snapshot = await pinContract({
      projectId: "pitcrew",
      missionId: "mission",
      baseSha: sha,
      configurationRevision: "local-agent-v1",
      proposalRevision: "proposal",
      checks: [
        {
          id: "tests",
          kind: "command",
          command: { argv: ["pnpm", "test"], timeoutMs: 30000, maxOutputBytes: 16384 },
        },
      ],
      acceptance: {
        revision: "mission",
        criteria: [{ id: "behavior", text: "greet returns hello", checkIds: ["tests"] }],
      },
    });
    await materializeContract(snapshot, workspace, workspaces);
    await assertMaterializedContract(snapshot, workspace, workspaces);
    await workspaces.writeFile(workspace, ".agent_context/ASSERTIONS.json", '{"tampered":true}');
    await assert.rejects(
      () => assertMaterializedContract(snapshot, workspace, workspaces),
      /CONTRACT_TAMPERED|FILE_READ_FAILED|SyntaxError/,
    );
    assert.equal(contractDocument(snapshot).includes(sha), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
