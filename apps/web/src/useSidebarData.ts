import { useEffect, useRef, useState } from "react";
import { ApiError, type Api, type Project, type Run, type Thread } from "./api";

type Context = {
  api: Api;
  projects: Project[];
  projectId: string;
  threads: Thread[];
  threadId: string;
  activeRun?: Run;
  visibleRepositories: string[];
  pinnedConversations: string[];
  revision: number;
};
type Entry<T> = { value?: T; loaded: boolean; pending: boolean; next: number; failures: number };
type Data = { lists: Record<string, Thread[]>; runs: Record<string, Run | undefined> };
const activeStatuses = new Set<Run["status"]>([
  "queued",
  "running",
  "waiting_user",
  "awaiting_review",
]);
const emptyEntry = <T>(): Entry<T> => ({ loaded: false, pending: false, next: 0, failures: 0 });
const retryDelay = (failures: number) => Math.min(5000 * 2 ** Math.min(failures - 1, 4), 60000);

// One scheduler owns the request budget across navigation, pin/search changes,
// and Strict Mode effect restarts. Sidebar reads never load messages/evidence.
function createScheduler(publish: (data: Data) => void) {
  const lists = new Map<string, Entry<Thread[]>>();
  const runs = new Map<string, Entry<Run | undefined>>();
  let context: Context | undefined;
  let generation = 0;
  let pending = 0;
  let started = false;
  let lastActiveRun: Run | undefined;
  const emit = () =>
    publish({
      lists: Object.fromEntries(
        [...lists]
          .filter(([, entry]) => entry.loaded)
          .map(([id, entry]) => [id, entry.value ?? []]),
      ),
      runs: Object.fromEntries(
        [...runs].filter(([, entry]) => entry.loaded).map(([id, entry]) => [id, entry.value]),
      ),
    });
  const request = <T>(entry: Entry<T>, read: () => Promise<T>, next: (value: T) => number) => {
    entry.pending = true;
    pending++;
    const requestedGeneration = generation;
    void Promise.resolve()
      .then(read)
      .then((value) => {
        if (generation !== requestedGeneration) return;
        entry.value = value;
        entry.loaded = true;
        entry.failures = 0;
        entry.next = next(value);
        emit();
      })
      .catch((cause) => {
        if (generation !== requestedGeneration) return;
        if (cause instanceof ApiError && [401, 403, 404].includes(cause.status)) {
          entry.value = undefined;
          entry.loaded = false;
          emit();
        }
        entry.next = Date.now() + retryDelay(++entry.failures);
      })
      .finally(() => {
        if (generation === requestedGeneration) entry.pending = false;
        pending--;
        pump();
      });
  };
  const due = <T>(entry: Entry<T>) => !entry.pending && entry.next <= Date.now();
  const pump = () => {
    if (!started || !context || document.hidden) return;
    const {
      api,
      projects,
      projectId,
      threadId,
      threads,
      visibleRepositories,
      pinnedConversations,
    } = context;
    for (const project of projects) {
      if (pending >= 4) break;
      if (project.id === projectId) continue;
      let entry = lists.get(project.id);
      if (!entry) {
        entry = emptyEntry();
        lists.set(project.id, entry);
      }
      if (due(entry))
        request(
          entry,
          () => api.threads(project.id),
          () => api.collaboration ? Date.now() + 15000 : Infinity,
        );
    }
    const latestRun = api.latestRun;
    if (!latestRun) return;
    const visible = new Set(visibleRepositories);
    const pinned = new Set(pinnedConversations);
    const conversations = new Map<string, Thread>();
    for (const project of projects) {
      const items = project.id === projectId ? threads : (lists.get(project.id)?.value ?? []);
      for (const item of items)
        if (!item.archived && (visible.has(project.id) || pinned.has(item.id)))
          conversations.set(item.id, item);
    }
    for (const item of conversations.values()) {
      if (pending >= 4) break;
      if (item.id === threadId) continue;
      let entry = runs.get(item.id);
      if (!entry) {
        entry = emptyEntry();
        runs.set(item.id, entry);
      }
      if (due(entry))
        request(
          entry,
          () => latestRun.call(api, item.id),
          (run) => (run && activeStatuses.has(run.status) ? Date.now() + 5000 :
            api.collaboration ? Date.now() + 15000 : Infinity),
        );
    }
  };
  return {
    start() {
      started = true;
      pump();
    },
    stop() {
      started = false;
      generation++;
      for (const entry of [...lists.values(), ...runs.values()]) entry.pending = false;
    },
    update(next: Context) {
      if (context?.api !== next.api) {
        generation++;
        lists.clear();
        runs.clear();
        lastActiveRun = undefined;
      } else if (context.revision !== next.revision) {
        for (const entry of [...lists.values(), ...runs.values()]) entry.next = 0;
      }
      const newlyVisible = new Set(
        next.visibleRepositories.filter((id) => !context?.visibleRepositories.includes(id)),
      );
      const newlyPinned = new Set(
        next.pinnedConversations.filter((id) => !context?.pinnedConversations.includes(id)),
      );
      for (const project of next.projects) {
        const items =
          project.id === next.projectId ? next.threads : (lists.get(project.id)?.value ?? []);
        for (const item of items) {
          const entry = runs.get(item.id);
          if (entry && (newlyVisible.has(project.id) || newlyPinned.has(item.id))) entry.next = 0;
        }
      }
      const selectedListChanged =
        context?.projectId === next.projectId && context.threads !== next.threads;
      context = next;
      const allowed = new Set(next.projects.map((project) => project.id));
      for (const id of lists.keys()) if (!allowed.has(id)) lists.delete(id);
      // The selected repository is loaded by App. Preserve its successful list
      // for later navigation; an empty loading placeholder is not a cached result.
      if (next.projectId && (next.threads.length || selectedListChanged))
        lists.set(next.projectId, {
          value: next.threads,
          loaded: true,
          pending: false,
          next: next.api.collaboration ? Date.now() + 15000 : Infinity,
          failures: 0,
        });
      if (next.activeRun && next.activeRun !== lastActiveRun) {
        lastActiveRun = next.activeRun;
        runs.set(next.activeRun.threadId, {
          value: next.activeRun,
          loaded: true,
          pending: false,
          failures: 0,
          next: activeStatuses.has(next.activeRun.status) ? Date.now() + 5000 :
            next.api.collaboration ? Date.now() + 15000 : Infinity,
        });
      }
      emit();
      pump();
    },
    reconnect() {
      for (const entry of lists.values())
        if (context?.api.collaboration || !entry.loaded || entry.failures) entry.next = 0;
      for (const entry of runs.values()) entry.next = 0;
      pump();
    },
    pump,
  };
}

export function useSidebarData(context: Context): Data {
  const [data, setData] = useState<Data>({ lists: {}, runs: {} });
  const scheduler = useRef<ReturnType<typeof createScheduler> | undefined>(undefined);
  if (!scheduler.current) scheduler.current = createScheduler(setData);
  const { api, projects, projectId, threads, threadId, activeRun, revision } = context;
  const visibleKey = JSON.stringify(context.visibleRepositories);
  const pinnedKey = JSON.stringify(context.pinnedConversations);
  useEffect(() => {
    const current = scheduler.current!;
    current.start();
    const timer = window.setInterval(current.pump, 1000);
    const onVisible = () => {
      if (!document.hidden) current.reconnect();
    };
    window.addEventListener("online", current.reconnect);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      current.stop();
      window.clearInterval(timer);
      window.removeEventListener("online", current.reconnect);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
  useEffect(() => {
    scheduler.current!.update({
      api,
      projects,
      projectId,
      threads,
      threadId,
      activeRun,
      revision,
      visibleRepositories: JSON.parse(visibleKey),
      pinnedConversations: JSON.parse(pinnedKey),
    });
  }, [api, projects, projectId, threads, threadId, activeRun, revision, visibleKey, pinnedKey]);
  return data;
}
