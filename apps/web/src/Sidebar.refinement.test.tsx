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

it("persists independent Pinned and Repositories folders through selection and reload", async () => {
  const user = userEvent.setup();
  const api = createFixtureApi();
  const mountApp = () => render(<App api={api} demo />);
  const folder = (pinned: boolean) => within(screen.getByRole(pinned ? "region" : "navigation", {
    name: pinned ? "Pinned" : "Repositories",
  })).getByRole("button", { name: "Pitcrew · lilfrogdev/pitcrew" });
  mountApp();
  await screen.findByRole("heading", { name: "Make agent work visible" });
  await user.type(screen.getByLabelText("Message your crew"), "Keep this draft");
  await user.click(screen.getByRole("button", { name: "Pin conversation Make agent work visible" }));
  await user.click(folder(false));
  expect(folder(false).getAttribute("aria-expanded")).toBe("false");
  expect(folder(true).getAttribute("aria-expanded")).toBe("true");
  await user.click(within(screen.getByRole("region", { name: "Pinned" })).getByRole("button", {
    name: "Make agent work visible",
  }));
  expect(folder(false).getAttribute("aria-expanded")).toBe("false");
  expect((screen.getByLabelText("Message your crew") as HTMLTextAreaElement).value).toBe("Keep this draft");
  await user.click(folder(true));
  await user.click(folder(false));
  expect(folder(false).getAttribute("aria-expanded")).toBe("true");
  expect(folder(true).getAttribute("aria-expanded")).toBe("false");
  cleanup(); mountApp();
  await screen.findByRole("heading", { name: "Make agent work visible" });
  expect(folder(false).getAttribute("aria-expanded")).toBe("true");
  expect(folder(true).getAttribute("aria-expanded")).toBe("false");
  await user.click(folder(false));
  await user.click(folder(true));
  expect(folder(false).getAttribute("aria-expanded")).toBe("false");
  expect(folder(true).getAttribute("aria-expanded")).toBe("true");
  await user.click(screen.getByRole("button", { name: "Playground · synthetic/example" }));
  await screen.findByRole("heading", { name: "Explore an isolated change" });
  expect(folder(false).getAttribute("aria-expanded")).toBe("false");
  await user.click(within(screen.getByRole("region", { name: "Pinned" })).getByRole("button", { name: "Make agent work visible" }));
  await screen.findByRole("heading", { name: "Make agent work visible" });
  expect(folder(false).getAttribute("aria-expanded")).toBe("false");
  cleanup(); mountApp();
  await screen.findByRole("heading", { name: "Make agent work visible" });
  expect(folder(false).getAttribute("aria-expanded")).toBe("false");
  expect(folder(true).getAttribute("aria-expanded")).toBe("true");
  const pinned = screen.getByRole("region", { name: "Pinned" });
  await user.click(within(pinned).getByRole("button", { name: "New conversation in Pitcrew" }));
  expect(within(pinned).getByLabelText("Conversation title")).toBeTruthy();
  expect(screen.getAllByLabelText("Conversation title")).toHaveLength(1);
  expect(folder(false).getAttribute("aria-expanded")).toBe("false");
  await user.type(within(pinned).getByLabelText("Conversation title"), "Keep pending title");
  await user.click(within(pinned).getByRole("button", { name: "Unpin conversation Make agent work visible" }));
  expect((within(pinned).getByLabelText("Conversation title") as HTMLInputElement).value).toBe("Keep pending title");
  await user.click(within(pinned).getByRole("button", { name: "Cancel" }));
});

it("isolates expansion and pins between accounts sharing the same repository ID", async () => {
  const user = userEvent.setup(), api = createFixtureApi();
  const viewer = (id: string) => ({ id, email: `${id}@example.com`, emailVerified: true,
    name: id, username: id, image: null });
  const view = render(<App api={api} demo viewer={viewer("owner")} />);
  await screen.findByRole("heading", { name: "Make agent work visible" });
  await user.click(screen.getByRole("button", { name: "Pin conversation Make agent work visible" }));
  await user.click(within(screen.getByRole("navigation", { name: "Repositories" })).getByRole("button", { name: "Pitcrew · lilfrogdev/pitcrew" }));
  view.rerender(<App api={api} demo viewer={viewer("bryan")} />);
  expect(within(screen.getByRole("region", { name: "Pinned" })).queryAllByRole("button")).toHaveLength(0);
  expect(screen.getByRole("button", { name: "Pitcrew · lilfrogdev/pitcrew" }).getAttribute("aria-expanded")).toBe("true");
  view.rerender(<App api={api} demo viewer={viewer("owner")} />);
  expect(within(screen.getByRole("navigation", { name: "Repositories" })).getByRole("button", { name: "Pitcrew · lilfrogdev/pitcrew" }).getAttribute("aria-expanded")).toBe("false");
  expect(within(screen.getByRole("region", { name: "Pinned" })).getByRole("button", { name: "Make agent work visible" })).toBeTruthy();
});
