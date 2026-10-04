import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { App } from "./App";
import { createFixtureApi } from "./fixtures";
import type { Snapshot, Thread } from "./api";

afterEach(() => {
  cleanup();
  localStorage.clear();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function mount() {
  const api = createFixtureApi();
  render(<App api={api} demo />);
  await screen.findByText("Show the work behind a change, from delegation to review.");
  return api;
}
describe("conversation read ordering", () => {
  it.each(["success", "failure"])(
    "ignores a stale poll %s after a committed send",
    async (outcome) => {
      const api = await mount();
      const read = api.snapshot;
      const old = await read("welcome");
      const poll = deferred<Snapshot>();
      api.snapshot = vi
        .fn()
        .mockImplementationOnce(() => poll.promise)
        .mockImplementation(read);
      fireEvent(window, new Event("online"));
      await waitFor(() => expect(api.snapshot).toHaveBeenCalledTimes(1));
      fireEvent.change(screen.getByLabelText("Message your crew"), {
        target: { value: "Preserve the newest message" },
      });
      fireEvent.submit(screen.getByLabelText("Message your crew").closest("form")!);
      await screen.findByText("Preserve the newest message");
      await act(async () => {
        if (outcome === "success") poll.resolve(old);
        else poll.reject(Error("Stale offline failure"));
      });
      expect(screen.getByText("Preserve the newest message")).toBeTruthy();
      expect(screen.queryByRole("alert")).toBeNull();
    },
  );
  it("does not clear a failed repository refresh when a snapshot succeeds", async () => {
    const api = await mount();
    api.projects = vi.fn().mockRejectedValue(Error("Repositories unavailable"));
    const read = api.snapshot;
    const retried = deferred<Snapshot>();
    api.snapshot = vi
      .fn()
      .mockRejectedValueOnce(Error("Conversation unavailable"))
      .mockImplementation(() => retried.promise);
    fireEvent(window, new Event("online"));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Retry connection" }));
    await waitFor(() => expect(api.projects).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("Repositories unavailable"),
    );
    await act(async () => retried.resolve(await read("welcome")));
    expect(screen.getByRole("alert").textContent).toContain("Repositories unavailable");
    expect(
      screen.getByText("Show the work behind a change, from delegation to review."),
    ).toBeTruthy();
  });
  it("waits for repository threads before creating so a stale list cannot discard the new conversation", async () => {
    const api = await mount();
    const readThreads = api.threads;
    const list = deferred<Thread[]>();
    api.threads = vi
      .fn()
      .mockImplementation((id: string) => (id === "playground" ? list.promise : readThreads(id)));
    api.createThread = vi.fn(api.createThread);
    fireEvent.click(screen.getByRole("button", { name: "New conversation in Playground" }));
    fireEvent.change(screen.getByLabelText("Conversation title"), {
      target: { value: "Created after load" },
    });
    const create = screen.getByRole("button", { name: /^Create$/ });
    expect(create.hasAttribute("disabled")).toBe(true);
    fireEvent.submit(create.closest("form")!);
    expect(api.createThread).not.toHaveBeenCalled();
    await act(async () => list.resolve(await readThreads("playground")));
    await waitFor(() => expect(create.hasAttribute("disabled")).toBe(false));
    fireEvent.click(create);
    await screen.findByRole("heading", { name: "Created after load" });
    await screen.findByText("Start with the outcome");
    expect(api.createThread).toHaveBeenCalledTimes(1);
  });
  it("keeps send disabled while a retried snapshot is pending, even after lists succeed", async () => {
    const api = await mount();
    fireEvent.change(screen.getByLabelText("Message your crew"), {
      target: { value: "Draft while offline" },
    });
    const read = api.snapshot;
    const snapshot = deferred<Snapshot>();
    api.snapshot = vi
      .fn()
      .mockRejectedValueOnce(Error("Offline"))
      .mockImplementation(() => snapshot.promise);
    fireEvent(window, new Event("online"));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Retry connection" }));
    await waitFor(() => expect(api.snapshot).toHaveBeenCalledTimes(2));
    await act(async () => {});
    expect(screen.getByRole("button", { name: /Send message/ }).hasAttribute("disabled")).toBe(
      true,
    );
    await act(async () => snapshot.resolve(await read("welcome")));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Send message/ }).hasAttribute("disabled")).toBe(
        false,
      ),
    );
  });
});
