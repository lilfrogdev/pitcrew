import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { App } from "./App";
import { createFixtureApi } from "./fixtures";
import type { ConversationTurn, Snapshot } from "./api";

afterEach(() => {
  cleanup();
  localStorage.clear();
});
const viewer = { id: "owner", name: "Owner", email: "owner@example.com", emailVerified: true };
const snapshot: Snapshot = {
  messages: [],
  runs: [],
  reviews: [],
  evidence: [],
  turns: [{ id: "own-turn", status: "running", canStop: true }],
};

it("requires an authenticated viewer for Stop and never sends a model invocation", async () => {
  const api = createFixtureApi();
  api.snapshot = vi.fn(async () => snapshot);
  api.stopTurn = vi.fn(async (): Promise<ConversationTurn> => ({
    id: "own-turn",
    status: "failed",
    canStop: false,
  }));
  api.send = vi.fn();
  const { rerender } = render(<App api={api} />);
  await screen.findByText("Start the conversation");
  expect(screen.queryByRole("button", { name: "Stop agent reply" })).toBeNull();
  rerender(<App api={api} viewer={viewer} />);
  await screen.findByRole("button", { name: "Stop agent reply" });
  expect(api.send).not.toHaveBeenCalled();
  expect(api.stopTurn).not.toHaveBeenCalled();
});

it("does not expose an old account's cancellation permission while the new account snapshot is pending", async () => {
  const api = createFixtureApi();
  api.snapshot = vi.fn(async () => snapshot);
  api.stopTurn = vi.fn();
  const { rerender } = render(<App api={api} viewer={viewer} />);
  await screen.findByRole("button", { name: "Stop agent reply" });
  let finish!: (value: Snapshot) => void;
  vi.mocked(api.snapshot).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  rerender(<App api={api} viewer={{ ...viewer, id: "peer" }} />);
  expect(screen.queryByRole("button", { name: "Stop agent reply" })).toBeNull();
  await act(async () =>
    finish({ ...snapshot, turns: [{ id: "own-turn", status: "running", canStop: false }] }),
  );
  expect(screen.queryByRole("button", { name: "Stop agent reply" })).toBeNull();
  expect(api.stopTurn).not.toHaveBeenCalled();
});

it("does not present a cancelled reply as an execution failure", async () => {
  const api = createFixtureApi();
  api.snapshot = vi.fn(async (): Promise<Snapshot> => ({
    ...snapshot,
    turns: [{ id: "own-turn", status: "failed", error: "conversation_cancelled", canStop: false }],
  }));
  api.stopTurn = vi.fn();
  render(<App api={api} viewer={viewer} />);
  await screen.findByText("Agent reply stopped.");
  expect(screen.queryByText(/Repository agent reply failed/)).toBeNull();
});
