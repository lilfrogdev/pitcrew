import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { App } from "./App";
import { createFixtureApi } from "./fixtures";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

it.each([
  { image: null, expected: "/avatars/author.svg" },
  { image: undefined, expected: "/avatars/author.svg" },
  { image: "/avatars/session.svg", expected: "/avatars/session.svg" },
])("keeps an own message photo when session image is $image", async ({ image, expected }) => {
  const viewer = {
    id: "owner",
    name: "Owner",
    username: "owner",
    email: "owner@example.test",
    emailVerified: true,
    image,
  };
  const api = createFixtureApi();
  api.snapshot = vi.fn(async () => ({
    messages: [
      {
        id: "own",
        threadId: "welcome",
        role: "user" as const,
        content: "Own photo note",
        createdAt: "2026-10-06T12:00:00Z",
        author: {
          actor: "account:owner",
          email: viewer.email,
          username: "owner",
          avatar: "/avatars/author.svg",
        },
      },
      {
        id: "peer",
        threadId: "welcome",
        role: "user" as const,
        content: "Peer photo note",
        createdAt: "2026-10-06T12:00:00Z",
        author: {
          actor: "account:peer",
          email: viewer.email,
          username: "owner",
          avatar: "/avatars/peer.svg",
        },
      },
    ],
    runs: [],
    evidence: [],
    reviews: [],
  }));
  render(<App api={api} viewer={viewer} />);
  const own = (await screen.findByText("Own photo note")).closest("article")!;
  const peer = screen.getByText("Peer photo note").closest("article")!;
  expect(own.querySelector(".avatar img")?.getAttribute("src")).toBe(expected);
  expect(peer.querySelector(".avatar img")?.getAttribute("src")).toBe("/avatars/peer.svg");
});
