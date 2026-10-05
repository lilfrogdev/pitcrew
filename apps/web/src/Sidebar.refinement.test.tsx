import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { Sidebar } from "./Sidebar";
import { ConversationTitle } from "./ConversationTitle";
import { createFixtureApi } from "./fixtures";
import type { Run } from "./api";
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});
function mount(run?: Run) {
  render(
    <Sidebar
      api={createFixtureApi()}
      projects={[
        {
          id: "p",
          name: "Project",
          repository: "owner/project",
          baseSha: "base",
          configurationRevision: "v1",
        },
      ]}
      projectId="p"
      threads={[{ id: "t", projectId: "p", title: "Conversation" }]}
      threadId="t"
      revision={0}
      busy={false}
      activeRun={run}
      onSelect={() => {}}
      onCreate={() => {}}
    />,
  );
}
it("selects the entire row and does not invent completion for an idle conversation", () => {
  mount();
  expect(
    screen
      .getByRole("button", { name: "Conversation" })
      .closest(".sidebar-row")
      ?.classList.contains("selected"),
  ).toBe(true);
  expect(screen.queryByRole("img")).toBeNull();
});
it.each(["execution_unavailable", "execution_failed", "reconciliation_required"] as const)(
  "shows an action alert for %s rather than a completion check",
  (error) => {
    mount({
      id: "r",
      threadId: "t",
      status: "completed",
      baseSha: "base",
      configurationRevision: "v1",
      error,
    });
    expect(screen.queryByRole("img", { name: "Completed" })).toBeNull();
    expect(screen.getByRole("img").querySelector(".tabler-icon-alert-circle")).toBeTruthy();
    expect(screen.queryByRole("img")?.querySelector(".working-spinner")).toBeNull();
  },
);
it("measures the complete overflow and resets the travel for a title that fits", () => {
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(420);
  const width = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(120);
  const view = render(<ConversationTitle title="A long title" />);
  expect(
    screen.getByText("A long title").parentElement?.style.getPropertyValue("--title-travel"),
  ).toBe("-300px");
  width.mockReturnValue(450);
  view.rerender(<ConversationTitle title="Short" />);
  expect(screen.getByText("Short").parentElement?.style.getPropertyValue("--title-travel")).toBe(
    "0px",
  );
});

it("persists folder collapse in pinned and normal groups while retaining selection and draft", async () => {
  const user = userEvent.setup();
  const mountApp = () => render(<App api={createFixtureApi()} demo />);
  mountApp();
  await screen.findByRole("heading", { name: "Make agent work visible" });
  await user.type(screen.getByLabelText("Message your crew"), "Keep this draft");
  await user.click(
    screen.getByRole("button", { name: "Pin conversation Make agent work visible" }),
  );
  const nav = screen.getByRole("navigation", { name: "Repositories" });
  const folder = within(nav).getByRole("button", { name: "Pitcrew · lilfrogdev/pitcrew" });
  expect(folder.getAttribute("aria-expanded")).toBe("true");
  expect(folder.querySelector(".tabler-icon-folder-open")).toBeTruthy();
  await user.click(folder);
  expect(folder.getAttribute("aria-expanded")).toBe("false");
  expect(folder.querySelector(".tabler-icon-folder")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Make agent work visible" })).toBeNull();
  expect((screen.getByLabelText("Message your crew") as HTMLTextAreaElement).value).toBe(
    "Keep this draft",
  );
  expect(screen.getByRole("heading", { name: "Make agent work visible" })).toBeTruthy();
  expect(JSON.parse(localStorage.getItem("pitcrew.sidebar.collapsed.v1")!).pitcrew).toBe(true);
  cleanup();
  mountApp();
  await screen.findByRole("heading", { name: "Make agent work visible" });
  const pinnedFolder = within(screen.getByRole("region", { name: "Pinned" })).getByRole("button", {
    name: "Pitcrew · lilfrogdev/pitcrew",
  });
  expect(pinnedFolder.getAttribute("aria-expanded")).toBe("false");
  await user.click(pinnedFolder);
  expect(pinnedFolder.getAttribute("aria-expanded")).toBe("true");
  expect(
    within(screen.getByLabelText("Pinned conversations in Pitcrew")).getByRole("button", {
      name: "Make agent work visible",
    }),
  ).toBeTruthy();
  expect(
    within(screen.getByRole("navigation", { name: "Repositories" }))
      .getByRole("button", { name: "Pitcrew · lilfrogdev/pitcrew" })
      .getAttribute("aria-expanded"),
  ).toBe("true");
});
