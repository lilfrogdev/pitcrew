import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vite-plus/test";
import type { AuthApi } from "./auth-api";
import { ApiError, type CollaborationApi } from "./api";
import { AccountSummary, Collaborators, InvitationGate } from "./Collaboration";

const owner = { actor: "owner", email: "owner@example.com", role: "owner" as const };
const bryan = { actor: "bryan", email: "bryan@example.com", role: "editor" as const };
function collaboration(): CollaborationApi {
  return {
    account: vi.fn(async () => ({ actor: owner.actor, email: owner.email })),
    repositories: vi.fn(async () => [
      {
        projectId: "repo-1",
        status: "present" as const,
        lifecycle: "registered" as const,
        deletable: false as const,
        name: "Empty repository",
        role: "owner" as const,
      },
    ]),
    projectMembers: vi.fn(async () => [owner, bryan]),
    threadMembers: vi.fn(async () => [owner]),
    inviteProject: vi.fn(async (_id, email) => ({
      token: "a".repeat(64),
      invitation: {
        id: "invite-1",
        scope: "project" as const,
        email,
        role: "editor" as const,
        expiresAt: new Date(Date.now() + 1800000).toISOString(),
        projectId: "repo-1",
      },
    })),
    inviteThread: vi.fn(async () => {
      throw Error("Join the repository first.");
    }),
    invitation: vi.fn(async () => ({
      id: "invite-1",
      scope: "project" as const,
      email: bryan.email,
      role: "editor" as const,
      expiresAt: new Date(Date.now() + 1800000).toISOString(),
      projectId: "repo-1",
    })),
    acceptInvitation: vi.fn(async () => ({
      id: "invite-1",
      scope: "project" as const,
      email: bryan.email,
      role: "editor" as const,
      expiresAt: new Date(Date.now() + 1800000).toISOString(),
      projectId: "repo-1",
    })),
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
  let finishOpening!: (members: (typeof owner)[]) => void;
  vi.mocked(api.projectMembers)
    .mockResolvedValueOnce([owner])
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOpening = resolve;
        }),
    )
    .mockResolvedValue([owner, bryan]);
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
  await user.type(screen.getByLabelText("Username or email"), "new@example.com");
  await user.click(screen.getByRole("button", { name: "Create invite code" }));
  expect(api.inviteProject).toHaveBeenCalledWith("repo-1", "new@example.com");
  expect(
    ((await screen.findByLabelText("Invite code for new@example.com")) as HTMLInputElement).value,
  ).toBe("a".repeat(64));
  await user.click(
    within(repository).getByRole("button", { name: "Remove bryan@example.com from repository" }),
  );
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

it("keeps thread-only owners from inviting or removing members without repository ownership", async () => {
  const api = collaboration();
  vi.mocked(api.projectMembers).mockResolvedValue([
    { ...owner, role: "editor" },
    { ...bryan, role: "owner" },
  ]);
  vi.mocked(api.threadMembers).mockResolvedValue([{ ...owner, role: "owner" }, bryan]);
  const user = userEvent.setup();
  render(<Collaborators api={api} projectId="repo-1" threadId="thread-1" onAccessLost={vi.fn()} />);
  await user.click(screen.getByRole("button", { name: "Share" }));
  await screen.findByRole("region", { name: "Repository members" });
  expect(screen.queryByLabelText("Username or email")).toBeNull();
  expect(screen.queryByRole("button", { name: "Create invite code" })).toBeNull();
  expect(api.inviteThread).not.toHaveBeenCalled();
  expect(api.inviteProject).not.toHaveBeenCalled();
  expect(screen.getByRole("region", { name: "Thread members" }).textContent).toContain(bryan.email);
  expect(screen.queryByRole("button", { name: /Remove / })).toBeNull();
  expect(api.removeProjectMember).not.toHaveBeenCalled();
  expect(api.removeThreadMember).not.toHaveBeenCalled();
});

it("ignores an invitation response after switching its repository and thread", async () => {
  const api = collaboration();
  let resolve!: (value: Awaited<ReturnType<CollaborationApi["inviteProject"]>>) => void;
  vi.mocked(api.inviteProject).mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const lost = vi.fn();
  const user = userEvent.setup();
  const view = render(
    <Collaborators api={api} projectId="repo-1" threadId="thread-1" onAccessLost={lost} />,
  );
  await user.click(screen.getByRole("button", { name: "Share" }));
  await screen.findByLabelText("Username or email");
  await user.type(screen.getByLabelText("Username or email"), "johncena");
  await user.click(screen.getByRole("button", { name: "Create invite code" }));
  expect(screen.getByLabelText("Access")).toHaveProperty("disabled", true);
  view.rerender(
    <Collaborators api={api} projectId="repo-2" threadId="thread-2" onAccessLost={lost} />,
  );
  await screen.findByLabelText("Username or email");
  resolve({
    token: "c".repeat(64),
    invitation: {
      id: "old",
      projectId: "repo-1",
      scope: "project",
      recipient: "@johncena",
      role: "editor",
      expiresAt: new Date(Date.now() + 1800000).toISOString(),
    },
  });
  await waitFor(() => expect(screen.getByLabelText("Access")).toHaveProperty("disabled", false));
  expect(screen.queryByLabelText("Invite code for @johncena")).toBeNull();
});

it("shows an expired invitation once and prevents an acceptance attempt", async () => {
  history.replaceState(null, "", `/?invitation=${"a".repeat(64)}`);
  const api = collaboration();
  vi.mocked(api.invitation).mockResolvedValue({
    id: "expired",
    projectId: "repo-1",
    scope: "project",
    email: bryan.email,
    role: "editor",
    expiresAt: "2000-01-01T00:00:00Z",
  });
  render(<InvitationGate api={api} onAccepted={vi.fn()} />);
  expect(
    await screen.findByText("This invitation is no longer available. Ask for a new code."),
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: "Accept invitation" })).toHaveProperty(
    "disabled",
    true,
  );
  expect(api.acceptInvitation).not.toHaveBeenCalled();
});

it("shows member usernames and removes by the stable actor", async () => {
  const api = collaboration();
  vi.mocked(api.projectMembers).mockResolvedValue([
    owner,
    { ...bryan, username: "peer_handle", displayName: "Peer Full Name" },
  ]);
  const user = userEvent.setup();
  render(<Collaborators api={api} projectId="repo-1" threadId="thread-1" onAccessLost={vi.fn()} />);
  await user.click(screen.getByRole("button", { name: "Share" }));
  const members = await screen.findByRole("region", { name: "Repository members" });
  await within(members).findByText(/peer_handle · editor/);
  expect(within(members).queryByText(/Peer Full Name/)).toBeNull();
  expect(within(members).getByText(bryan.email)).toBeTruthy();
  await user.click(
    within(members).getByRole("button", { name: "Remove peer_handle from repository" }),
  );
  expect(api.removeProjectMember).toHaveBeenCalledExactlyOnceWith("repo-1", bryan.actor);
  expect(await screen.findByText("peer_handle removed from repository.")).toBeTruthy();
});

it("uses account username and saves a profile with an optional full name", async () => {
  const api = collaboration();
  vi.mocked(api.account).mockResolvedValue({
    ...owner,
    username: "verified_owner",
    displayName: "Owner Full Name",
  });
  const viewer = {
    id: "owner",
    name: "Owner Full Name",
    username: "owner_handle",
    email: owner.email,
    emailVerified: false,
  };
  const auth = { updateUser: vi.fn(async () => {}) } as unknown as AuthApi;
  const user = userEvent.setup();
  const view = render(<AccountSummary api={api} />);
  expect(await screen.findByText("verified_owner")).toBeTruthy();
  view.rerender(<AccountSummary api={api} viewer={viewer} auth={auth} />);
  expect(screen.getByText("owner_handle")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Edit profile" }));
  const name = screen.getByLabelText("Full name (optional)");
  expect(name).toHaveProperty("required", false);
  await user.clear(name);
  await user.clear(screen.getByLabelText("Username"));
  await user.type(screen.getByLabelText("Username"), "Next_Handle");
  await user.click(screen.getByRole("button", { name: "Save profile" }));
  expect(auth.updateUser).toHaveBeenCalledExactlyOnceWith({ name: "", username: "next_handle" });
  expect(await screen.findByText("Profile saved.")).toBeTruthy();
});
it.each([
  ["project", "johncena", "@johncena"],
  ["project", "new@example.com", "new@example.com"],
  ["thread", "johncena", "@johncena"],
  ["thread", "new@example.com", "new@example.com"],
] as const)(
  "creates a %s invitation from %s using the server recipient label without claiming email delivery",
  async (scope, recipient, label) => {
    const api = collaboration();
    const created = {
      token: "a".repeat(64),
      invitation: {
        id: "recipient-invite",
        scope,
        recipient: label,
        role: "editor" as const,
        projectId: "repo-1",
        ...(scope === "thread" ? { threadId: "thread-1" } : {}),
        expiresAt: "2099-01-01T00:00:00Z",
      },
    };
    vi.mocked(api.inviteProject).mockResolvedValue(created);
    vi.mocked(api.inviteThread).mockResolvedValue(created);
    const user = userEvent.setup();
    render(
      <Collaborators api={api} projectId="repo-1" threadId="thread-1" onAccessLost={vi.fn()} />,
    );
    await user.click(screen.getByRole("button", { name: "Share" }));
    await user.selectOptions(await screen.findByLabelText("Access"), scope);
    const input = screen.getByLabelText("Username or email");
    expect(input).toHaveProperty("type", "text");
    await user.type(input, ` ${recipient} `);
    await user.click(screen.getByRole("button", { name: "Create invite code" }));
    expect(
      scope === "project" ? api.inviteProject : api.inviteThread,
    ).toHaveBeenCalledExactlyOnceWith(scope === "project" ? "repo-1" : "thread-1", recipient);
    expect(await screen.findByLabelText(`Invite code for ${label}`)).toHaveProperty(
      "value",
      "a".repeat(64),
    );
    expect(screen.getByRole("status").textContent).toBe("Invite code ready.");
  },
);
it("keeps unavailable recipients actionable without treating them as lost workspace access", async () => {
  const api = collaboration();
  vi.mocked(api.inviteProject).mockRejectedValue(new ApiError(400, "recipient_unavailable"));
  const lost = vi.fn();
  const user = userEvent.setup();
  render(<Collaborators api={api} projectId="repo-1" threadId="thread-1" onAccessLost={lost} />);
  await user.click(screen.getByRole("button", { name: "Share" }));
  await user.type(await screen.findByLabelText("Username or email"), "johncena");
  await user.click(screen.getByRole("button", { name: "Create invite code" }));
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    expect.stringContaining("recipient is unavailable"),
  );
  expect(screen.getByLabelText("Username or email")).toHaveProperty("value", "johncena");
  expect(lost).not.toHaveBeenCalled();
});
it("previews a bound username invitation with no email field", async () => {
  history.replaceState(null, "", `/?invitation=${"a".repeat(64)}`);
  const api = collaboration();
  vi.mocked(api.invitation).mockResolvedValue({
    id: "bound",
    scope: "project",
    recipient: "@johncena",
    role: "editor",
    projectId: "repo-1",
    expiresAt: "2099-01-01T00:00:00Z",
  });
  render(<InvitationGate api={api} onAccepted={vi.fn()} />);
  expect(await screen.findByText("Repository invitation for @johncena.")).toBeTruthy();
});

it.each(["project", "thread"] as const)(
  "quarantines wrong, dual and noncanonical %s invitation labels until explicit refresh",
  async (scope) => {
    for (const fields of [
      { recipient: "@different" },
      { recipient: "arbitrary plaintext" },
      { recipient: "@JohnCena" },
      { recipient: "@johncena", email: "other@example.test" },
    ]) {
      const api = collaboration();
      const created = {
        token: "a".repeat(64),
        invitation: {
          id: "new",
          scope,
          role: "editor" as const,
          projectId: "repo-1",
          ...(scope === "thread" ? { threadId: "thread-1" } : {}),
          expiresAt: "2099-01-01T00:00:00Z",
          ...fields,
        },
      };
      vi.mocked(api.inviteProject).mockResolvedValue(created);
      vi.mocked(api.inviteThread).mockResolvedValue(created);
      const user = userEvent.setup();
      render(
        <Collaborators api={api} projectId="repo-1" threadId="thread-1" onAccessLost={vi.fn()} />,
      );
      await user.click(screen.getByRole("button", { name: "Share" }));
      await user.selectOptions(await screen.findByLabelText("Access"), scope);
      await user.type(screen.getByLabelText("Username or email"), "johncena");
      await user.click(screen.getByRole("button", { name: "Create invite code" }));
      await screen.findByText(/invitation result is unknown/);
      expect(screen.queryByLabelText(/Invite code for/)).toBeNull();
      const create = screen.getByRole("button", { name: "Create invite code" });
      expect(create).toHaveProperty("disabled", true);
      fireEvent.click(create);
      const mutation = scope === "project" ? api.inviteProject : api.inviteThread;
      expect(mutation).toHaveBeenCalledOnce();
      // Background access reads may succeed; only explicit refresh releases the quarantine.
      fireEvent(document, new Event("visibilitychange"));
      await waitFor(() => expect(api.projectMembers).toHaveBeenCalledTimes(3));
      expect(create).toHaveProperty("disabled", true);
      await user.click(screen.getByRole("button", { name: "Refresh" }));
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Create invite code" })).toHaveProperty(
          "disabled",
          false,
        ),
      );
      expect(mutation).toHaveBeenCalledOnce();
      cleanup();
    }
  },
);

function InvitationHost({
  api,
  accountKey,
  onAccepted,
}: {
  api: CollaborationApi;
  accountKey: string;
  onAccepted: (value: Awaited<ReturnType<CollaborationApi["acceptInvitation"]>>) => void;
}) {
  const [selectedProject, setSelectedProject] = useState("original-project");
  return (
    <>
      <output aria-label="Selected repository">{selectedProject}</output>
      <InvitationGate
        key={accountKey}
        api={api}
        manual
        fromUrl={false}
        onAccepted={(invitation) => {
          setSelectedProject(invitation.projectId);
          onAccepted(invitation);
        }}
      />
    </>
  );
}
it.each(["unmount", "account switch", "API change", "authority lost", "token change"])(
  "ignores delayed invitation acceptance after %s",
  async (change) => {
    const api = collaboration();
    const invitation = await api.invitation("a".repeat(64));
    let resolve!: (value: typeof invitation) => void;
    vi.mocked(api.acceptInvitation).mockReturnValue(
      new Promise((complete) => {
        resolve = complete;
      }),
    );
    const accepted = vi.fn();
    const user = userEvent.setup();
    const view = render(
      <InvitationHost accountKey="first-account" api={api} onAccepted={accepted} />,
    );
    await user.type(screen.getByLabelText("Invite code"), "a".repeat(64));
    await user.click(screen.getByRole("button", { name: "Check invitation" }));
    await screen.findByText(/Repository invitation for/);
    await user.click(screen.getByRole("button", { name: "Accept invitation" }));
    if (change === "unmount") view.unmount();
    else if (change === "authority lost") fireEvent(window, new Event("pitcrew-auth-required"));
    else {
      const nextApi = collaboration();
      view.rerender(
        <InvitationHost
          accountKey={change === "account switch" ? "second-account" : "first-account"}
          api={nextApi}
          onAccepted={accepted}
        />,
      );
      if (change === "token change") {
        await waitFor(() =>
          expect(screen.getByRole("button", { name: "Dismiss" })).toHaveProperty("disabled", false),
        );
        await user.click(screen.getByRole("button", { name: "Dismiss" }));
        await user.type(screen.getByLabelText("Invite code"), "b".repeat(64));
        await user.click(screen.getByRole("button", { name: "Check invitation" }));
        await screen.findByText(/Repository invitation for/);
      }
    }
    await act(async () => resolve(invitation));
    expect(accepted).not.toHaveBeenCalled();
    if (change !== "unmount")
      expect(screen.getByLabelText("Selected repository")).toHaveProperty(
        "textContent",
        "original-project",
      );
    if (change === "account switch")
      expect(screen.getByLabelText("Invite code")).toHaveProperty("value", "");
    if (change === "token change") {
      expect(screen.getByText(/Repository invitation for/)).toBeTruthy();
      expect(screen.getByRole("button", { name: "Accept invitation" })).toHaveProperty(
        "disabled",
        false,
      );
    }
  },
);
it("accepts a pending invitation through incidental callback rerenders without matching a renamed profile label", async () => {
  const api = collaboration();
  const historical = {
    ...(await api.invitation("a".repeat(64))),
    email: undefined,
    recipient: "@previous_name",
  };
  vi.mocked(api.invitation).mockResolvedValue(historical);
  let resolve!: (value: typeof historical) => void;
  vi.mocked(api.acceptInvitation).mockReturnValue(
    new Promise((complete) => {
      resolve = complete;
    }),
  );
  const first = vi.fn();
  const latest = vi.fn();
  const user = userEvent.setup();
  const view = render(<InvitationGate api={api} manual fromUrl={false} onAccepted={first} />);
  await user.type(screen.getByLabelText("Invite code"), "a".repeat(64));
  await user.click(screen.getByRole("button", { name: "Check invitation" }));
  await screen.findByText(/Repository invitation for @previous_name/);
  await user.click(screen.getByRole("button", { name: "Accept invitation" }));
  view.rerender(<InvitationGate api={api} manual fromUrl={false} onAccepted={latest} />);
  await act(async () => resolve(historical));
  expect(latest).toHaveBeenCalledExactlyOnceWith(historical);
  expect(first).not.toHaveBeenCalled();
  expect(screen.getByLabelText("Invite code")).toHaveProperty("value", "");
});
it("rejects an acceptance response for a different immutable invitation resource", async () => {
  const api = collaboration();
  vi.mocked(api.acceptInvitation).mockResolvedValue({
    ...(await api.invitation("a".repeat(64))),
    projectId: "other-project",
  });
  const accepted = vi.fn();
  const user = userEvent.setup();
  history.replaceState(null, "", `/?invitation=${"a".repeat(64)}`);
  render(<InvitationGate api={api} onAccepted={accepted} />);
  await screen.findByText(/Repository invitation for/);
  await user.click(screen.getByRole("button", { name: "Accept invitation" }));
  await screen.findByRole("alert");
  expect(accepted).not.toHaveBeenCalled();
  expect(screen.getByText(/Repository invitation for/)).toBeTruthy();
});

it("allows repository owners to remove a thread member even when their thread role is editor", async () => {
  const api = collaboration();
  vi.mocked(api.threadMembers).mockResolvedValue([{ ...owner, role: "editor" }, bryan]);
  const user = userEvent.setup();
  render(<Collaborators api={api} projectId="repo-1" threadId="thread-1" onAccessLost={vi.fn()} />);
  await user.click(screen.getByRole("button", { name: "Share" }));
  const thread = await screen.findByRole("region", { name: "Thread members" });
  await user.click(
    within(thread).getByRole("button", { name: "Remove bryan@example.com from thread" }),
  );
  expect(api.removeThreadMember).toHaveBeenCalledExactlyOnceWith("thread-1", bryan.actor);
  expect(api.removeProjectMember).not.toHaveBeenCalled();
  await screen.findByText(/removed from thread/);
  vi.mocked(api.projectMembers).mockResolvedValue([
    { ...owner, role: "editor" },
    { ...bryan, role: "owner" },
  ]);
  vi.mocked(api.threadMembers).mockResolvedValue([{ ...owner, role: "owner" }, bryan]);
  await user.click(screen.getByRole("button", { name: "Refresh" }));
  await screen.findByRole("region", { name: "Thread members" });
  expect(screen.queryByRole("button", { name: /Remove / })).toBeNull();
  expect(api.removeThreadMember).toHaveBeenCalledOnce();
});
