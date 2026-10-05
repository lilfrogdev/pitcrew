import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { App } from "./App";
import { createFixtureApi } from "./fixtures";
import type { Api, Snapshot } from "./api";
afterEach(() => {
  cleanup();
  localStorage.clear();
});
async function mount(api: Api = createFixtureApi()) {
  render(<App api={api} demo />);
  await screen.findByRole("heading", { name: "Make agent work visible" });
  await screen.findByText("Show the work behind a change, from delegation to review.");
  return api;
}
describe("project conversations", () => {
  it("shows visible roles, exact hashes, tests, review, and gated fixture approval", async () => {
    await mount();
    expect(screen.getByText("Repository agent")).toBeTruthy();
    expect(screen.getByText("Change worker")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Review / PR" }));
    fireEvent.click(screen.getByText("Tests and tool output"));
    expect(screen.getByText(/8 synthetic checks passed/)).toBeTruthy();
    expect(screen.getByText(/Matches current candidate/)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Approve exact candidate" }).hasAttribute("disabled"),
    ).toBe(false);
  });
  it("switches projects and threads, preserves drafts, and creates an empty thread", async () => {
    const user = userEvent.setup();
    await mount();
    await user.type(screen.getByLabelText("Message your crew"), "Keep this draft");
    await user.click(screen.getByRole("button", { name: "Recover interrupted work" }));
    await screen.findByText(/Worker execution stopped/);
    expect((screen.getByLabelText("Message your crew") as HTMLTextAreaElement).value).toBe("");
    await user.click(screen.getByRole("button", { name: "Make agent work visible" }));
    expect((screen.getByLabelText("Message your crew") as HTMLTextAreaElement).value).toBe(
      "Keep this draft",
    );
    await user.click(screen.getByRole("button", { name: "Playground · synthetic/example" }));
    await screen.findByRole("heading", { name: "Explore an isolated change" });
    await user.click(screen.getByRole("button", { name: "New conversation in Playground" }));
    await user.type(screen.getByLabelText("Conversation title"), "New change");
    await user.click(screen.getByRole("button", { name: /^Create$/ }));
    await screen.findByRole("heading", { name: "New change" });
    await screen.findByText("Start with the outcome");
  });
  it("submits once and retains the idempotency key after an uncertain write", async () => {
    const api = createFixtureApi();
    const original = api.send;
    const send = vi
      .fn()
      .mockImplementationOnce(async (id: string, content: string, key: string) => {
        await original(id, content, key);
        throw new Error("Uncertain response");
      })
      .mockImplementation(original);
    api.send = send;
    const user = userEvent.setup();
    await mount(api);
    await user.type(screen.getByLabelText("Message your crew"), "Add a useful change");
    await user.click(screen.getByRole("button", { name: /Send message/ }));
    await screen.findByRole("alert");
    expect((screen.getByLabelText("Message your crew") as HTMLTextAreaElement).value).toBe(
      "Add a useful change",
    );
    await user.click(screen.getByRole("button", { name: /Send message/ }));
    await waitFor(() =>
      expect((screen.getByLabelText("Message your crew") as HTMLTextAreaElement).value).toBe(""),
    );
    expect(send.mock.calls[0][2]).toBe(send.mock.calls[1][2]);
    expect(screen.getAllByText("Add a useful change")).toHaveLength(1);
    expect(within(screen.getByLabelText("Change evidence")).getByText("Queued")).toBeTruthy();
  });
  it("reconnects without replaying a message and keeps the selected thread", async () => {
    const api = createFixtureApi();
    const snapshot = api.snapshot;
    api.send = vi.fn(api.send);
    const user = userEvent.setup();
    await mount(api);
    await user.click(screen.getByRole("button", { name: "Recover interrupted work" }));
    await screen.findByText(/Worker execution stopped/);
    api.snapshot = vi
      .fn()
      .mockRejectedValueOnce(new Error("Offline test"))
      .mockImplementation(snapshot);
    fireEvent(window, new Event("online"));
    await screen.findByRole("alert");
    await user.click(screen.getByRole("button", { name: "Retry connection" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(screen.getByRole("heading", { name: "Recover interrupted work" })).toBeTruthy();
    expect(api.send).not.toHaveBeenCalled();
  });
  it("ignores old conversation responses after navigation", async () => {
    const api = createFixtureApi();
    const original = api.snapshot;
    let resolveOld: (value: Snapshot) => void = () => {};
    api.snapshot = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Snapshot>((resolve) => {
            resolveOld = resolve;
          }),
      )
      .mockImplementation(original);
    render(<App api={api} />);
    await screen.findByRole("heading", { name: "Make agent work visible" });
    fireEvent.click(screen.getByRole("button", { name: "Recover interrupted work" }));
    await screen.findByText(/Worker execution stopped/);
    resolveOld(await original("welcome"));
    await waitFor(() =>
      expect(
        screen.queryByText("Show the work behind a change, from delegation to review."),
      ).toBeNull(),
    );
  });
  it("recovers a denied initial connection without presenting fixture access", async () => {
    const api = createFixtureApi();
    api.projects = vi
      .fn()
      .mockRejectedValueOnce(new Error("Access denied"))
      .mockImplementation(api.projects);
    const user = userEvent.setup();
    render(<App api={api} />);
    await screen.findByRole("alert");
    expect(screen.queryByText("Synthetic preview")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Retry connection" }));
    await screen.findByRole("heading", { name: "Make agent work visible" });
  });
});
