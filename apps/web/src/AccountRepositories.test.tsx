import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { AccountRepositories } from "./AccountRepositories";
import { ApiError, type CollaborationApi, type RepositoryCreation } from "./api";
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
} as const;

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

const approvedName = "account-approved-empty";
const readyCreation: RepositoryCreation = {
  name: approvedName,
  repositoryId: "immutable-empty-1",
  projectId: "empty-project-1",
  status: "ready",
};
function creationApi(creations: RepositoryCreation[] = []) {
  return {
    repositories: vi.fn().mockResolvedValue([]),
    repositoryCreations: vi.fn().mockResolvedValue({ approval: { name: approvedName }, creations }),
    createRepository: vi.fn().mockResolvedValue(readyCreation),
  } as unknown as CollaborationApi;
}

it("creates only the discovered approved repository on explicit action and refreshes directories only when ready", async () => {
  const api = creationApi();
  vi.mocked(api.repositories)
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([
      { ...repository, projectId: readyCreation.projectId!, name: approvedName },
    ]);
  vi.mocked(api.repositoryCreations!)
    .mockResolvedValueOnce({ approval: { name: approvedName }, creations: [] })
    .mockResolvedValueOnce({ approval: null, creations: [readyCreation] });
  let resolve!: (result: RepositoryCreation) => void;
  vi.mocked(api.createRepository!).mockReturnValue(
    new Promise((complete) => {
      resolve = complete;
    }),
  );
  const onAdopted = vi.fn();
  const user = userEvent.setup();
  render(<AccountRepositories api={api} onAdopted={onAdopted} />);
  const button = await screen.findByRole("button", { name: "Create repository" });
  expect(button).toHaveProperty("disabled", false);
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(screen.queryByRole("checkbox")).toBeNull();
  expect(screen.queryByText(/creates no code/i)).toBeNull();
  expect(api.createRepository).not.toHaveBeenCalled();
  fireEvent.click(button);
  fireEvent.click(button);
  expect(api.createRepository).toHaveBeenCalledExactlyOnceWith(approvedName, true);
  expect(screen.getByRole("button", { name: "Refresh" })).toHaveProperty("disabled", true);
  expect(onAdopted).not.toHaveBeenCalled();
  await act(async () => resolve(readyCreation));
  expect(await screen.findByText("owner")).toBeTruthy();
  expect(onAdopted).toHaveBeenCalledOnce();
  expect(api.repositories).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("button", { name: "Create repository" })).toBeNull();
});

it("keeps pending creation visible without resubmitting and refreshes Work only after registration is confirmed", async () => {
  const api = creationApi();
  vi.mocked(api.createRepository!).mockResolvedValue({ name: approvedName, status: "pending" });
  vi.mocked(api.repositoryCreations!)
    .mockResolvedValueOnce({ approval: { name: approvedName }, creations: [] })
    .mockResolvedValueOnce({ approval: { name: approvedName }, creations: [readyCreation] });
  const onAdopted = vi.fn();
  const user = userEvent.setup();
  render(<AccountRepositories api={api} onAdopted={onAdopted} />);
  await screen.findByRole("button", { name: "Create repository" });
  await user.click(screen.getByRole("button", { name: "Create repository" }));
  expect(await screen.findByText(/Creation is pending or its result is unknown/)).toBeTruthy();
  expect(onAdopted).not.toHaveBeenCalled();
  expect(screen.queryByRole("checkbox")).toBeNull();
  expect(screen.queryByRole("button", { name: "Recover repository creation" })).toBeNull();
  expect(api.repositoryCreations).toHaveBeenCalledOnce();
  await user.click(screen.getByRole("button", { name: "Refresh" }));
  await screen.findByText(/ready and registered to this account/);
  expect(onAdopted).toHaveBeenCalledOnce();
  expect(api.createRepository).toHaveBeenCalledOnce();
});

it.each(["cleanup_required", "registration_required"] as const)(
  "recovers only the exact managed %s record with renewed consent",
  async (status) => {
    const api = creationApi([
      { name: approvedName, repositoryId: readyCreation.repositoryId, status },
    ]);
    const user = userEvent.setup();
    render(<AccountRepositories api={api} />);
    const button = await screen.findByRole("button", { name: "Recover repository creation" });
    expect(screen.queryByRole("button", { name: "Create repository" })).toBeNull();
    expect(button).toHaveProperty("disabled", true);
    await user.click(screen.getByRole("checkbox"));
    await user.click(button);
    await waitFor(() =>
      expect(api.createRepository).toHaveBeenCalledExactlyOnceWith(approvedName, true),
    );
  },
);

it("keeps an unknown creation outcome blocked until discovery finds its managed record, and never displays error details", async () => {
  const api = creationApi();
  vi.mocked(api.createRepository!).mockRejectedValue(new Error("secret provider diagnostic"));
  const onAdopted = vi.fn();
  const user = userEvent.setup();
  render(<AccountRepositories api={api} onAdopted={onAdopted} />);
  await screen.findByRole("button", { name: "Create repository" });
  await user.click(screen.getByRole("button", { name: "Create repository" }));
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    expect.stringContaining("creation result is unknown"),
  );
  expect(screen.queryByText(/secret provider/)).toBeNull();
  expect(screen.queryByRole("button", { name: "Create repository" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Refresh" }));
  await screen.findByText(/creation result for account-approved-empty is unknown/);
  expect(api.createRepository).toHaveBeenCalledOnce();
  expect(onAdopted).not.toHaveBeenCalled();
});

it("keeps creation discovery failure separate from registered repositories and requires fresh approval", async () => {
  const api = creationApi();
  vi.mocked(api.repositories).mockResolvedValue([repository]);
  vi.mocked(api.repositoryCreations!)
    .mockRejectedValueOnce(new ApiError(0))
    .mockResolvedValue({ approval: { name: approvedName }, creations: [] });
  const user = userEvent.setup();
  render(<AccountRepositories api={api} />);
  await screen.findByText("owner");
  expect(screen.getByRole("alert").textContent).toContain(
    "Could not check repository creation status",
  );
  expect(screen.queryByRole("button", { name: "Create repository" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Refresh" }));
  await screen.findByRole("button", { name: "Create repository" });
  await user.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Create repository" })).toHaveProperty(
      "disabled",
      false,
    ),
  );
  expect(screen.queryByRole("checkbox")).toBeNull();
  expect(api.createRepository).not.toHaveBeenCalled();
});

it.each(["unmount", "account change", "API change"])(
  "ignores creation completion after %s",
  async (change) => {
    const api = creationApi();
    let resolve!: (result: RepositoryCreation) => void;
    vi.mocked(api.createRepository!).mockReturnValue(
      new Promise((complete) => {
        resolve = complete;
      }),
    );
    const onAdopted = vi.fn();
    const user = userEvent.setup();
    const view = render(
      <AccountRepositories key="first-account" api={api} onAdopted={onAdopted} />,
    );
    await screen.findByRole("button", { name: "Create repository" });
    await user.click(screen.getByRole("button", { name: "Create repository" }));
    if (change === "unmount") view.unmount();
    else {
      view.rerender(
        <AccountRepositories
          key={change === "account change" ? "second-account" : "first-account"}
          api={creationApi()}
          onAdopted={onAdopted}
        />,
      );
      await screen.findByRole("button", { name: "Create repository" });
    }
    await act(async () => resolve(readyCreation));
    await waitFor(() => expect(api.createRepository).toHaveBeenCalledOnce());
    expect(onAdopted).not.toHaveBeenCalled();
    expect(api.repositories).toHaveBeenCalledOnce();
    expect(screen.queryByText(/is ready in your repositories/)).toBeNull();
  },
);

it("offers no creation form when this account has no approval", async () => {
  const api = creationApi();
  vi.mocked(api.repositoryCreations!).mockResolvedValue({ approval: null, creations: [] });
  render(<AccountRepositories api={api} />);
  await screen.findByText("No repositories belong to this account yet.");
  expect(screen.queryByRole("checkbox")).toBeNull();
  expect(api.createRepository).not.toHaveBeenCalled();
});

it("ignores late approval discovery from the previous account", async () => {
  const oldApi = creationApi();
  let resolve!: (result: { approval: { name: string }; creations: RepositoryCreation[] }) => void;
  vi.mocked(oldApi.repositoryCreations!).mockReturnValue(
    new Promise((complete) => {
      resolve = complete;
    }),
  );
  const newApi = creationApi();
  vi.mocked(newApi.repositoryCreations!).mockResolvedValue({ approval: null, creations: [] });
  const onAdopted = vi.fn();
  const view = render(<AccountRepositories key="old" api={oldApi} onAdopted={onAdopted} />);
  view.rerender(<AccountRepositories key="new" api={newApi} onAdopted={onAdopted} />);
  await screen.findByText("No repositories belong to this account yet.");
  await act(async () => resolve({ approval: { name: approvedName }, creations: [readyCreation] }));
  expect(screen.queryByText(approvedName)).toBeNull();
  expect(screen.queryByRole("checkbox")).toBeNull();
  expect(onAdopted).not.toHaveBeenCalled();
});

it("requires a fresh approval read after creation rejection before allowing another explicit create", async () => {
  const api = creationApi();
  vi.mocked(api.createRepository!)
    .mockRejectedValueOnce(new ApiError(403))
    .mockResolvedValueOnce(readyCreation);
  const user = userEvent.setup();
  render(<AccountRepositories api={api} />);
  await screen.findByRole("button", { name: "Create repository" });
  await user.click(screen.getByRole("button", { name: "Create repository" }));
  await screen.findByRole("alert");
  expect(screen.getByRole("button", { name: "Create repository" })).toHaveProperty(
    "disabled",
    true,
  );
  await user.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Create repository" })).toHaveProperty(
      "disabled",
      false,
    ),
  );
  expect(screen.queryByRole("checkbox")).toBeNull();
  expect(api.createRepository).toHaveBeenCalledOnce();
});

it("quarantines a recovery result that changes the managed immutable repository ID", async () => {
  const api = creationApi([
    { name: approvedName, repositoryId: "original-immutable-id", status: "cleanup_required" },
  ]);
  const onAdopted = vi.fn();
  const user = userEvent.setup();
  render(<AccountRepositories api={api} onAdopted={onAdopted} />);
  await screen.findByRole("checkbox");
  await user.click(screen.getByRole("checkbox"));
  await user.click(screen.getByRole("button", { name: "Recover repository creation" }));
  await screen.findByRole("alert");
  expect(onAdopted).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Recover repository creation" })).toHaveProperty(
    "disabled",
    true,
  );
  expect(screen.queryByText(/ready and registered/)).toBeNull();
});
