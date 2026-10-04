import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { Api, Project, Run, Thread } from "./api";
import { createFixtureApi } from "./fixtures";
import { Sidebar } from "./Sidebar";

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const projects: Project[] = [
  {
    id: "selected",
    name: "Selected",
    repository: "owner/selected",
    baseSha: "base",
    configurationRevision: "v1",
  },
  {
    id: "other",
    name: "Other",
    repository: "owner/other",
    baseSha: "base",
    configurationRevision: "v1",
  },
];
const selected = { id: "active", projectId: "selected", title: "Active conversation" };
const idle = { id: "idle", projectId: "selected", title: "Idle conversation" };
const pinned = { id: "pinned", projectId: "other", title: "Pinned conversation" };
function run(id: string, status: Run["status"] = "completed"): Run {
  return { id: `run-${id}`, threadId: id, status, baseSha: "base", configurationRevision: "v1" };
}
function mount(api: Api, threads: Thread[] = [selected, idle]) {
  return render(
    <Sidebar
      api={api}
      projects={projects}
      projectId="selected"
      threads={threads}
      threadId="active"
      revision={0}
      busy={false}
      activeRun={run("active", "running")}
      onSelect={() => {}}
      onCreate={() => {}}
    />,
  );
}
async function advance(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
describe("sidebar background request regressions", () => {
  it("deduplicates a visible pin and suspends its status reads when unpinned and collapsed", async () => {
    vi.useFakeTimers();
    localStorage.setItem(
      "pitcrew.sidebar.pins.v1",
      JSON.stringify({ repositories: [], conversations: ["idle"] }),
    );
    const api = createFixtureApi();
    api.threads = vi.fn(async () => []);
    api.latestRun = vi.fn(async () => run("idle", "running"));
    mount(api);
    await advance();
    expect(api.latestRun).toHaveBeenCalledTimes(1);
    fireEvent.click(
      within(screen.getByRole("region", { name: "Pinned" })).getByRole("button", {
        name: "Unpin conversation Idle conversation",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Selected · owner/selected" }));
    await advance(10000);
    expect(api.latestRun).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Selected · owner/selected" }));
    await advance();
    expect(api.latestRun).toHaveBeenCalledTimes(2);
  });
  it("caches a successful no-run result and revalidates after returning from a hidden tab", async () => {
    vi.useFakeTimers();
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    const api = createFixtureApi();
    api.threads = vi.fn(async () => []);
    api.latestRun = vi.fn().mockResolvedValue(undefined);
    mount(api);
    await advance(30000);
    expect(api.latestRun).toHaveBeenCalledTimes(1);
    hidden.mockReturnValue(true);
    fireEvent(document, new Event("visibilitychange"));
    fireEvent(window, new Event("online"));
    await advance(5000);
    expect(api.latestRun).toHaveBeenCalledTimes(1);
    hidden.mockReturnValue(false);
    fireEvent(document, new Event("visibilitychange"));
    await advance();
    expect(api.latestRun).toHaveBeenCalledTimes(2);
  });
  it("caps in-flight reads across rerenders and stops active polling after completion", async () => {
    vi.useFakeTimers();
    const api = createFixtureApi();
    api.threads = vi.fn(async () => []);
    let inFlight = 0;
    let peak = 0;
    const pending: Array<() => void> = [];
    api.latestRun = vi.fn(
      (id: string) =>
        new Promise<Run>((resolve) => {
          peak = Math.max(peak, ++inFlight);
          pending.push(() => {
            inFlight--;
            resolve(run(id));
          });
        }),
    );
    const threads = [
      selected,
      ...Array.from({ length: 8 }, (_, i) => ({
        id: `visible-${i}`,
        projectId: "selected",
        title: `Visible ${i}`,
      })),
    ];
    const view = mount(api, threads);
    await advance();
    expect(inFlight).toBe(4);
    view.rerender(
      <Sidebar
        api={api}
        projects={projects}
        projectId="selected"
        threads={[...threads]}
        threadId="active"
        revision={0}
        busy={false}
        activeRun={run("active", "running")}
        onSelect={() => {}}
        onCreate={() => {}}
      />,
    );
    await advance();
    expect(inFlight).toBe(4);
    expect(peak).toBe(4);
    while (pending.length) {
      await act(async () => {
        pending.splice(0).forEach((resolve) => resolve());
      });
    }
    expect(api.latestRun).toHaveBeenCalledTimes(8);
    await advance(30000);
    expect(api.latestRun).toHaveBeenCalledTimes(8);
  });
  it.each(["queued", "running", "waiting_user", "awaiting_review"] as const)(
    "polls mutable %s state only while visible and stops on completion",
    async (status) => {
      vi.useFakeTimers();
      const api = createFixtureApi();
      api.threads = vi.fn(async () => []);
      api.latestRun = vi
        .fn()
        .mockResolvedValueOnce(run("idle", status))
        .mockResolvedValue(run("idle"));
      mount(api);
      await advance();
      expect(api.latestRun).toHaveBeenCalledTimes(1);
      await advance(5000);
      expect(api.latestRun).toHaveBeenCalledTimes(2);
      await advance(30000);
      expect(api.latestRun).toHaveBeenCalledTimes(2);
    },
  );
  it("backs off failed lists, retains successful cached pins across navigation, and stops retries on unmount", async () => {
    vi.useFakeTimers();
    localStorage.setItem(
      "pitcrew.sidebar.pins.v1",
      JSON.stringify({ repositories: [], conversations: ["pinned"] }),
    );
    const api = createFixtureApi();
    api.threads = vi
      .fn()
      .mockRejectedValueOnce(new Error("Failure 1"))
      .mockRejectedValueOnce(new Error("Failure 2"))
      .mockResolvedValue([pinned]);
    const view = mount(api, [selected]);
    await advance(5000);
    expect(api.threads).toHaveBeenCalledTimes(2);
    await advance(5000);
    expect(api.threads).toHaveBeenCalledTimes(2);
    await advance(5000);
    expect(api.threads).toHaveBeenCalledTimes(3);
    expect(
      within(screen.getByRole("region", { name: "Pinned" })).getByRole("button", {
        name: "Pinned conversation",
      }),
    ).toBeTruthy();
    api.threads = vi.fn().mockRejectedValue(new Error("Refresh failure"));
    view.rerender(
      <Sidebar
        api={api}
        projects={projects}
        projectId="selected"
        threads={[selected]}
        threadId="active"
        revision={1}
        busy={false}
        onSelect={() => {}}
        onCreate={() => {}}
      />,
    );
    await advance();
    expect(
      within(screen.getByRole("region", { name: "Pinned" })).getByRole("button", {
        name: "Pinned conversation",
      }),
    ).toBeTruthy();
    view.unmount();
    await advance(60000);
    expect(api.threads).toHaveBeenCalledTimes(1);
  });
  it("ignores old API responses after replacement without exceeding the shared request budget", async () => {
    vi.useFakeTimers();
    let oldResolve: (items: Thread[]) => void = () => {};
    const api = createFixtureApi();
    api.threads = vi.fn(
      () =>
        new Promise<Thread[]>((resolve) => {
          oldResolve = resolve;
        }),
    );
    const view = mount(api, [selected]);
    await advance();
    const replacement = createFixtureApi();
    replacement.threads = vi.fn(async () => [pinned]);
    localStorage.setItem(
      "pitcrew.sidebar.pins.v1",
      JSON.stringify({ repositories: [], conversations: [] }),
    );
    view.rerender(
      <Sidebar
        api={replacement}
        projects={projects}
        projectId="selected"
        threads={[selected]}
        threadId="active"
        revision={0}
        busy={false}
        onSelect={() => {}}
        onCreate={() => {}}
      />,
    );
    await advance();
    await act(async () =>
      oldResolve([{ id: "stale", projectId: "other", title: "Stale conversation" }]),
    );
    expect(screen.queryByRole("button", { name: "Stale conversation" })).toBeNull();
    expect(replacement.threads).toHaveBeenCalledTimes(1);
  });
  it("reads only visible or pinned statuses without fetching complete snapshots or polling terminal runs", async () => {
    vi.useFakeTimers();
    localStorage.setItem(
      "pitcrew.sidebar.pins.v1",
      JSON.stringify({ repositories: [], conversations: ["pinned"] }),
    );
    const api = createFixtureApi();
    api.threads = vi.fn(async () => [
      pinned,
      ...Array.from({ length: 20 }, (_, i) => ({
        id: `hidden-${i}`,
        projectId: "other",
        title: `Hidden ${i}`,
      })),
    ]);
    api.snapshot = vi.fn(api.snapshot);
    const latestRun = vi.fn(async (id: string) => run(id));
    Object.assign(api, { latestRun });
    mount(api);
    await advance();
    expect(api.snapshot).not.toHaveBeenCalled();
    expect(latestRun.mock.calls.map(([id]) => id).sort()).toEqual(["idle", "pinned"]);
    await advance(30000);
    expect(latestRun).toHaveBeenCalledTimes(2);
  });
  it("retries a transient failed list request and restores a saved pin without navigation or reload", async () => {
    vi.useFakeTimers();
    localStorage.setItem(
      "pitcrew.sidebar.pins.v1",
      JSON.stringify({ repositories: [], conversations: ["pinned"] }),
    );
    const api = createFixtureApi();
    api.threads = vi
      .fn()
      .mockRejectedValueOnce(new Error("Temporary failure"))
      .mockResolvedValue([pinned]);
    mount(api, [selected]);
    await advance();
    const pins = screen.getByRole("region", { name: "Pinned" });
    expect(within(pins).queryByRole("button", { name: "Pinned conversation" })).toBeNull();
    await advance(5000);
    expect(within(pins).getByRole("button", { name: "Pinned conversation" })).toBeTruthy();
    expect(api.threads).toHaveBeenCalledTimes(2);
  });
  it("retries failed lists on reconnection and does not refetch successful lists", async () => {
    vi.useFakeTimers();
    const api = createFixtureApi();
    api.threads = vi.fn().mockRejectedValueOnce(new Error("Offline")).mockResolvedValue([pinned]);
    mount(api, [selected]);
    await advance();
    fireEvent(window, new Event("online"));
    await advance();
    expect(api.threads).toHaveBeenCalledTimes(2);
    fireEvent(window, new Event("online"));
    await advance(10000);
    expect(api.threads).toHaveBeenCalledTimes(2);
  });
});
