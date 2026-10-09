import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { App } from "./App";
import { createFixtureApi } from "./fixtures";
import type { CollaborationApi } from "./api";

afterEach(() => {
  cleanup();
  localStorage.clear();
});
async function mount(options: { disconnected?: boolean; humanAgent?: boolean } = {}) {
  const api = createFixtureApi();
  if (options.disconnected)
    api.capabilities = vi.fn(async () => ({ landing: { enabled: false, backend: null } }));
  if (options.humanAgent)
    api.collaboration = {
      threadMembers: vi.fn(async () => [
        { actor: "account:agent", username: "agent", email: "agent@example.test", role: "editor" },
      ]),
      account: vi.fn(async () => ({
        actor: "account:owner",
        username: "owner",
        email: "owner@example.test",
      })),
    } as unknown as CollaborationApi;
  api.send = vi.fn(api.send);
  render(<App api={api} demo />);
  await screen.findByText("Show the work behind a change, from delegation to review.");
  if (options.humanAgent)
    await waitFor(() => expect(api.collaboration!.threadMembers).toHaveBeenCalled());
  return {
    api,
    user: userEvent.setup(),
    field: screen.getByLabelText("Message your crew") as HTMLTextAreaElement,
  };
}
const destination = (name: "Agent" | "Team") => screen.getByRole("button", { name });

it("defaults Team, toggles only plain focused Tab, and offers Escape then Tab as forward focus escape", async () => {
  const { user, field } = await mount();
  expect(destination("Team").getAttribute("aria-pressed")).toBe("true");
  await user.type(field, "Preserve draft");
  await user.tab();
  expect(destination("Agent").getAttribute("aria-pressed")).toBe("true");
  expect(document.activeElement).toBe(field);
  expect(field.value).toBe("Preserve draft");
  fireEvent.compositionStart(field);
  expect(fireEvent.keyDown(field, { key: "Tab", isComposing: true })).toBe(true);
  expect(destination("Agent").getAttribute("aria-pressed")).toBe("true");
  fireEvent.compositionEnd(field);
  expect(fireEvent.keyDown(field, { key: "Tab", shiftKey: true })).toBe(true);
  expect(fireEvent.keyDown(field, { key: "Tab", ctrlKey: true })).toBe(true);
  await user.keyboard("{Escape}");
  await user.tab();
  expect(document.activeElement).toBe(destination("Team"));
  expect(destination("Agent").getAttribute("aria-pressed")).toBe("true");
  await user.click(destination("Team"));
  expect(field.value).toBe("Preserve draft");
});

it("lets Team send with no provider, but blocks Agent invocation without losing text", async () => {
  const { api, user, field } = await mount({ disconnected: true });
  await user.type(field, "Team note");
  await user.click(destination("Agent"));
  fireEvent.submit(field.closest("form")!);
  expect(api.send).not.toHaveBeenCalled();
  expect(field.value).toBe("Team note");
  await user.click(destination("Team"));
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await screen.findByText("Team message sent.");
  expect(vi.mocked(api.send).mock.calls[0].slice(4)).toEqual([
    undefined,
    undefined,
    "team",
    undefined,
  ]);
});

it("tracks explicitly typed agent tokens with rebased ranges and keeps them when switching destinations", async () => {
  const { api, user, field } = await mount();
  await user.type(field, "@agent and @agent work");
  field.setSelectionRange(0, 0);
  await user.keyboard(" ");
  field.setSelectionRange(0, 0);
  await user.keyboard("Please");
  await user.click(destination("Agent"));
  await user.click(destination("Team"));
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(api.send).toHaveBeenCalledOnce());
  expect(vi.mocked(api.send).mock.calls[0][7]).toEqual([
    { start: 7, end: 13 },
    { start: 18, end: 24 },
  ]);
  await screen.findByText("Message sent and agent reply queued.");
});

it.each([
  "@agent",
  "'quoted @agent'",
  '"quoted @agent"',
  "`@agent`",
  "> @agent",
  "```\n@agent\n```",
])("leaves pasted %s literal when Enter sends a Team note", async (text) => {
  const { api, user, field } = await mount();
  await user.click(field);
  await user.paste(text);
  expect(screen.queryByRole("option", { name: "@agent · Agent" })).toBeNull();
  await user.keyboard("{Enter}");
  await waitFor(() => expect(api.send).toHaveBeenCalledOnce());
  expect(vi.mocked(api.send).mock.calls[0][7]).toBeUndefined();
  expect(vi.mocked(api.send).mock.calls[0][6]).toBe("team");
  await screen.findByText("Team message sent.");
});

it("distinguishes reserved agent picker selection from a human named agent, and autocomplete consumes Tab", async () => {
  const { api, user, field } = await mount({ humanAgent: true });
  api.send = vi.fn().mockRejectedValue(Error("Uncertain write"));
  await user.type(field, "@ag");
  await screen.findByRole("option", { name: "@agent · Member" });
  await user.click(screen.getByRole("button", { name: "@agent · Member" }));
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await screen.findByText("Uncertain write");
  const human = vi.mocked(api.send).mock.calls[0];
  expect(human[5]).toEqual([{ actor: "account:agent", start: 0, end: 6 }]);
  expect(human[7]).toBeUndefined();
  field.focus();
  field.setSelectionRange(6, 6);
  fireEvent.select(field);
  await screen.findByRole("option", { name: "@agent · Agent" });
  fireEvent.keyDown(field, { key: "Tab" });
  expect(destination("Team").getAttribute("aria-pressed")).toBe("true");
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(api.send).toHaveBeenCalledTimes(2));
  const agent = vi.mocked(api.send).mock.calls[1];
  expect(agent[1]).toBe(human[1]);
  expect(agent[2]).not.toBe(human[2]);
  expect(agent[5]).toBeUndefined();
  expect(agent[7]).toEqual([{ start: 0, end: 6 }]);
});

it("binds retries to destination and metadata and retains attachments across switching", async () => {
  const { api, user, field } = await mount();
  api.send = vi.fn().mockRejectedValue(Error("Interrupted"));
  await user.type(field, "@agent work");
  await user.upload(screen.getByLabelText("Choose attachments"), new File(["fixture"], "note.txt"));
  await screen.findByRole("button", { name: "Remove note.txt" });
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await screen.findByText("Interrupted");
  await user.click(screen.getByRole("button", { name: "Send message" }));
  expect(vi.mocked(api.send).mock.calls[1][2]).toBe(vi.mocked(api.send).mock.calls[0][2]);
  await user.click(destination("Agent"));
  expect(field.value).toBe("@agent work");
  expect(screen.getByRole("button", { name: "Remove note.txt" })).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Send message" }));
  expect(vi.mocked(api.send).mock.calls[2][2]).not.toBe(vi.mocked(api.send).mock.calls[1][2]);
  // Replacing the selected token invalidates its invocation metadata.
  fireEvent.change(field, { target: { value: "@agents work" } });
  await user.click(destination("Team"));
  await user.click(screen.getByRole("button", { name: "Send message" }));
  expect(vi.mocked(api.send).mock.calls[3][7]).toBeUndefined();
});

it("does not resubmit after a successful write followed by an interrupted read", async () => {
  const { api, user, field } = await mount();
  const read = api.snapshot;
  await user.type(field, "Team write");
  api.snapshot = vi.fn().mockRejectedValueOnce(Error("Interrupted read")).mockImplementation(read);
  fireEvent.keyDown(field, { key: "Enter" });
  fireEvent.keyDown(field, { key: "Enter" });
  await screen.findByText("Reconnecting…");
  expect(field.value).toBe("");
  await act(async () => fireEvent(window, new Event("online")));
  await screen.findByText("Team write");
  expect(api.send).toHaveBeenCalledOnce();
});

it("keeps Team image notes independent of model compatibility while Agent keeps its input checks", async () => {
  const { api, user, field } = await mount();
  const data =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
  await user.upload(
    screen.getByLabelText("Choose attachments"),
    new File([Uint8Array.from(atob(data), (char) => char.charCodeAt(0))], "note.png", {
      type: "image/png",
    }),
  );
  await screen.findByAltText("Preview of note.png");
  await user.type(field, "Team image note");
  await user.click(screen.getByRole("combobox", { name: "Repo agent model" }));
  await user.click(screen.getByRole("gridcell", { name: "Fixture text (synthetic)" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Send message" })).toHaveProperty("disabled", false),
  );
  await user.click(destination("Agent"));
  expect(screen.getByRole("button", { name: "Send message" })).toHaveProperty("disabled", true);
  await user.click(destination("Team"));
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await screen.findByText("Team message sent.");
  expect(vi.mocked(api.send).mock.calls[0][4]).toBeUndefined();
  expect(vi.mocked(api.send).mock.calls[0][3]?.[0]).toMatchObject({ mediaType: "image/png", data });
});
it.each(["'quoted @agent'", '"quoted @agent"', "`@agent`", "> @agent", "\\@agent"])(
  "keeps typed %s literal after completing the protected token",
  async (text) => {
    const { api, user, field } = await mount();
    await user.type(field, text);
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(api.send).toHaveBeenCalledOnce());
    expect(vi.mocked(api.send).mock.calls[0][7]).toBeUndefined();
  },
);

it("invalidates an agent token overwritten by identical pasted text", async () => {
  const { api, user, field } = await mount();
  await user.type(field, "@agent work");
  field.setSelectionRange(0, 6);
  await user.paste("@agent");
  expect(field.value).toBe("@agent work");
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(api.send).toHaveBeenCalledOnce());
  expect(vi.mocked(api.send).mock.calls[0][7]).toBeUndefined();
  await screen.findByText("Team message sent.");
});

it("keeps paste-origin insertText events literal until a new typed keystroke", async () => {
  const { api, user, field } = await mount();
  await user.click(field);
  fireEvent.paste(field, { clipboardData: { files: [] } });
  fireEvent.input(field, { target: { value: "Pasted @agent" }, inputType: "insertText" });
  fireEvent.input(field, {
    target: { value: "Pasted @agent stays literal" },
    inputType: "insertText",
  });
  fireEvent.keyDown(field, { key: "Escape" });
  fireEvent.keyDown(field, { key: "Enter" });
  await waitFor(() => expect(api.send).toHaveBeenCalledOnce());
  expect(vi.mocked(api.send).mock.calls[0][7]).toBeUndefined();
  await waitFor(() => expect(field.value).toBe(""));
  await user.type(field, "@agent typed again");
  await user.click(screen.getByRole("button", { name: "Send message" }));
  expect(vi.mocked(api.send).mock.calls[1][7]).toEqual([{ start: 0, end: 6 }]);
});
