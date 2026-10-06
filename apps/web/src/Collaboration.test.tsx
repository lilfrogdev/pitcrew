import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { ApiError, type CollaborationApi } from "./api";
import { Collaborators, InvitationGate } from "./Collaboration";

const owner = { actor: "owner", email: "owner@example.com", role: "owner" as const };
const bryan = { actor: "bryan", email: "bryan@example.com", role: "editor" as const };
function collaboration(): CollaborationApi {
  return {
    account: vi.fn(async () => ({ actor: owner.actor, email: owner.email })),
    repositories: vi.fn(async () => [{ projectId: "repo-1", status: "present" as const, lifecycle: "registered" as const, deletable: false as const, name: "Empty repository", role: "owner" as const }]),
    projectMembers: vi.fn(async () => [owner, bryan]),
    threadMembers: vi.fn(async () => [owner]),
    inviteProject: vi.fn(async (_id, email) => ({
      token: "a".repeat(64),
      invitation: { id: "invite-1", scope: "project" as const, email,
        role: "editor" as const, expiresAt: "2026-10-07T12:00:00Z", projectId: "repo-1" },
    })),
    inviteThread: vi.fn(async () => { throw Error("Join the repository first."); }),
    invitation: vi.fn(async () => ({ id: "invite-1", scope: "project" as const,
      email: bryan.email, role: "editor" as const, expiresAt: "2026-10-07T12:00:00Z", projectId: "repo-1" })),
    acceptInvitation: vi.fn(async () => ({ id: "invite-1", scope: "project" as const,
      email: bryan.email, role: "editor" as const, expiresAt: "2026-10-07T12:00:00Z", projectId: "repo-1" })),
    revokeInvitation: vi.fn(async () => ({})),
    removeProjectMember: vi.fn(async () => ({})),
    removeThreadMember: vi.fn(async () => ({})),
  };
}
afterEach(() => {
  cleanup();
  history.replaceState(null, "", "/");
});

it("finishes loading when a reconnect supersedes the opening request", async () => {
  const api = collaboration();
  let finishOpening!: (members: typeof owner[]) => void;
  vi.mocked(api.projectMembers).mockResolvedValueOnce([owner]).mockImplementationOnce(
    () => new Promise((resolve) => { finishOpening = resolve; }),
  ).mockResolvedValue([owner, bryan]);
  const user = userEvent.setup();
  render(<Collaborators api={api} projectId="repo-1" threadId="thread-1" onAccessLost={vi.fn()} />);
  await waitFor(() => expect(api.projectMembers).toHaveBeenCalledOnce());
  await user.click(screen.getByRole("button", { name: "Share" }));
  expect(screen.getByText("Loading people…")).toBeTruthy();
  fireEvent(document, new Event("visibilitychange"));
  await screen.findByText(/bryan@example.com/);
  expect(screen.queryByText("Loading people…")).toBeNull();
  finishOpening([owner]);
  await waitFor(() => expect(screen.getByText(/bryan@example.com/)).toBeTruthy());
});

it("loads server members, creates a recipient-specific code and removes a member", async () => {
  const api = collaboration();
  const user = userEvent.setup();
  render(<Collaborators api={api} projectId="repo-1" threadId="thread-1" onAccessLost={vi.fn()} />);
  await user.click(screen.getByRole("button", { name: "Share" }));
  const repository = await screen.findByRole("region", { name: "Repository members" });
  expect(within(repository).getByText(/bryan@example.com/)).toBeTruthy();
  await user.type(screen.getByLabelText("Email"), "new@example.com");
  await user.click(screen.getByRole("button", { name: "Create invite code" }));
  expect(api.inviteProject).toHaveBeenCalledWith("repo-1", "new@example.com");
  expect((await screen.findByLabelText("Invite code for new@example.com") as HTMLInputElement).value)
    .toBe("a".repeat(64));
  await user.click(within(repository).getByRole("button", { name: "Remove bryan@example.com from repository" }));
  expect(api.removeProjectMember).toHaveBeenCalledWith("repo-1", "bryan");
});

it("clears a consumed invitation from the URL and refreshes access", async () => {
  history.replaceState(null, "", `/?invitation=${"a".repeat(64)}`);
  const api = collaboration();
  const accepted = vi.fn();
  const user = userEvent.setup();
  render(<InvitationGate api={api} onAccepted={accepted} />);
  await screen.findByText(/Repository invitation for bryan@example.com/);
  await user.click(screen.getByRole("button", { name: "Accept invitation" }));
  await waitFor(() => expect(accepted).toHaveBeenCalledOnce());
  expect(api.acceptInvitation).toHaveBeenCalledWith("a".repeat(64));
  expect(location.search).toBe("");
});

it("accepts a code entered on a separate local installation", async () => {
  const api = collaboration();
  const user = userEvent.setup();
  render(<InvitationGate api={api} manual fromUrl={false} onAccepted={vi.fn()} />);
  await user.type(screen.getByLabelText("Invite code"), "a".repeat(64));
  await user.click(screen.getByRole("button", { name: "Check invitation" }));
  await screen.findByText(/Repository invitation for bryan@example.com/);
  expect(api.invitation).toHaveBeenCalledWith("a".repeat(64));
});

it("drops the share view when access is revoked during refresh", async () => {
  const api = collaboration();
  const lost = vi.fn();
  const user = userEvent.setup();
  render(<Collaborators api={api} projectId="repo-1" threadId="thread-1" onAccessLost={lost} />);
  await user.click(screen.getByRole("button", { name: "Share" }));
  await screen.findByText(/bryan@example.com/);
  vi.mocked(api.threadMembers).mockRejectedValueOnce(new ApiError(404));
  await user.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() => expect(lost).toHaveBeenCalledOnce());
});

it("lets a thread owner invite there without granting repository controls", async () => {
  const api = collaboration();
  vi.mocked(api.projectMembers).mockResolvedValue([
    { ...owner, role: "editor" }, { ...bryan, role: "owner" },
  ]);
  vi.mocked(api.threadMembers).mockResolvedValue([{ ...owner, role: "owner" }]);
  vi.mocked(api.inviteThread).mockResolvedValue({ token: "b".repeat(64), invitation: {
    id: "invite-2", scope: "thread", email: "new@example.com", role: "editor",
    expiresAt: "2026-10-07T12:00:00Z", threadId: "thread-1", projectId: "repo-1",
  } });
  const user = userEvent.setup();
  render(<Collaborators api={api} projectId="repo-1" threadId="thread-1" onAccessLost={vi.fn()} />);
  await user.click(screen.getByRole("button", { name: "Share" }));
  const access = await screen.findByLabelText("Access") as HTMLSelectElement;
  expect(access.value).toBe("thread");
  expect(screen.queryByRole("button", { name: "Remove bryan@example.com from repository" })).toBeNull();
  await user.type(screen.getByLabelText("Email"), "new@example.com");
  await user.click(screen.getByRole("button", { name: "Create invite code" }));
  expect(api.inviteThread).toHaveBeenCalledWith("thread-1", "new@example.com");
});

it("ignores an invitation response after switching its repository and thread", async () => {
  const api = collaboration();
  let resolve!: (value: Awaited<ReturnType<CollaborationApi['inviteProject']>>) => void;
  vi.mocked(api.inviteProject).mockImplementation(() => new Promise((done) => { resolve = done; }));
  const lost = vi.fn();
  const user = userEvent.setup();
  const view = render(<Collaborators api={api} projectId="repo-1" threadId="thread-1" onAccessLost={lost} />);
  await user.click(screen.getByRole("button", { name: "Share" }));
  await screen.findByLabelText("Email");
  await user.type(screen.getByLabelText("Email"), "new@example.com");
  await user.click(screen.getByRole("button", { name: "Create invite code" }));
  expect(screen.getByLabelText("Access")).toHaveProperty("disabled", true);
  view.rerender(<Collaborators api={api} projectId="repo-2" threadId="thread-2" onAccessLost={lost} />);
  await screen.findByLabelText("Email");
  resolve({ token: "c".repeat(64), invitation: { id: "old", projectId: "repo-1", scope: "project",
    email: "new@example.com", role: "editor", expiresAt: "2026-10-07T12:00:00Z" } });
  await waitFor(() => expect(screen.getByLabelText("Access")).toHaveProperty("disabled", false));
  expect(screen.queryByLabelText("Invite code for new@example.com")).toBeNull();
});

it("shows an expired invitation once and prevents an acceptance attempt", async () => {
  history.replaceState(null, "", `/?invitation=${"a".repeat(64)}`);
  const api = collaboration();
  vi.mocked(api.invitation).mockResolvedValue({ id: "expired", projectId: "repo-1", scope: "project",
    email: bryan.email, role: "editor", expiresAt: "2000-01-01T00:00:00Z" });
  render(<InvitationGate api={api} onAccepted={vi.fn()} />);
  expect(await screen.findByText("This invitation is no longer available. Ask for a new code.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Accept invitation" })).toHaveProperty("disabled", true);
  expect(api.acceptInvitation).not.toHaveBeenCalled();
});
