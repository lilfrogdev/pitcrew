import { act, cleanup, fireEvent, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { ApiError, type CollaborationApi } from "./api";
import { createFixtureApi } from "./fixtures";
import { useSidebarData } from "./useSidebarData";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
it("refreshes other shared repositories periodically and clears denied lists on reconnect", async () => {
  vi.useFakeTimers();
  const api = createFixtureApi();
  const projects = await api.projects();
  api.collaboration = {} as CollaborationApi;
  api.latestRun = undefined;
  api.threads = vi.fn(async () => [
    { id: "old-thread", projectId: projects[1].id, title: "Old shared thread" },
  ]);
  const context = {
    api,
    projects,
    projectId: projects[0].id,
    threads: [],
    threadId: "",
    visibleRepositories: [],
    pinnedConversations: [],
    revision: 0,
  };
  const { result } = renderHook(() => useSidebarData(context));
  await act(async () => {});
  expect(result.current.lists[projects[1].id][0].title).toBe("Old shared thread");
  vi.mocked(api.threads).mockResolvedValue([
    { id: "new-thread", projectId: projects[1].id, title: "New shared thread" },
  ]);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15000);
  });
  expect(result.current.lists[projects[1].id][0].title).toBe("New shared thread");
  vi.mocked(api.threads).mockRejectedValue(new ApiError(404));
  await act(async () => {
    fireEvent(window, new Event("online"));
  });
  expect(result.current.lists[projects[1].id]).toBeUndefined();
});
