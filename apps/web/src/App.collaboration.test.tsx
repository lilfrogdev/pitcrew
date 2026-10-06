import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { App } from "./App";
import { createFixtureApi } from "./fixtures";
import { ApiError, type Snapshot } from "./api";

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
          displayName: "Bryan",
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
  expect(article.textContent).toContain("Bryan");
  expect(article.querySelector("img")?.getAttribute("src")).toBe("/avatars/bryan.svg");
  vi.mocked(api.snapshot).mockRejectedValue(new ApiError(404));
  api.projects = vi.fn(async () => []);
  fireEvent(window, new Event("online"));
  await waitFor(() => expect(screen.queryByText("Private shared note")).toBeNull());
  expect(screen.queryByText("Bryan")).toBeNull();
  await screen.findByText("No repositories yet");
  expect(screen.queryByRole("button", { name: "Set up a provider" })).toBeNull();
});
