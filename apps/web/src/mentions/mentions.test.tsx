import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { App } from "../App";
import { createFixtureApi } from "../fixtures";
import type { CollaborationApi, Member, Snapshot } from "../api";
import { MessageContent, Mentioned } from "./Message";
import { useMentionMembers } from "./useMentions";
const owner: Member = {
  actor: "account:owner",
  email: "owner@example.com",
  username: "owner",
  role: "owner",
};
const john: Member = {
  actor: "account:john",
  email: "john@example.com",
  username: "johncena",
  role: "editor",
};
const alice: Member = {
  actor: "account:alice",
  email: "alice@example.com",
  username: "alice",
  role: "editor",
};
afterEach(() => {
  cleanup();
  localStorage.clear();
});
function collaboration(members = [owner, john, alice]) {
  return {
    threadMembers: vi.fn(async () => members),
    projectMembers: vi.fn(async () => members),
    account: vi.fn(async () => owner),
  } as unknown as CollaborationApi;
}
async function mount() {
  const api = createFixtureApi();
  api.collaboration = collaboration();
  api.send = vi.fn(api.send);
  render(
    <App
      api={api}
      viewer={{
        id: "owner",
        username: "owner",
        name: "Synthetic Owner",
        email: owner.email,
        emailVerified: true,
      }}
      demo
    />,
  );
  await screen.findByText("Show the work behind a change, from delegation to review.");
  await waitFor(() => expect(api.collaboration!.threadMembers).toHaveBeenCalled());
  return {
    api,
    user: userEvent.setup(),
    field: screen.getByLabelText("Message your crew") as HTMLTextAreaElement,
  };
}
it("searches usernames case-insensitively, chooses with keyboard and inserts at the caret without sending", async () => {
  const { api, user, field } = await mount();
  await user.type(field, "Please @JO tail");
  field.setSelectionRange(10, 10);
  fireEvent.select(field);
  await screen.findByRole("option", { name: "@johncena" });
  fireEvent.keyDown(field, { key: "Enter" });
  expect(field.value).toBe("Please @johncena tail");
  expect(field.selectionStart).toBe(17);
  expect(api.send).not.toHaveBeenCalled();
  fireEvent.keyDown(field, { key: "Enter" });
  await waitFor(() => expect(api.send).toHaveBeenCalledOnce());
  expect(vi.mocked(api.send).mock.calls[0][5]).toEqual([{ actor: john.actor, start: 7, end: 16 }]);
});
it("uses pointer/Tab/arrow selection, maintains multiple references, and deduplicates repeated selection", async () => {
  const { api, user, field } = await mount();
  await user.type(field, "@j");
  await user.click(await screen.findByRole("button", { name: "@johncena" }));
  expect(field.value).toBe("@johncena ");
  field.setSelectionRange(9, 9);
  fireEvent.select(field);
  await screen.findByRole("option", { name: "@johncena" });
  fireEvent.keyDown(field, { key: "Tab" });
  await user.type(field, "and @");
  await screen.findByRole("option", { name: "@alice" });
  fireEvent.keyDown(field, { key: "ArrowDown" });
  fireEvent.keyDown(field, { key: "ArrowUp" });
  fireEvent.keyDown(field, { key: "Tab" });
  expect(field.value).toBe("@johncena and @alice ");
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(api.send).toHaveBeenCalledOnce());
  expect(vi.mocked(api.send).mock.calls[0][5]).toEqual([
    { actor: john.actor, start: 0, end: 9 },
    { actor: alice.actor, start: 14, end: 20 },
  ]);
});
it("preserves retry identity and attachments; edits remove ping metadata; per-thread references survive navigation", async () => {
  const { api, user, field } = await mount();
  api.send = vi.fn().mockRejectedValue(Error("Synthetic interruption"));
  await user.type(field, "@john");
  fireEvent.keyDown(field, { key: "Enter" });
  await user.upload(screen.getByLabelText("Choose attachments"), new File(["fixture"], "note.txt"));
  await screen.findByRole("button", { name: "Remove note.txt" });
  await user.click(screen.getByRole("button", { name: "Recover interrupted work" }));
  await screen.findByText(/Worker execution stopped/);
  await user.type(field, "other @johncena literal");
  await user.click(screen.getByRole("button", { name: "Make agent work visible" }));
  await screen.findByRole("button", { name: "Remove note.txt" });
  expect(field.value).toBe("@johncena ");
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await screen.findByText("Synthetic interruption");
  await user.click(screen.getByRole("button", { name: "Send message" }));
  expect(vi.mocked(api.send).mock.calls[1][2]).toBe(vi.mocked(api.send).mock.calls[0][2]);
  expect(vi.mocked(api.send).mock.calls[1][5]).toEqual([{ actor: john.actor, start: 0, end: 9 }]);
  expect(vi.mocked(api.send).mock.calls[1][3]?.[0]).toMatchObject({
    name: "note.txt",
    text: "fixture",
  });
  fireEvent.change(field, { target: { value: "@alice " } });
  await user.click(screen.getByRole("button", { name: "Send message" }));
  expect(vi.mocked(api.send).mock.calls[2][2]).not.toBe(vi.mocked(api.send).mock.calls[0][2]);
  expect(vi.mocked(api.send).mock.calls[2][5]).toBeUndefined();
});
it("never consumes IME Enter, respects Escape and leaves code/escaped/unmatched mentions literal", async () => {
  const { api, user, field } = await mount();
  await user.type(field, "@jo");
  fireEvent.compositionStart(field);
  fireEvent.keyDown(field, { key: "Enter" });
  expect(api.send).not.toHaveBeenCalled();
  expect(screen.queryByRole("listbox", { name: "Mention a member" })).toBeNull();
  fireEvent.compositionEnd(field);
  await screen.findByRole("option", { name: "@johncena" });
  fireEvent.keyDown(field, { key: "Escape" });
  expect(screen.queryByRole("listbox", { name: "Mention a member" })).toBeNull();
  for (const text of ["`@john`", "\\@john", "```\n@john", "@missing"]) {
    fireEvent.change(field, { target: { value: text } });
    field.setSelectionRange(text.length, text.length);
    fireEvent.select(field);
    expect(screen.queryByRole("listbox", { name: "Mention a member" })).toBeNull();
  }
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(api.send).toHaveBeenCalledOnce());
  expect(vi.mocked(api.send).mock.calls[0][1]).toBe("@missing");
  expect(vi.mocked(api.send).mock.calls[0][5]).toBeUndefined();
});
it("renders clickable stable member identity after rename, recipient-only indication, and literal revoked references", async () => {
  const message: Snapshot["messages"][number] = {
    id: "m",
    threadId: "t",
    role: "user",
    content: "Hi @johncena and @missing",
    createdAt: "2026-10-07T12:00:00Z",
    mentions: [{ actor: john.actor, username: "johncena", start: 3, end: 12 }],
  };
  const { rerender } = render(
    <>
      <MessageContent message={message} members={[{ ...john, username: "renamed" }]} />
      <Mentioned message={message} recipient={john.actor} />
    </>,
  );
  expect(screen.getByText("Mentioned you")).toBeTruthy();
  await userEvent.setup().click(screen.getByRole("button", { name: "View @renamed" }));
  expect(screen.getByRole("dialog", { name: "@renamed" }).textContent).toContain("Member");
  fireEvent.keyDown(screen.getByRole("button", { name: "View @renamed" }), { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  rerender(
    <>
      <MessageContent message={message} members={[]} />
      <Mentioned message={message} recipient={alice.actor} />
    </>,
  );
  expect(screen.queryByRole("button", { name: /View/ })).toBeNull();
  expect(screen.getByText("Hi @johncena and @missing")).toBeTruthy();
  expect(screen.queryByText("Mentioned you")).toBeNull();
});
it("fences late rosters after thread/account switches and clears failed reads", async () => {
  let resolve!: (members: Member[]) => void;
  const pending = new Promise<Member[]>((done) => {
    resolve = done;
  });
  const api = collaboration();
  api.threadMembers = vi.fn((thread) => (thread === "old" ? pending : Promise.resolve([alice])));
  function Roster({ thread, account = "owner" }: { thread: string; account?: string }) {
    return (
      <div>
        {useMentionMembers(api, thread, true, account)
          .map((member) => member.username)
          .join(",")}
      </div>
    );
  }
  const { rerender } = render(<Roster thread="old" />);
  rerender(<Roster thread="new" />);
  await screen.findByText("alice");
  await act(async () => resolve([john]));
  expect(screen.queryByText("johncena")).toBeNull();
  api.threadMembers = vi.fn().mockRejectedValue(Error("revoked"));
  rerender(<Roster thread="new" account="john" />);
  expect(screen.queryByText("alice")).toBeNull();
  await act(async () => {});
  expect(screen.queryByText("johncena")).toBeNull();
});
