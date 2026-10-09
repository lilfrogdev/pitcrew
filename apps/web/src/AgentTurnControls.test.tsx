import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { AgentTurnControls } from "./AgentTurnControls";
import { ApiError, type ConversationTurn } from "./api";

afterEach(cleanup);
const active: ConversationTurn = { id: "own-turn", status: "running", canStop: true };
const stopped: ConversationTurn = {
  id: active.id,
  status: "failed",
  error: "conversation_cancelled",
  canStop: false,
};
const props = () => ({
  threadId: "thread",
  turns: [active],
  stopTurn: vi.fn(async () => stopped),
  onAccessLost: vi.fn(),
});

it("offers Stop only for server-authorized queued/running turns", () => {
  render(
    <AgentTurnControls
      {...props()}
      turns={[
        { ...active, status: "queued" },
        { id: "peer", status: "running", canStop: false },
        { id: "legacy", status: "queued" },
        { id: "finished", status: "completed", canStop: true },
        { id: "failed", status: "failed", canStop: true },
      ]}
    />,
  );
  expect(screen.getAllByRole("button", { name: "Stop agent reply" })).toHaveLength(1);
  expect(screen.getByText("Agent reply queued.")).toBeTruthy();
});

it("keeps one cancellation pending across polling and does not replay it", async () => {
  const input = props();
  let complete!: (turn: ConversationTurn) => void;
  input.stopTurn.mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const { rerender } = render(<AgentTurnControls {...input} />);
  fireEvent.click(screen.getByRole("button", { name: "Stop agent reply" }));
  fireEvent.click(screen.getByRole("button", { name: "Stop agent reply" }));
  rerender(<AgentTurnControls {...input} turns={[{ ...active }]} />);
  expect(screen.getByText("Stopping agent reply…")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Stop agent reply" })).toHaveProperty("disabled", true);
  expect(input.stopTurn).toHaveBeenCalledExactlyOnceWith("thread", "own-turn");
  await act(async () => complete(stopped));
  expect(screen.getByText("Agent reply stopped.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Stop agent reply" })).toBeNull();
});

it("reports a completion race without claiming it cancelled a finished reply", async () => {
  const input = props();
  input.stopTurn.mockResolvedValue({ ...active, status: "completed", canStop: false });
  render(<AgentTurnControls {...input} />);
  fireEvent.click(screen.getByRole("button", { name: "Stop agent reply" }));
  await screen.findByText("Agent reply already finished.");
  expect(screen.queryByText("Agent reply stopped.")).toBeNull();
});

it("preserves uncertain failures across snapshots and retries only on an explicit click", async () => {
  const input = props();
  input.stopTurn.mockRejectedValueOnce(new Error("offline"));
  const { rerender } = render(<AgentTurnControls {...input} />);
  fireEvent.click(screen.getByRole("button", { name: "Stop agent reply" }));
  await screen.findByRole("alert");
  rerender(<AgentTurnControls {...input} turns={[{ ...active }]} />);
  expect(screen.getByRole("alert").textContent).toContain("Could not confirm");
  expect(input.stopTurn).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Stop agent reply" }));
  await screen.findByText("Agent reply stopped.");
  expect(input.stopTurn).toHaveBeenCalledTimes(2);
});

it.each([401, 403, 404])("clears access after a denied Stop (%s)", async (status) => {
  const input = props();
  input.stopTurn.mockRejectedValue(new ApiError(status));
  render(<AgentTurnControls {...input} />);
  fireEvent.click(screen.getByRole("button", { name: "Stop agent reply" }));
  await act(async () => {});
  expect(input.onAccessLost).toHaveBeenCalledOnce();
});

it("ignores a late denial after changing the authenticated conversation scope", async () => {
  const input = props();
  let reject!: (reason: unknown) => void;
  input.stopTurn.mockImplementation(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  const { rerender } = render(<AgentTurnControls key="account:first" {...input} />);
  fireEvent.click(screen.getByRole("button", { name: "Stop agent reply" }));
  rerender(<AgentTurnControls key="account:second" {...input} turns={[]} />);
  await act(async () => reject(new ApiError(403)));
  expect(input.onAccessLost).not.toHaveBeenCalled();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("renders server-confirmed cancelled turns as stopped", () => {
  render(<AgentTurnControls {...props()} turns={[stopped]} />);
  expect(screen.getByText("Agent reply stopped.")).toBeTruthy();
  expect(screen.queryByRole("button")).toBeNull();
});
