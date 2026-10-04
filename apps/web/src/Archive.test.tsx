import { cleanup, render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { App } from "./App";
import { createFixtureApi } from "./fixtures";
import type { Api } from "./api";

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
async function act(
  user: ReturnType<typeof userEvent.setup>,
  name: string,
  action: "Archive" | "Restore",
  container: HTMLElement,
) {
  const summary = within(container).getByLabelText(`Conversation actions ${name}`);
  await user.click(summary);
  await user.click(
    within(summary.closest("details")!).getByRole("button", { name: `${action} conversation` }),
  );
}
async function search(user: ReturnType<typeof userEvent.setup>, title: string) {
  await user.click(screen.getByRole("button", { name: "Search repositories" }));
  await user.type(screen.getByRole("textbox", { name: "Search repositories" }), title);
  return screen.getByRole("region", { name: "Conversation search results" });
}
describe("archive conversations", () => {
  it("hides active pinned threads, keeps their draft/transcript and pin intent, then searches/restores after remount", async () => {
    const user = userEvent.setup(),
      api = await mount();
    const name = "Make agent work visible";
    await user.click(screen.getByRole("button", { name: `Pin conversation ${name}` }));
    await user.type(screen.getByLabelText("Message your crew"), "Retain my draft");
    const readSnapshot = vi.spyOn(api, "snapshot");
    await act(user, name, "Archive", screen.getByLabelText("Conversations in Pitcrew"));
    await waitFor(() => expect(screen.queryByRole("button", { name })).toBeNull());
    expect(screen.getByRole("heading", { name })).toBeTruthy();
    expect(
      screen.getByText("Show the work behind a change, from delegation to review."),
    ).toBeTruthy();
    expect((screen.getByLabelText("Message your crew") as HTMLTextAreaElement).value).toBe(
      "Retain my draft",
    );
    expect(readSnapshot).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem("pitcrew.sidebar.pins.v1")!).conversations).toContain(
      "welcome",
    );
    await user.click(screen.getByRole("button", { name: "Recover interrupted work" }));
    await screen.findByRole("heading", { name: "Recover interrupted work" });
    const results = await search(user, "Make agent");
    await user.click(within(results).getByRole("button", { name }));
    await screen.findByRole("heading", { name });
    expect((screen.getByLabelText("Message your crew") as HTMLTextAreaElement).value).toBe(
      "Retain my draft",
    );
    cleanup();
    render(<App api={api} demo />);
    await screen.findByRole("heading", { name: "Recover interrupted work" });
    expect(screen.queryByRole("button", { name })).toBeNull();
    const reloadedResults = await search(user, "Make agent");
    await act(user, name, "Restore", reloadedResults);
    await waitFor(() =>
      expect(
        within(screen.getByRole("region", { name: "Pinned" })).getByRole("button", {
          name,
        }),
      ).toBeTruthy(),
    );
    expect((await api.threads("pitcrew")).find((item) => item.id === "welcome")?.archived).toBe(
      false,
    );
  });
  it("archives a nonselected repository thread and restores its independent pin without navigating", async () => {
    const user = userEvent.setup(),
      api = await mount();
    const title = "Explore an isolated change";
    const results = await search(user, "Explore");
    await user.click(within(results).getByRole("button", { name: `Pin conversation ${title}` }));
    await act(user, title, "Archive", results);
    await waitFor(() =>
      expect(
        within(screen.getByRole("region", { name: "Pinned" })).queryByRole("button", {
          name: title,
        }),
      ).toBeNull(),
    );
    expect(screen.getByRole("heading", { name: "Make agent work visible" })).toBeTruthy();
    await act(
      user,
      title,
      "Restore",
      screen.getByRole("region", { name: "Conversation search results" }),
    );
    await waitFor(() =>
      expect(
        within(screen.getByRole("region", { name: "Pinned" })).getByRole("button", {
          name: title,
        }),
      ).toBeTruthy(),
    );
    expect((await api.threads("playground"))[0].archived).toBe(false);
  });
  it("keeps rows and content on failure and permits an explicit repeated retry", async () => {
    const user = userEvent.setup(),
      api = createFixtureApi(),
      original = api.setThreadArchived!;
    const write = vi
      .fn()
      .mockRejectedValueOnce(Error("Archive failed. Try again."))
      .mockImplementation(original);
    api.setThreadArchived = write;
    await mount(api);
    const name = "Make agent work visible";
    await act(user, name, "Archive", screen.getByLabelText("Conversations in Pitcrew"));
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      expect.stringContaining("Archive failed"),
    );
    expect(screen.getByRole("button", { name })).toBeTruthy();
    expect(
      screen.getByText("Show the work behind a change, from delegation to review."),
    ).toBeTruthy();
    await act(user, name, "Archive", screen.getByLabelText("Conversations in Pitcrew"));
    await waitFor(() => expect(screen.queryByRole("button", { name })).toBeNull());
    expect(write.mock.calls).toEqual([
      ["pitcrew", "welcome", true],
      ["pitcrew", "welcome", true],
    ]);
  });
  it("does not select archived threads on initial load when every thread is archived", async () => {
    const api = createFixtureApi();
    for (const item of await api.threads("pitcrew"))
      await api.setThreadArchived!("pitcrew", item.id, true);
    render(<App api={api} demo />);
    await screen.findByRole("heading", { name: "A place for every change" });
    expect(screen.queryByRole("button", { name: "Make agent work visible" })).toBeNull();
    const user = userEvent.setup(),
      results = await search(user, "Make agent");
    await act(user, "Make agent work visible", "Restore", results);
    await user.click(within(results).getByRole("button", { name: "Make agent work visible" }));
    await screen.findByText("Show the work behind a change, from delegation to review.");
  });
});
