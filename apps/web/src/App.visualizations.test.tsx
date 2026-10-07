import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { App } from "./App";
import { createVisualizationPollingFixture } from "../poc/polling-fixture";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});
async function mount() {
  const intervals = vi.spyOn(window, "setInterval");
  const fixture = createVisualizationPollingFixture();
  const view = render(<App api={fixture.api} viewer={fixture.viewer} demo />);
  await act(async () => {});
  await screen.findByRole("heading", { name: "Make agent work visible" });
  await screen.findByText("Show the work behind a change, from delegation to review.");
  fireEvent.click(screen.getByRole("tab", { name: "Visuals" }));
  await screen.findByTitle("Polling chart 1");
  fireEvent.click(screen.getByRole("button", { name: "Next visualizations" }));
  const frame = screen.getByTitle("Polling chart 3");
  const poll = intervals.mock.calls
    .filter(([, milliseconds]) => milliseconds === 15000)
    .at(-1)?.[0];
  if (typeof poll !== "function") throw Error("The actual App membership interval is missing");
  return { ...fixture, view, frame, poll };
}
it("preserves the selected visualization page and frame across repeated unchanged membership polls, then clears revoked access", async () => {
  const fixture = await mount();
  const before = fixture.counts.threads;
  for (let poll = 1; poll <= 3; poll++) {
    await act(async () => {
      fixture.poll();
    });
    expect(fixture.counts.threads).toBeGreaterThanOrEqual(before + poll);
    expect(screen.getByTitle("Polling chart 3")).toBe(fixture.frame);
    expect(screen.getByText("Page 2 of 2")).toBeTruthy();
  }
  fixture.revoke();
  await act(async () => {
    fixture.poll();
  });
  expect(fixture.frame.isConnected).toBe(false);
  expect(fixture.view.container.querySelector("iframe")).toBeNull();
  expect(screen.queryByText(/Private polling description/)).toBeNull();
});
it("disposes the frame when the verified visualization session epoch changes", async () => {
  const fixture = await mount();
  fixture.rotateSession();
  await waitFor(() => expect(fixture.frame.isConnected).toBe(false), { timeout: 4000 });
  expect(screen.getByTitle("Polling chart 3")).not.toBe(fixture.frame);
});
it.each(["account", "transport", "project", "thread"])(
  "disposes the old visualization after %s changes",
  async (change) => {
    const fixture = await mount();
    if (change === "account")
      fixture.view.rerender(
        <App api={fixture.api} viewer={{ ...fixture.viewer, id: "other" }} demo />,
      );
    else if (change === "transport")
      fixture.view.rerender(<App api={{ ...fixture.api }} viewer={fixture.viewer} demo />);
    else
      fireEvent.click(
        screen.getByRole("button", {
          name:
            change === "project" ? "New conversation in Playground" : "Recover interrupted work",
        }),
      );
    await act(async () => {});
    expect(fixture.frame.isConnected).toBe(false);
  },
);
