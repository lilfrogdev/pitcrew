import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { AccountRepositories } from "./AccountRepositories";
import {
  ApiError,
  httpApi,
  type CollaborationApi,
  type CreatedInvitation,
  type SharedRepository,
} from "./api";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const repository: SharedRepository = {
  projectId: "project-one",
  name: "My display label",
  repositoryName: "physical-one",
  repositoryId: "immutable-one",
  description: "Existing description",
  metadataRevision: 3,
  role: "owner",
  status: "present",
  lifecycle: "registered",
  deletable: true,
};
const invitation = {
  id: "invitation-one",
  email: "guest@example.test",
  role: "editor" as const,
  scope: "project" as const,
  projectId: repository.projectId,
  expiresAt: "2099-01-01T00:00:00Z",
};
function managementApi() {
  const repositories = vi.fn().mockResolvedValue([repository]);
  return {
    repositories,
    repositoryCreations: vi.fn().mockResolvedValue({
      approval: null,
      creations: [],
      capabilities: { create: true, manage: true },
    }),
    createRepository: vi.fn().mockResolvedValue({ name: "new-physical", status: "pending" }),
    updateRepository: vi.fn().mockResolvedValue({
      id: repository.projectId,
      repository: `artifact:${repository.repositoryName}`,
    }),
    deleteRepository: vi.fn().mockImplementation(async () => {
      const deleting = {
        ...repository,
        status: "deleting",
        lifecycle: "deleting",
        deletable: false,
      };
      repositories.mockResolvedValue([deleting]);
      return deleting;
    }),
    repositoryStatus: vi.fn().mockResolvedValue({
      ...repository,
      status: "deleting",
      lifecycle: "deleting",
      deletable: false,
    }),
    projectMembers: vi.fn().mockResolvedValue([
      { actor: "account:owner", email: "owner@example.test", role: "owner" },
      { actor: "account:editor", email: "editor@example.test", role: "editor" },
    ]),
    projectInvitations: vi.fn().mockResolvedValue([invitation]),
    inviteProject: vi.fn().mockResolvedValue({
      token: "a".repeat(64),
      invitation: { ...invitation, id: "new-invitation" },
    }),
    revokeProjectInvitation: vi.fn().mockResolvedValue({ ...invitation, revokedAt: "2026-01-01" }),
    removeProjectMember: vi.fn().mockResolvedValue(undefined),
  } as unknown as CollaborationApi;
}
async function open(api: CollaborationApi) {
  const view = render(<AccountRepositories api={api} />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Manage repository" }));
  await screen.findByText("editor@example.test");
  return { user, view };
}
it("creates the selected permanent name with optional metadata only after consent", async () => {
  const api = managementApi();
  const user = userEvent.setup();
  render(<AccountRepositories api={api} />);
  const form = await screen.findByRole("form", { name: "Create repository" });
  await user.type(within(form).getByLabelText("Permanent repository name"), "Invalid_Name");
  await user.click(within(form).getByRole("checkbox"));
  expect(within(form).getByRole("button")).toHaveProperty("disabled", true);
  await user.clear(within(form).getByLabelText("Permanent repository name"));
  await user.type(within(form).getByLabelText("Permanent repository name"), "new-physical");
  await user.type(within(form).getByLabelText("Display name (optional)"), " Friendly name ");
  await user.type(within(form).getByLabelText("Description (optional)"), " A description ");
  expect(within(form).getByRole("button")).toHaveProperty("disabled", true);
  await user.click(within(form).getByRole("checkbox"));
  await user.click(within(form).getByRole("button"));
  expect(api.createRepository).toHaveBeenCalledExactlyOnceWith("new-physical", true, {
    displayName: "Friendly name",
    description: "A description",
  });
  expect(await screen.findByText(/Creation is pending/)).toBeTruthy();
  expect(api.createRepository).toHaveBeenCalledOnce();
});
it("gates all management controls on discovered capability and owner role", async () => {
  const api = managementApi();
  vi.mocked(api.repositories).mockResolvedValue([
    { ...repository, role: "editor", deletable: false },
  ]);
  render(<AccountRepositories api={api} />);
  await screen.findByText("My display label");
  expect(screen.queryByRole("button", { name: "Manage repository" })).toBeNull();
  expect(api.projectMembers).not.toHaveBeenCalled();
  cleanup();
  vi.mocked(api.repositories).mockResolvedValue([repository]);
  vi.mocked(api.repositoryCreations!).mockResolvedValue({
    approval: null,
    creations: [],
    capabilities: { create: false, manage: false },
  });
  render(<AccountRepositories api={api} />);
  await screen.findByText("My display label");
  expect(screen.queryByRole("button", { name: "Manage repository" })).toBeNull();
  expect(screen.queryByRole("form", { name: "Create repository" })).toBeNull();
});
it("saves only metadata with the discovered revision, without changing the physical target", async () => {
  const api = managementApi();
  const { user } = await open(api);
  await user.clear(screen.getByLabelText("Display name"));
  await user.type(screen.getByLabelText("Display name"), " New label ");
  await user.click(screen.getByRole("button", { name: "Save repository details" }));
  expect(api.updateRepository).toHaveBeenCalledExactlyOnceWith(repository.projectId, {
    displayName: "New label",
    description: "Existing description",
    expectedRevision: 3,
  });
  expect(api.deleteRepository).not.toHaveBeenCalled();
  await waitFor(() => expect(api.repositories).toHaveBeenCalledTimes(2));
});
it("requires the exact permanent name for deletion, and only recovers after a GET status check", async () => {
  const api = managementApi();
  const { user } = await open(api);
  await user.click(screen.getByRole("button", { name: "Review deletion" }));
  expect(screen.getByText(/permanently removes.*stored files and history/)).toBeTruthy();
  let confirmation = screen.getByLabelText("Type the permanent repository name to confirm");
  await user.type(confirmation, repository.name);
  expect(screen.getByRole("button", { name: "Permanently delete repository" })).toHaveProperty(
    "disabled",
    true,
  );
  await user.clear(confirmation);
  await user.type(confirmation, repository.repositoryName!);
  const deletion = screen.getByRole("button", { name: "Permanently delete repository" });
  fireEvent.click(deletion);
  fireEvent.click(deletion);
  await user.click(await screen.findByRole("button", { name: "Manage repository" }));
  await screen.findByRole("button", { name: "Recover repository deletion" });
  confirmation = screen.getByLabelText("Type the permanent repository name to confirm");
  expect(api.deleteRepository).toHaveBeenCalledExactlyOnceWith(repository.projectId, {
    confirmation: repository.repositoryName,
    repositoryId: repository.repositoryId,
  });
  await user.type(confirmation, repository.repositoryName!);
  expect(screen.getByRole("button", { name: "Recover repository deletion" })).toHaveProperty(
    "disabled",
    true,
  );
  await user.click(screen.getByRole("button", { name: "Refresh deletion status" }));
  await screen.findByText(/Confirm the permanent name to recover/);
  expect(api.repositoryStatus).toHaveBeenCalledOnce();
  expect(api.deleteRepository).toHaveBeenCalledOnce();
  expect(confirmation).toHaveProperty("value", "");
  await user.type(confirmation, repository.repositoryName!);
  await user.click(screen.getByRole("button", { name: "Recover repository deletion" }));
  await waitFor(() => expect(api.deleteRepository).toHaveBeenCalledTimes(2));
});
it("quarantines unknown deletion results, never displays diagnostics, and refreshes without POST", async () => {
  const api = managementApi();
  vi.mocked(api.deleteRepository!).mockRejectedValue(new Error("secret provider diagnostic"));
  const { user } = await open(api);
  await user.click(screen.getByRole("button", { name: "Review deletion" }));
  await user.type(
    screen.getByLabelText("Type the permanent repository name to confirm"),
    repository.repositoryName!,
  );
  await user.click(screen.getByRole("button", { name: "Permanently delete repository" }));
  await screen.findByText(/deletion result is unknown/);
  expect(screen.queryByText(/secret provider/)).toBeNull();
  expect(screen.getByRole("button", { name: "Permanently delete repository" })).toHaveProperty(
    "disabled",
    true,
  );
  expect(screen.queryByRole("button", { name: "Save repository details" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Refresh deletion status" }));
  await screen.findByText(/Confirm the permanent name to recover/);
  expect(api.deleteRepository).toHaveBeenCalledOnce();
});
it("shows once-created invitation links ephemerally, copies them, and revokes pending invitations by ID", async () => {
  const api = managementApi();
  const writeText = vi.fn().mockResolvedValue(undefined);
  const { user } = await open(api);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  await user.type(screen.getByLabelText("Invitation recipient email"), "guest@example.test");
  await user.click(screen.getByRole("button", { name: "Create invitation link" }));
  const field = await screen.findByLabelText("Invitation link");
  expect(field).toHaveProperty("value", `${location.origin}/?invitation=${"a".repeat(64)}`);
  await user.click(screen.getByRole("button", { name: "Copy invitation link" }));
  expect(writeText).toHaveBeenCalledExactlyOnceWith(
    `${location.origin}/?invitation=${"a".repeat(64)}`,
  );
  await user.click(screen.getAllByRole("button", { name: "Revoke invitation" })[1]);
  expect(api.revokeProjectInvitation).toHaveBeenCalledExactlyOnceWith(
    repository.projectId,
    "new-invitation",
  );
  expect(screen.queryByLabelText("Invitation link")).toBeNull();
  expect(api.inviteProject).toHaveBeenCalledExactlyOnceWith(
    repository.projectId,
    "guest@example.test",
  );
});
it("requires access discovery after an unknown invitation creation before another create", async () => {
  const api = managementApi();
  vi.mocked(api.inviteProject).mockRejectedValue(new Error("secret"));
  const { user } = await open(api);
  await user.type(screen.getByLabelText("Invitation recipient email"), "guest@example.test");
  await user.click(screen.getByRole("button", { name: "Create invitation link" }));
  await screen.findByText(/invitation result is unknown/);
  expect(screen.getByRole("button", { name: "Create invitation link" })).toHaveProperty(
    "disabled",
    true,
  );
  await user.click(screen.getByRole("button", { name: "Refresh access" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Create invitation link" })).toHaveProperty(
      "disabled",
      false,
    ),
  );
  expect(api.inviteProject).toHaveBeenCalledOnce();
});
it("shows owner membership without a revoke action and revokes only the selected editor", async () => {
  const api = managementApi();
  const { user } = await open(api);
  expect(screen.getAllByRole("button", { name: "Revoke member access" })).toHaveLength(1);
  await user.click(screen.getByRole("button", { name: "Revoke member access" }));
  expect(api.removeProjectMember).toHaveBeenCalledExactlyOnceWith(
    repository.projectId,
    "account:editor",
  );
  expect(screen.queryByText("editor@example.test")).toBeNull();
  expect(screen.getByText("owner@example.test")).toBeTruthy();
});
it.each(["unmount", "account switch"])(
  "ignores pending invitation completion after %s",
  async (mode) => {
    const api = managementApi();
    let complete!: (result: CreatedInvitation) => void;
    vi.mocked(api.inviteProject).mockReturnValue(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    const { user, view } = await open(api);
    await user.type(screen.getByLabelText("Invitation recipient email"), "guest@example.test");
    await user.click(screen.getByRole("button", { name: "Create invitation link" }));
    if (mode === "unmount") view.unmount();
    else {
      view.rerender(<AccountRepositories api={managementApi()} />);
      await screen.findByRole("button", { name: "Manage repository" });
    }
    await act(async () => complete({ token: "a".repeat(64), invitation }));
    expect(screen.queryByLabelText("Invitation link")).toBeNull();
    expect(screen.queryByText(/Invitation created/)).toBeNull();
  },
);
it("keeps stale metadata conflicts actionable without leaking backend diagnostics", async () => {
  const api = managementApi();
  vi.mocked(api.updateRepository!).mockRejectedValue(new ApiError(409));
  const { user } = await open(api);
  await user.click(screen.getByRole("button", { name: "Save repository details" }));
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "This repository changed. Refresh repositories before trying again.",
  );
  expect(api.updateRepository).toHaveBeenCalledOnce();
});
it("offers self-service onboarding without operator setup when the account directory is empty", async () => {
  const api = managementApi();
  vi.mocked(api.repositories).mockResolvedValue([]);
  render(<AccountRepositories api={api} />);
  await screen.findByText(/Create your first repository below/);
  expect(screen.queryByText(/ask the operator/i)).toBeNull();
});
it("keeps an unresolved creation quarantined across refresh and cannot create a second target that erases it", async () => {
  const api = managementApi();
  vi.mocked(api.createRepository!).mockRejectedValue(new ApiError(0));
  const user = userEvent.setup();
  render(<AccountRepositories api={api} />);
  let form = await screen.findByRole("form", { name: "Create repository" });
  await user.type(within(form).getByLabelText("Permanent repository name"), "unknown-target");
  await user.click(within(form).getByRole("checkbox"));
  await user.click(within(form).getByRole("button"));
  await screen.findByText(/creation result is unknown/i);
  await user.click(screen.getByRole("button", { name: "Refresh" }));
  await screen.findByText(/creation result for unknown-target is unknown/i);
  form = screen.getByRole("form", { name: "Create repository" });
  await user.clear(within(form).getByLabelText("Permanent repository name"));
  await user.type(within(form).getByLabelText("Permanent repository name"), "other-target");
  await user.click(within(form).getByRole("checkbox"));
  expect(within(form).getByRole("button")).toHaveProperty("disabled", true);
  expect(api.createRepository).toHaveBeenCalledOnce();
});
it("treats malformed invitation success metadata as unknown and requires a fresh access read", async () => {
  const api = managementApi();
  vi.mocked(api.inviteProject).mockResolvedValue({
    token: "a".repeat(64),
    invitation: { ...invitation, projectId: "different-project" },
  });
  const { user } = await open(api);
  await user.type(screen.getByLabelText("Invitation recipient email"), "guest@example.test");
  await user.click(screen.getByRole("button", { name: "Create invitation link" }));
  await screen.findByText(/invitation result is unknown/);
  expect(screen.queryByLabelText("Invitation link")).toBeNull();
  expect(screen.getByRole("button", { name: "Create invitation link" })).toHaveProperty(
    "disabled",
    true,
  );
  expect(api.inviteProject).toHaveBeenCalledOnce();
});
it("allows owner metadata and sharing on a protected repository while disabling permanent deletion", async () => {
  const api = managementApi();
  vi.mocked(api.repositories).mockResolvedValue([{ ...repository, deletable: false }]);
  const { user } = await open(api);
  expect(screen.getByRole("button", { name: "Review deletion" })).toHaveProperty("disabled", true);
  expect(screen.getByRole("button", { name: "Save repository details" })).toHaveProperty(
    "disabled",
    false,
  );
  await user.type(screen.getByLabelText("Invitation recipient email"), "guest@example.test");
  expect(screen.getByRole("button", { name: "Create invitation link" })).toHaveProperty(
    "disabled",
    false,
  );
  expect(screen.getByRole("button", { name: "Revoke member access" })).toHaveProperty(
    "disabled",
    false,
  );
});
it.each(["projectId", "repositoryName", "repositoryId"])(
  "quarantines a deletion response that changes its immutable %s target",
  async (field) => {
    const api = managementApi();
    vi.mocked(api.deleteRepository!).mockResolvedValue({
      ...repository,
      role: "owner",
      repositoryName: repository.repositoryName!,
      repositoryId: repository.repositoryId!,
      description: repository.description!,
      metadataRevision: repository.metadataRevision!,
      status: "deleting",
      lifecycle: "deleting",
      deletable: false,
      [field]: "different-target",
    });
    const { user } = await open(api);
    await user.click(screen.getByRole("button", { name: "Review deletion" }));
    await user.type(
      screen.getByLabelText("Type the permanent repository name to confirm"),
      repository.repositoryName!,
    );
    await user.click(screen.getByRole("button", { name: "Permanently delete repository" }));
    await screen.findByText(/deletion result is unknown/);
    expect(screen.getByRole("button", { name: "Permanently delete repository" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(api.repositories).toHaveBeenCalledOnce();
    expect(api.deleteRepository).toHaveBeenCalledOnce();
  },
);

it("keeps live directory management and new creation usable after another repository is deleted, while refusing retired names", async () => {
  const fetch = vi.fn(async (path: string) => {
    if (path === "/api/repositories") return Response.json({ repositories: [repository] });
    if (path === "/api/repository-creations")
      return Response.json({
        approval: null,
        capabilities: { create: true, manage: true },
        creations: [
          { name: "retiring-repo", repositoryId: "retiring-id", status: "deleting" },
          { name: "retired-repo", repositoryId: "retired-id", status: "deleted" },
        ],
      });
    if (
      path === "/api/project-adoptions" ||
      path.endsWith("/members") ||
      path.endsWith("/invitations")
    )
      return Response.json([]);
    throw Error("Unexpected synthetic request");
  });
  vi.stubGlobal("fetch", fetch);
  const user = userEvent.setup();
  render(<AccountRepositories api={httpApi.collaboration!} />);
  await screen.findByText(/This repository was deleted.*permanent name is retired/);
  expect(screen.getByText(/This repository is being deleted/)).toBeTruthy();
  expect(screen.queryByText(/Could not check repository creation status/)).toBeNull();
  expect(screen.queryByText(/needs registration to this account/)).toBeNull();
  expect(screen.queryByRole("button", { name: "Recover repository creation" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Manage repository" }));
  expect(await screen.findByRole("button", { name: "Save repository details" })).toHaveProperty(
    "disabled",
    false,
  );
  const form = screen.getByRole("form", { name: "Create repository" });
  const name = within(form).getByLabelText("Permanent repository name");
  for (const retiredName of ["retired-repo", "retiring-repo"]) {
    await user.clear(name);
    await user.type(name, retiredName);
    await user.click(within(form).getByRole("checkbox"));
    expect(within(form).getByRole("button")).toHaveProperty("disabled", true);
  }
  await user.clear(name);
  await user.type(name, "different-new-repo");
  await user.click(within(form).getByRole("checkbox"));
  expect(within(form).getByRole("button")).toHaveProperty("disabled", false);
  expect(fetch.mock.calls.some(([path]) => path.endsWith("/create"))).toBe(false);
});

it("refreshes Work and the directory as soon as a validated deletion is accepted, while leaving recovery explicit", async () => {
  const api = managementApi();
  const onAdopted = vi.fn();
  const user = userEvent.setup();
  render(<AccountRepositories api={api} onAdopted={onAdopted} />);
  await user.click(await screen.findByRole("button", { name: "Manage repository" }));
  await user.click(screen.getByRole("button", { name: "Review deletion" }));
  await user.type(
    screen.getByLabelText("Type the permanent repository name to confirm"),
    repository.repositoryName!,
  );
  await user.click(screen.getByRole("button", { name: "Permanently delete repository" }));
  await screen.findByText("Deletion pending");
  expect(onAdopted).toHaveBeenCalledOnce();
  expect(api.repositories).toHaveBeenCalledTimes(2);
  expect(api.deleteRepository).toHaveBeenCalledOnce();
  await user.click(screen.getByRole("button", { name: "Manage repository" }));
  expect(screen.queryByRole("button", { name: "Save repository details" })).toBeNull();
  expect(screen.getByRole("button", { name: "Recover repository deletion" })).toHaveProperty(
    "disabled",
    true,
  );
  expect(screen.getByRole("button", { name: "Refresh deletion status" })).toBeTruthy();
});
