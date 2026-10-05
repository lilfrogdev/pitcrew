import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { App } from "./App";
import { createFixtureApi } from "./fixtures";
afterEach(() => {
  cleanup();
  localStorage.clear();
});
it("keeps the selected conversation and draft mounted across placeholder sections without writes", async () => {
  const api = createFixtureApi();
  api.send = vi.fn(api.send);
  api.createThread = vi.fn(api.createThread);
  const user = userEvent.setup();
  render(<App api={api} demo />);
  await screen.findByRole("heading", { name: "Make agent work visible" });
  await user.click(screen.getByRole("button", { name: "Recover interrupted work" }));
  await screen.findByText(/Worker execution stopped/);
  const composer = screen.getByLabelText("Message your crew") as HTMLTextAreaElement;
  await user.type(composer, "Keep this unfinished change");
  const rail = screen.getByRole("navigation", { name: "Workspace" });
  for (const name of ["Repositories", "Tickets", "Account"]) {
    await user.click(within(rail).getByRole("button", { name }));
    expect(screen.getByRole("heading", { name, level: 1 })).toBeTruthy();
    expect(screen.getByText("Coming soon")).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Message your crew" })).toBeNull();
    const active = within(rail).getByRole("button", { name });
    expect(active.getAttribute("aria-current")).toBe("page");
    expect(active.querySelector("svg")?.getAttribute("fill")).toBe("none");
    for (const inactive of within(rail)
      .getAllByRole("button")
      .filter((button) => button !== active))
      expect(inactive.querySelector("svg")?.getAttribute("fill")).toBe("none");
  }
  await user.click(within(rail).getByRole("button", { name: "Work" }));
  expect(screen.getByRole("heading", { name: "Recover interrupted work" })).toBeTruthy();
  expect(screen.getByLabelText("Message your crew")).toBe(composer);
  expect(composer.value).toBe("Keep this unfinished change");
  expect(
    within(rail).getByRole("button", { name: "Work" }).querySelector(".tabler-icon-home"),
  ).toBeTruthy();
  expect(api.send).not.toHaveBeenCalled();
  expect(api.createThread).not.toHaveBeenCalled();
});
it("preserves an unfinished new conversation form when leaving Work", async () => {
  const user = userEvent.setup();
  render(<App api={createFixtureApi()} demo />);
  await screen.findByRole("heading", { name: "Make agent work visible" });
  await user.click(screen.getByRole("button", { name: "New conversation in Pitcrew" }));
  const title = screen.getByLabelText("Conversation title") as HTMLInputElement;
  await user.type(title, "Unfinished title");
  const rail = screen.getByRole("navigation", { name: "Workspace" });
  await user.click(within(rail).getByRole("button", { name: "Tickets" }));
  await user.click(within(rail).getByRole("button", { name: "Work" }));
  expect(screen.getByLabelText("Conversation title")).toBe(title);
  expect(title.value).toBe("Unfinished title");
});
