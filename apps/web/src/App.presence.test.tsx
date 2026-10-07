import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { App } from "./App";
import { createFixtureApi } from "./fixtures";
afterEach(() => {
  cleanup();
  localStorage.clear();
});
async function mount(approval = false) {
  const api = createFixtureApi();
  const capabilities = api.capabilities;
  api.capabilities = async () => ({
    ...(await capabilities()),
    landing: { enabled: approval, backend: "fixture" },
  });
  api.presence = {
    read: vi.fn(async () => ({ typers: [{ username: "Alice", expiresInMs: 6000 }] })),
    write: vi.fn(async () => {}),
  };
  api.approve = vi.fn(api.approve);
  api.send = vi.fn(api.send);
  render(<App api={api} demo />);
  await screen.findByText("Show the work behind a change, from delegation to review.");
  return api;
}
it("signals IME input, keeps composing Enter local, and stops on blur/send/thread/window lifecycle", async () => {
  const api = await mount();
  const field = screen.getByLabelText("Message your crew");
  fireEvent.compositionStart(field);
  fireEvent.compositionUpdate(field);
  await waitFor(() =>
    expect(vi.mocked(api.presence!.write).mock.calls.at(-1)?.[1].active).toBe(true),
  );
  fireEvent.change(field, { target: { value: "未完成 private draft" } });
  fireEvent.keyDown(field, { key: "Enter", isComposing: true });
  expect(api.send).not.toHaveBeenCalled();
  fireEvent.compositionEnd(field);
  fireEvent.blur(field);
  await waitFor(() =>
    expect(vi.mocked(api.presence!.write).mock.calls.at(-1)?.[1].active).toBe(false),
  );
  fireEvent.change(field, { target: { value: "New local draft" } });
  fireEvent(window, new Event("blur"));
  await waitFor(() =>
    expect(vi.mocked(api.presence!.write).mock.calls.at(-1)?.[1].active).toBe(false),
  );
  fireEvent(window, new Event("focus"));
  fireEvent.change(field, { target: { value: "Changed after focus" } });
  fireEvent(window, new Event("pagehide"));
  await waitFor(() =>
    expect(vi.mocked(api.presence!.write).mock.calls.at(-1)?.[1].active).toBe(false),
  );
  fireEvent(window, new Event("pageshow"));
  fireEvent.change(field, { target: { value: "Before navigation" } });
  fireEvent.click(screen.getByRole("button", { name: "Recover interrupted work" }));
  await screen.findByText(/Worker execution stopped/);
  await waitFor(() =>
    expect(vi.mocked(api.presence!.write).mock.calls.at(-1)?.[1].active).toBe(false),
  );
  fireEvent.change(field, { target: { value: "Send synthetic message" } });
  fireEvent.keyDown(field, { key: "Enter" });
  await waitFor(() => expect(api.send).toHaveBeenCalledOnce());
  await waitFor(() =>
    expect(vi.mocked(api.presence!.write).mock.calls.at(-1)?.[1].active).toBe(false),
  );
  expect(JSON.stringify(vi.mocked(api.presence!.write).mock.calls)).not.toContain("private draft");
});
it("opens the existing actionable approval without granting approval and restores typing after it clears", async () => {
  const api = await mount(true);
  await screen.findByText("Agent needs your approval");
  fireEvent.click(screen.getByRole("button", { name: "Collapse workspace" }));
  fireEvent.click(screen.getByRole("button", { name: /^Review$/ }));
  await waitFor(() =>
    expect(screen.getByRole("tab", { name: "Review / PR" }).getAttribute("aria-selected")).toBe(
      "true",
    ),
  );
  await waitFor(() => expect(document.activeElement?.textContent).toBe("Approve exact candidate"));
  expect(api.approve).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Approve exact candidate" }));
  await waitFor(() => expect(api.approve).toHaveBeenCalledOnce());
  await screen.findByText("Alice is typing…");
});
