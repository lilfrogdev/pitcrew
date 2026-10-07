import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { App } from "./App";
import { createFixtureApi } from "./fixtures";
import { ApiError, type CollaborationApi, type Snapshot } from "./api";

afterEach(() => {
  cleanup();
  localStorage.clear();
});
const viewer = {
  id: "owner",
  name: "Owner name",
  username: "owner_handle",
  email: "owner@example.com",
  emailVerified: true,
  image: "/avatars/owner.svg",
};

it("sends an explicitly enabled shared message with no provider and never claims a task ran", async () => {
  const api = createFixtureApi();
  api.capabilities = vi.fn(async () => ({
    landing: { enabled: false, backend: null },
    notesEnabled: true,
  }));
  let snapshot: Snapshot = { messages: [], runs: [], reviews: [], evidence: [] };
  api.snapshot = vi.fn(async () => snapshot);
  api.send = vi.fn(async (threadId, content) => {
    snapshot = {
      ...snapshot,
      messages: [
        {
          id: "note-1",
          threadId,
          content,
          role: "user",
          createdAt: "2026-10-06T12:00:00Z",
          author: {
            actor: "account:owner",
            email: viewer.email,
            displayName: viewer.name,
            avatar: viewer.image,
          },
        },
      ],
    };
  });
  const user = userEvent.setup();
  render(<App api={api} viewer={viewer} />);
  await screen.findByText("Start the conversation");
  expect(screen.getByRole("button", { name: "Attach files" })).toHaveProperty("disabled", true);
  await user.type(screen.getByLabelText("Message your crew"), "Let’s work on this together.");
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await screen.findByText("Let’s work on this together.");
  expect(api.send).toHaveBeenCalledOnce();
  expect(screen.getByText("owner_handle")).toBeTruthy();
  expect(screen.getByText("Message sent.")).toBeTruthy();
  expect(screen.queryByText(/reply queued|change queued/)).toBeNull();
  expect(screen.getByRole("button", { name: "Permissions, Runs disabled" })).toBeTruthy();
  expect(screen.getByText("Messages are shared. Agent runs are disabled.")).toBeTruthy();
});

it("renders peer authors from server identity and clears their transcript after permission removal", async () => {
  const api = createFixtureApi();
  const snapshot: Snapshot = {
    messages: [
      {
        id: "peer-note",
        threadId: "welcome",
        role: "user",
        content: "Private shared note",
        createdAt: "2026-10-06T12:00:00Z",
        author: {
          actor: "account:bryan",
          email: "bryan@example.com",
          displayName: "Bryan Full Name",
          username: "peer_handle",
          avatar: "/avatars/bryan.svg",
        },
      },
    ],
    runs: [],
    reviews: [],
    evidence: [],
  };
  api.snapshot = vi.fn(async () => snapshot);
  render(<App api={api} viewer={viewer} />);
  await screen.findByText("Private shared note");
  const article = screen.getByText("Private shared note").closest("article")!;
  expect(article.querySelector("strong")?.textContent).toBe("peer_handle");
  expect(article.textContent).not.toContain("Bryan Full Name");
  expect(article.querySelector("img")?.getAttribute("src")).toBe("/avatars/bryan.svg");
  vi.mocked(api.snapshot).mockRejectedValue(new ApiError(404));
  api.projects = vi.fn(async () => []);
  fireEvent(window, new Event("online"));
  await waitFor(() => expect(screen.queryByText("Private shared note")).toBeNull());
  expect(screen.queryByText("peer_handle")).toBeNull();
  await screen.findByText("No repositories yet");
  expect(screen.queryByRole("button", { name: "Set up a provider" })).toBeNull();
});

it.each([false, true])(
  "refreshes the Work sidebar after an approved adoption, including when navigation closes the directory before completion (%s)",
  async (navigateWhilePending) => {
    const api = createFixtureApi();
    const candidate = { name: "Approved workspace", repositoryId: "immutable-123" };
    const project = {
      id: "adopted-project",
      name: candidate.name,
      repository: candidate.repositoryId,
      baseSha: "base",
      configurationRevision: "v1",
    };
    let adopted = false;
    let completeAdoption!: () => void;
    const adoption = new Promise<void>((resolve) => {
      completeAdoption = resolve;
    });
    api.projects = vi.fn(async () => (adopted ? [project] : []));
    api.threads = vi.fn(async () => []);
    api.collaboration = {
      account: vi.fn(async () => ({ actor: "account:owner", email: viewer.email })),
      repositories: vi.fn(async () =>
        adopted
          ? [
              {
                projectId: project.id,
                name: project.name,
                role: "owner",
                status: "present",
                lifecycle: "registered",
                deletable: false,
              },
            ]
          : [],
      ),
      approvedProjectAdoptions: vi.fn(async () => (adopted ? [] : [candidate])),
      adoptProject: vi.fn(async () => {
        await adoption;
        adopted = true;
        return project;
      }),
      projectMembers: vi.fn(async () => []),
      threadMembers: vi.fn(async () => []),
    } as unknown as CollaborationApi;
    const user = userEvent.setup();
    render(<App api={api} viewer={viewer} />);
    await screen.findByText("No repositories yet");
    expect(screen.getByText(/Open Repositories to check for an approved repository/)).toBeTruthy();
    const rail = screen.getByRole("navigation", { name: "Workspace" });
    await user.click(within(rail).getByRole("button", { name: "Repositories" }));
    await screen.findByText(candidate.repositoryId);
    await user.click(screen.getByRole("checkbox", { name: /I confirm adding Approved workspace/ }));
    await user.click(screen.getByRole("button", { name: "Add approved repository" }));
    let completeOldDirectory!: () => void;
    vi.mocked(api.projects).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          completeOldDirectory = () => resolve([]);
        }),
    );
    fireEvent(window, new Event("online"));
    if (navigateWhilePending) await user.click(within(rail).getByRole("button", { name: "Work" }));
    await act(async () => completeAdoption());
    if (!navigateWhilePending) await screen.findByText("owner");
    expect(api.collaboration.adoptProject).toHaveBeenCalledExactlyOnceWith(
      candidate.name,
      candidate.repositoryId,
    );
    expect(api.collaboration.repositories).toHaveBeenCalledTimes(navigateWhilePending ? 1 : 2);
    await waitFor(() => expect(api.projects).toHaveBeenCalledTimes(3));
    await act(async () => completeOldDirectory());
    if (!navigateWhilePending) await user.click(within(rail).getByRole("button", { name: "Work" }));
    expect(
      await screen.findByRole("button", { name: "New conversation in Approved workspace" }),
    ).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Your repository conversations" })).toBeTruthy();
    expect(api.threads).toHaveBeenCalledWith(project.id);
    expect(screen.queryByText("No repositories yet")).toBeNull();
  },
);

it.each([
  {
    actor: "account:owner",
    username: "verified_self",
    displayName: "Owner Full Name",
    label: "verified_self",
  },
  {
    actor: "account:peer",
    username: "verified_peer",
    displayName: "Peer Full Name",
    label: "verified_peer",
  },
  { actor: "account:owner", displayName: "Legacy Owner", label: viewer.username },
  { actor: "account:peer", displayName: "Legacy Peer", label: "Legacy Peer" },
  { actor: "account:peer", label: "legacy@example.com" },
])(
  "uses verified username with legacy fallback for $label",
  async ({ actor, username, displayName, label }) => {
    const api = createFixtureApi();
    api.snapshot = vi.fn(async () => ({
      messages: [
        {
          id: "identity-note",
          threadId: "welcome",
          role: "user" as const,
          content: "Message author label",
          createdAt: "2026-10-06T12:00:00Z",
          author: { actor, username, displayName, email: "legacy@example.com" },
        },
      ],
      runs: [],
      reviews: [],
      evidence: [],
    }));
    render(<App api={api} viewer={viewer} />);
    const article = (await screen.findByText("Message author label")).closest("article")!;
    expect(article.querySelector("strong")?.textContent).toBe(label);
  },
);
