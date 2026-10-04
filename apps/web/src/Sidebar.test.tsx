import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { StrictMode } from "react";
import { App } from "./App";
import { createFixtureApi } from "./fixtures";
import { Sidebar } from "./Sidebar";
import type { Run } from "./api";

afterEach(() => {
  cleanup();
  localStorage.clear();
});
const key = "pitcrew.sidebar.pins.v1";
async function mount() {
  render(
    <StrictMode>
      <App api={createFixtureApi()} demo />
    </StrictMode>,
  );
  await screen.findByRole("heading", { name: "Make agent work visible" });
}
describe("repository sidebar", () => {
  it("nests conversations, removes refresh, and searches known repositories", async () => {
    const user = userEvent.setup();
    await mount();
    const sidebar = screen.getByLabelText("Repositories and conversations");
    expect(within(sidebar).queryByRole("button", { name: "Reconnect and refresh" })).toBeNull();
    expect(
      within(screen.getByLabelText("Conversations in Pitcrew")).getByRole("button", {
        name: "Make agent work visible",
      }),
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Search repositories" }));
    const search = screen.getByRole("textbox", { name: "Search repositories" });
    await user.type(search, " SYNTHETIC ");
    expect(screen.queryByRole("button", { name: "Pitcrew · lilfrogdev/pitcrew" })).toBeNull();
    expect(screen.getByRole("button", { name: "Playground · synthetic/example" })).toBeTruthy();
    await user.clear(search);
    await user.type(search, "missing");
    expect(screen.getByText("No repositories found.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Clear repository search" }));
    expect(screen.getByRole("button", { name: "Pitcrew · lilfrogdev/pitcrew" })).toBeTruthy();
    fireEvent.keyDown(search, { key: "Escape" });
    expect(screen.queryByRole("textbox", { name: "Search repositories" })).toBeNull();
  });
  it("persists repository and conversation pins, navigates across repositories, and unpins", async () => {
    const user = userEvent.setup();
    await mount();
    await user.click(screen.getByRole("button", { name: "Pin repository Pitcrew" }));
    await user.click(
      screen.getByRole("button", { name: "Pin conversation Recover interrupted work" }),
    );
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual({
      repositories: ["pitcrew"],
      conversations: ["recovery"],
      conversationRepositories: { recovery: "pitcrew" },
    });
    cleanup();
    await mount();
    const pinned = screen.getByRole("region", { name: "Pinned" });
    expect(
      within(pinned).getByRole("button", { name: "Pitcrew · lilfrogdev/pitcrew" }),
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Playground · synthetic/example" }));
    await screen.findByRole("heading", { name: "Explore an isolated change" });
    await user.click(
      await within(pinned).findByRole("button", { name: "Recover interrupted work" }),
    );
    await screen.findByRole("heading", { name: "Recover interrupted work" });
    await user.click(
      within(pinned).getByRole("button", { name: "Unpin conversation Recover interrupted work" }),
    );
    await user.click(within(pinned).getByRole("button", { name: "Unpin repository Pitcrew" }));
    expect(within(pinned).queryAllByRole("button")).toHaveLength(0);
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual({
      repositories: [],
      conversations: [],
      conversationRepositories: {},
    });
  });
  it("groups child pins, preserves their parent through repeated unpins and reload, and retains manual pins", async () => {
    const user = userEvent.setup();
    await mount();
    const nav = screen.getByRole("navigation", { name: "Repositories" });
    await user.click(
      within(nav).getByRole("button", { name: "Pin conversation Make agent work visible" }),
    );
    await user.click(
      within(nav).getByRole("button", { name: "Pin conversation Recover interrupted work" }),
    );
    let pinned = screen.getByRole("region", { name: "Pinned" });
    const group = within(pinned).getByLabelText("Pinned conversations in Pitcrew");
    expect(within(group).getByRole("button", { name: "Make agent work visible" })).toBeTruthy();
    expect(within(group).getByRole("button", { name: "Recover interrupted work" })).toBeTruthy();
    expect(
      within(pinned).getAllByRole("button", { name: "Pitcrew · lilfrogdev/pitcrew" }),
    ).toHaveLength(1);
    await user.click(within(pinned).getByRole("button", { name: "Unpin repository Pitcrew" }));
    await user.click(within(pinned).getByRole("button", { name: "Unpin repository Pitcrew" }));
    cleanup();
    await mount();
    pinned = screen.getByRole("region", { name: "Pinned" });
    await user.click(
      within(pinned).getByRole("button", { name: "Unpin conversation Make agent work visible" }),
    );
    expect(within(pinned).getByRole("button", { name: "Recover interrupted work" })).toBeTruthy();
    await user.click(
      within(pinned).getByRole("button", { name: "Unpin conversation Recover interrupted work" }),
    );
    expect(within(pinned).queryAllByRole("button")).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Pin repository Pitcrew" }));
    await user.click(
      screen.getByRole("button", { name: "Pin conversation Recover interrupted work" }),
    );
    await user.click(
      within(pinned).getByRole("button", { name: "Unpin conversation Recover interrupted work" }),
    );
    expect(
      within(pinned).getByRole("button", { name: "Pitcrew · lilfrogdev/pitcrew" }),
    ).toBeTruthy();
  });
  it("migrates legacy child pins when metadata arrives and preserves unresolved intent", async () => {
    localStorage.setItem(
      key,
      JSON.stringify({ repositories: [], conversations: ["recovery", "deleted"] }),
    );
    await mount();
    const group = screen.getByLabelText("Pinned conversations in Pitcrew");
    expect(within(group).getByRole("button", { name: "Recover interrupted work" })).toBeTruthy();
    await waitFor(() =>
      expect(JSON.parse(localStorage.getItem(key)!)).toEqual({
        repositories: [],
        conversations: ["recovery", "deleted"],
        conversationRepositories: { recovery: "pitcrew" },
      }),
    );
    cleanup();
    await mount();
    expect(
      within(screen.getByLabelText("Pinned conversations in Pitcrew")).getByRole("button", {
        name: "Recover interrupted work",
      }),
    ).toBeTruthy();
  });
  it("ignores stale IDs and deduplicates stored pins without resurrecting data", async () => {
    localStorage.setItem(
      key,
      JSON.stringify({
        repositories: ["missing", "pitcrew", "pitcrew"],
        conversations: ["deleted", "welcome", "welcome"],
      }),
    );
    await mount();
    const pinned = screen.getByRole("region", { name: "Pinned" });
    expect(
      within(pinned).getAllByRole("button", { name: "Pitcrew · lilfrogdev/pitcrew" }),
    ).toHaveLength(1);
    expect(within(pinned).getAllByRole("button", { name: "Make agent work visible" })).toHaveLength(
      1,
    );
    expect(within(pinned).queryByText("missing")).toBeNull();
    expect(within(pinned).queryByText("deleted")).toBeNull();
  });
  it("opens the repository-specific create form and an honest notification state", async () => {
    const user = userEvent.setup();
    await mount();
    await user.click(screen.getByRole("button", { name: "Notifications" }));
    expect(screen.getByText("Mention notifications aren’t available yet.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "New conversation in Playground" }));
    await screen.findByRole("heading", { name: "Explore an isolated change" });
    await user.type(screen.getByLabelText("Conversation title"), "A repository conversation");
    await user.click(screen.getByRole("button", { name: "Create" }));
    await screen.findByRole("heading", { name: "A repository conversation" });
    expect(
      within(screen.getByLabelText("Conversations in Playground")).getByRole("button", {
        name: "A repository conversation",
      }),
    ).toBeTruthy();
  });
  it.each([
    ["running", "In progress"],
    ["queued", "Queued"],
    ["waiting_user", "Needs your attention"],
    ["awaiting_review", "Awaiting review"],
    ["completed", "Completed"],
    ["failed", "Failed"],
    ["stopped", "Stopped"],
  ] as const)("maps real %s state without inventing merged or question states", (status, label) => {
    render(
      <Sidebar
        api={createFixtureApi()}
        projects={[
          {
            id: "repo",
            name: "Repo",
            repository: "owner/repo",
            baseSha: "base",
            configurationRevision: "v1",
          },
        ]}
        projectId="repo"
        threads={[{ id: "thread", projectId: "repo", title: "Long conversation title" }]}
        threadId="thread"
        revision={0}
        busy={false}
        activeRun={{ id: "run", threadId: "thread", status } as Run}
        onSelect={() => {}}
        onCreate={() => {}}
      />,
    );
    const indicator = screen.getByRole("img", { name: label });
    expect(indicator.querySelector("svg")).toBeTruthy();
    expect(indicator.textContent).toBe("");
    expect(indicator.querySelector(".working-spinner") !== null).toBe(status === "running");
    expect(screen.queryByRole("img", { name: "Merged" })).toBeNull();
    if (status === "awaiting_review")
      expect(screen.queryByRole("img", { name: "Needs your attention" })).toBeNull();
  });
});
