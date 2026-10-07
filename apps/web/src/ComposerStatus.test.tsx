import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { ComposerStatus } from "./ComposerStatus";
import styles from "./ComposerStatus.module.css";
import { PresenceClient, type PresenceApi } from "./thread-presence";
afterEach(cleanup);
it("has no visible strip or reserved slot while idle, and collapses when every status clears", () => {
  const { container, rerender } = render(<ComposerStatus usernames={[]} reconnecting={false} />);
  const live = screen.getByRole("status");
  const expectIdle = () => {
    expect(container.querySelector(`.${styles.slot}`)).toBeNull();
    expect(container.querySelector(`.${styles.status}`)).toBeNull();
    expect(container.querySelector('[data-visible="true"]')).toBeNull();
    expect(container.querySelector(`.${styles.liveRegion}`)).not.toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(live.textContent).toBe("");
  };
  expectIdle();
  rerender(<ComposerStatus usernames={[]} reconnecting />);
  expect(live.textContent).toBe("Reconnecting…");
  rerender(<ComposerStatus usernames={[]} reconnecting={false} />);
  expectIdle();
  rerender(<ComposerStatus usernames={[]} reconnecting={false} approval={{ onOpen: vi.fn() }} />);
  expect(live.textContent).toBe("Agent needs your approval");
  rerender(<ComposerStatus usernames={[]} reconnecting={false} />);
  expectIdle();
  expect(screen.getByRole("status")).toBe(live);
});
it("removes the visible strip on lease expiry and an empty authenticated presence response", async () => {
  let now = 10000;
  const api: PresenceApi = {
    read: vi.fn(async () => ({ typers: [{ username: "Alice", expiresInMs: 6000 }] })),
    write: vi.fn(async () => {}),
  };
  const { container, rerender } = render(<ComposerStatus usernames={[]} reconnecting={false} />);
  const client = new PresenceClient(
    api,
    "thread",
    "00000000-0000-0000-0000-000000000001",
    (state) => rerender(<ComposerStatus {...state} />),
    () => now,
  );
  await client.read();
  expect(screen.getByRole("status").textContent).toBe("Alice is typing…");
  now += 6000;
  client.tick();
  expect(screen.getByRole("status").textContent).toBe("");
  expect(container.querySelector(`.${styles.slot}`)).toBeNull();
  await client.read();
  expect(screen.getByRole("status").textContent).toBe("Alice is typing…");
  vi.mocked(api.read).mockResolvedValue({ typers: [] });
  await client.read();
  expect(screen.getByRole("status").textContent).toBe("");
  expect(container.querySelector(`.${styles.slot}`)).toBeNull();
  client.close();
});
it("shows one/two/several names with polite status and deterministic priority", () => {
  const onOpen = vi.fn();
  const { rerender } = render(<ComposerStatus usernames={["Alice"]} reconnecting={false} />);
  const live = screen.getByRole("status");
  expect(screen.getByRole("status").textContent).toBe("Alice is typing…");
  rerender(<ComposerStatus usernames={["Alice", "Bob"]} reconnecting={false} />);
  expect(screen.getByRole("status").textContent).toBe("Alice and Bob are typing…");
  rerender(<ComposerStatus usernames={["Alice", "Bob", "Charlie"]} reconnecting={false} />);
  expect(screen.getByRole("status").textContent).toBe("Several people are typing…");
  rerender(<ComposerStatus usernames={["Alice"]} reconnecting />);
  expect(screen.getByRole("status").textContent).toBe("Reconnecting…");
  rerender(<ComposerStatus usernames={["Alice"]} reconnecting approval={{ onOpen }} />);
  expect(screen.getByRole("status").textContent).toBe("Agent needs your approval");
  fireEvent.click(screen.getByRole("button", { name: "Review" }));
  expect(onOpen).toHaveBeenCalledOnce();
  rerender(<ComposerStatus usernames={["Alice"]} reconnecting={false} />);
  expect(screen.getByRole("status").textContent).toBe("Alice is typing…");
  expect(screen.getByRole("status").getAttribute("aria-live")).toBe("polite");
  expect(screen.getByRole("status")).toBe(live);
});
