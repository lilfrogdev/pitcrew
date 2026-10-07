import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { AccountRepositories } from "./AccountRepositories";
import { ApiError, type CollaborationApi } from "./api";
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
  expect(screen.getByText(/ask the operator to approve an existing repository/i)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Add approved repository" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Refresh" }));
  expect(await screen.findByText("Shared empty repo")).toBeTruthy();
  expect(screen.getByText("editor")).toBeTruthy();
});

const candidate = { name: "exact-approved-repo", repositoryId: "immutable-repo-123" };
const project = {
  id: "project-1",
  name: candidate.name,
  repository: candidate.repositoryId,
  baseSha: "base",
  configurationRevision: "v1",
};
const repository = {
  projectId: project.id,
  name: project.name,
  role: "owner",
  status: "present",
  lifecycle: "registered",
  deletable: false,
};

it("shows only the exact approved target, requires confirmation, and refreshes both directories after adoption", async () => {
  const repositories = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([repository]);
  const approvedProjectAdoptions = vi
    .fn()
    .mockResolvedValueOnce([candidate])
    .mockResolvedValueOnce([]);
  const adoptProject = vi.fn().mockResolvedValue(project);
  const onAdopted = vi.fn();
  const api = {
    repositories,
    approvedProjectAdoptions,
    adoptProject,
  } as unknown as CollaborationApi;
  const user = userEvent.setup();
  render(<AccountRepositories api={api} onAdopted={onAdopted} />);
  await screen.findByText(candidate.repositoryId);
  expect(screen.getByText(candidate.name)).toBeTruthy();
  const button = screen.getByRole("button", { name: "Add approved repository" });
  expect(button).toHaveProperty("disabled", true);
  await user.click(button);
  expect(adoptProject).not.toHaveBeenCalled();
  await user.click(screen.getByRole("checkbox", { name: /I confirm adding exact-approved-repo/ }));
  await user.click(button);
  expect(adoptProject).toHaveBeenCalledExactlyOnceWith(candidate.name, candidate.repositoryId);
  expect(await screen.findByText("owner")).toBeTruthy();
  expect(screen.getByRole("status").textContent).toContain("was added");
  expect(screen.queryByRole("checkbox")).toBeNull();
  expect(repositories).toHaveBeenCalledTimes(2);
  expect(approvedProjectAdoptions).toHaveBeenCalledTimes(2);
  expect(onAdopted).toHaveBeenCalledOnce();
});

it.each([
  [
    403,
    "Repository approval is unavailable for this account. Ask the operator to check your approval, then refresh.",
  ],
  [409, "This repository approval changed. Refresh before trying again."],
  [0, "Could not add this repository. Try again or refresh to check your approval."],
])(
  "blocks duplicate writes and other targets while busy, then allows a confirmed retry after error %s",
  async (status, message) => {
    let reject!: (error: unknown) => void;
    const first = new Promise((_, rejectPromise) => {
      reject = rejectPromise;
    });
    const adoptProject = vi.fn().mockReturnValueOnce(first).mockResolvedValueOnce(project);
    const api = {
      repositories: vi.fn().mockResolvedValue([]),
      approvedProjectAdoptions: vi
        .fn()
        .mockResolvedValue([candidate, { name: "second", repositoryId: "second-id" }]),
      adoptProject,
    } as unknown as CollaborationApi;
    const user = userEvent.setup();
    const onAdopted = vi.fn();
    render(<AccountRepositories api={api} onAdopted={onAdopted} />);
    await screen.findByText(candidate.repositoryId);
    for (const checkbox of screen.getAllByRole("checkbox")) await user.click(checkbox);
    const buttons = screen.getAllByRole("button", { name: "Add approved repository" });
    fireEvent.click(buttons[0]);
    fireEvent.click(buttons[0]);
    fireEvent.click(buttons[1]);
    expect(adoptProject).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Refresh" })).toHaveProperty("disabled", true);
    for (const checkbox of screen.getAllByRole("checkbox"))
      expect(checkbox).toHaveProperty("disabled", true);
    reject(new ApiError(Number(status)));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", message);
    expect(onAdopted).not.toHaveBeenCalled();
    for (const button of screen.getAllByRole("button", { name: "Add approved repository" }))
      expect(button).toHaveProperty("disabled", true);
    await user.click(
      screen.getByRole("checkbox", { name: /I confirm adding exact-approved-repo/ }),
    );
    await user.click(screen.getAllByRole("button", { name: "Add approved repository" })[0]);
    await waitFor(() => expect(onAdopted).toHaveBeenCalledOnce());
    expect(adoptProject).toHaveBeenCalledTimes(2);
    expect(
      screen.queryByRole("checkbox", { name: /I confirm adding exact-approved-repo/ }),
    ).toBeNull();
  },
);

it("keeps approval read failures separate from an existing repository directory and offers refresh", async () => {
  const approvedProjectAdoptions = vi
    .fn()
    .mockRejectedValueOnce(new ApiError(0))
    .mockResolvedValueOnce([candidate]);
  const api = {
    repositories: vi.fn().mockResolvedValue([repository]),
    approvedProjectAdoptions,
    adoptProject: vi.fn(),
  } as unknown as CollaborationApi;
  const user = userEvent.setup();
  render(<AccountRepositories api={api} />);
  expect(await screen.findByText("owner")).toBeTruthy();
  expect(screen.getByRole("alert").textContent).toContain("Could not check repository approvals");
  expect(screen.queryByRole("button", { name: "Add approved repository" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Refresh" }));
  await screen.findByText(candidate.repositoryId);
  expect(screen.queryByRole("alert")).toBeNull();
});

it("does not submit an adoption when the approval list is empty", async () => {
  const adoptProject = vi.fn();
  const api = {
    repositories: vi.fn().mockResolvedValue([]),
    approvedProjectAdoptions: vi.fn().mockResolvedValue([]),
    adoptProject,
  } as unknown as CollaborationApi;
  render(<AccountRepositories api={api} />);
  await screen.findByText("No repositories belong to this account yet.");
  expect(screen.queryByRole("checkbox")).toBeNull();
  expect(screen.queryByRole("button", { name: "Add approved repository" })).toBeNull();
  expect(adoptProject).not.toHaveBeenCalled();
});
