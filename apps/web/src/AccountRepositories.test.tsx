import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { AccountRepositories } from "./AccountRepositories";
import type { CollaborationApi } from "./api";
afterEach(cleanup);
it("shows only account-scoped repositories and an honest empty state", async () => {
  const repositories = vi
    .fn()
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([
      {
        projectId: "repo-1",
        status: "present",
        lifecycle: "registered",
        deletable: false,
        name: "Shared empty repo",
        role: "editor",
      },
    ]);
  const api = { repositories } as unknown as CollaborationApi;
  const user = userEvent.setup();
  render(<AccountRepositories api={api} />);
  expect(await screen.findByText("No repositories belong to this account yet.")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Refresh" }));
  expect(await screen.findByText("Shared empty repo")).toBeTruthy();
  expect(screen.getByText("editor")).toBeTruthy();
});
