import { expect, it } from "vite-plus/test";
import { blockingProbe, runDisposableProbe, sanitizeProbeSource } from "./probes";
import type { Workspace } from "../../../packages/execution/src/contracts";

const workspace: Workspace = {
  runId: "r1",
  projectId: "p",
  repository: "repo",
  baseSha: "a".repeat(40),
  configurationRevision: "1",
  workerId: "worker",
  artifactId: "fork",
};

it("rejects probe source that can leave the disposable checkout", () => {
  expect(() => sanitizeProbeSource("import test from 'node:test'")).toThrow("invalid_probe");
  expect(() =>
    sanitizeProbeSource(
      "import test from 'node:test'; import assert from 'node:assert/strict'; import { spawn } from 'node:child_process';",
    ),
  ).toThrow("invalid_probe");
});

it("blocks only a reproducible failing probe and always discards the checkout", async () => {
  expect(blockingProbe({ exitCode: 1, reproducible: true, truncated: false })).toBe(true);
  expect(blockingProbe({ exitCode: 1, reproducible: false, truncated: false })).toBe(false);
  let discarded = 0;
  const probe = await runDisposableProbe(workspace, {
    async duplicate() {},
    async writeFile() {},
    async discard() {
      discarded += 1;
    },
    async run() {
      return { status: "completed", exitCode: 1, stdout: "", stderr: "no", truncated: false };
    },
  });
  expect(probe.blocking).toBe(true);
  expect(probe.command).toEqual(["node", "--test", ".pitcrew-probes/edge.test.mjs"]);
  expect(discarded).toBe(1);
  let failedDiscard = 0;
  await expect(
    runDisposableProbe(workspace, {
      async duplicate() {
        throw Error("copy_failed");
      },
      async writeFile() {},
      async discard() {
        failedDiscard += 1;
      },
      async run() {
        throw Error("unused");
      },
    }),
  ).rejects.toThrow("copy_failed");
  expect(failedDiscard).toBe(1);
});
