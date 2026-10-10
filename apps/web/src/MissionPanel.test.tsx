import { useState } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it } from "vite-plus/test";
import type { Mission } from "@pitcrew/protocol";
import type { Api } from "./api";
import { MissionPanel } from "./MissionPanel";

afterEach(() => cleanup());

function mission(status: Mission["status"], revision = "rev-1"): Mission {
  const proposed = status !== "clarifying";
  return {
    id: "mission",
    projectId: "pitcrew",
    threadId: "thread",
    messageId: "message",
    status,
    request: "Add a greeting",
    questions: [
      {
        id: "observable-behavior",
        prompt: "What observable behavior should the tests assert?",
        ...(proposed ? { answer: "returns hello, pitcrew" } : {}),
      },
    ],
    ...(proposed
      ? {
          proposal: {
            revision,
            digest: revision,
            summary: "Add a greeting",
            affectedArea: "src",
            acceptance: {
              revision: "mission",
              criteria: [{ id: "behavior", text: "returns hello, pitcrew", checkIds: ["tests"] }],
            },
            checks: [
              {
                id: "tests",
                kind: "command" as const,
                command: { argv: ["pnpm", "test"], timeoutMs: 60000, maxOutputBytes: 16384 },
              },
            ],
          },
          contract: {
            version: 1 as const,
            digest: revision,
            projectId: "pitcrew",
            missionId: "mission",
            baseSha: "a".repeat(40),
            configurationRevision: "config",
            proposalRevision: revision,
            checks: [
              {
                id: "tests",
                kind: "command" as const,
                command: { argv: ["pnpm", "test"], timeoutMs: 60000, maxOutputBytes: 16384 },
              },
            ],
            acceptance: {
              revision: "mission",
              criteria: [{ id: "behavior", text: "returns hello, pitcrew", checkIds: ["tests"] }],
            },
          },
        }
      : {}),
  };
}

function panel(initial: Mission | null, executionEnabled = true) {
  let current = initial;
  const api = {
    missions: {
      current: async () => current,
      create: async () => {
        current = mission("clarifying");
        return current;
      },
      answer: async () => {
        current = mission("proposed");
        return current;
      },
      revise: async (
        _id: string,
        input: { summary: string; affectedArea: string; criterion: string },
      ) => {
        current = mission("proposed", `rev-${input.summary.length}`);
        current.proposal!.summary = input.summary;
        return current;
      },
      approve: async (_id: string, revision: string) => {
        if (revision !== current?.proposal?.revision) throw Error("This approval is stale.");
        current = { ...current!, status: "approved", approvedRevision: revision };
        return current;
      },
      start: async () => {
        if (!executionEnabled) throw Error("Runs are disabled.");
        current = { ...current!, status: "running", runId: "run" };
        return {
          mission: current,
          run: {
            id: "run",
            threadId: "thread",
            status: "queued",
            baseSha: "a".repeat(40),
            configurationRevision: "config",
          },
        };
      },
    },
  } as unknown as Api;
  function Harness() {
    const [enabled, setEnabled] = useState(executionEnabled);
    return (
      <>
        <button type="button" onClick={() => setEnabled(false)}>
          Disable runs
        </button>
        <MissionPanel
          api={api}
          projectId="pitcrew"
          threadId="thread"
          evidence={[]}
          executionEnabled={enabled}
        />
      </>
    );
  }
  return Harness;
}

it("walks from an unanswered question through a revised approval", async () => {
  const user = userEvent.setup();
  const Harness = panel(mission("clarifying"));
  render(<Harness />);
  expect(
    await screen.findByLabelText("What observable behavior should the tests assert?"),
  ).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Approve this revision" })).toBeNull();
  await user.type(
    screen.getByLabelText("What observable behavior should the tests assert?"),
    "returns hello, pitcrew",
  );
  await user.click(screen.getByRole("button", { name: "Save answer" }));
  expect(await screen.findByRole("button", { name: "Approve this revision" })).toBeTruthy();
  await user.clear(screen.getByLabelText("Summary"));
  await user.type(screen.getByLabelText("Summary"), "Add the named greeting");
  await user.click(screen.getByRole("button", { name: "Update proposal" }));
  await user.click(await screen.findByRole("button", { name: "Approve this revision" }));
  expect(await screen.findByRole("button", { name: "Start implementation" })).toBeTruthy();
});

it("keeps implementation stopped while runs are disabled", async () => {
  const user = userEvent.setup();
  const Harness = panel(mission("approved"), true);
  render(<Harness />);
  expect(await screen.findByRole("button", { name: "Start implementation" })).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Disable runs" }));
  expect((await screen.findByRole("status")).textContent).toContain(
    "Runs are disabled by the server.",
  );
  expect(
    (screen.getByRole("button", { name: "Start implementation" }) as HTMLButtonElement).disabled,
  ).toBe(true);
});
