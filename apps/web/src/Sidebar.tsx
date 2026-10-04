import { useEffect, useState, type ReactNode } from "react";
import type { Api, Project, Thread, Run } from "./api";

const preferenceKey = "pitcrew.sidebar.pins.v1";
type Pins = { repositories: string[]; conversations: string[] };
function readPins(): Pins {
  try {
    const value = JSON.parse(localStorage.getItem(preferenceKey) ?? "{}");
    const ids = (items: unknown): string[] =>
      Array.isArray(items)
        ? [...new Set(items.filter((id): id is string => typeof id === "string"))]
        : [];
    return { repositories: ids(value.repositories), conversations: ids(value.conversations) };
  } catch {
    return { repositories: [], conversations: [] };
  }
}
function Icon({ kind }: { kind: "folder" | "conversation" | "pin" | "search" | "bell" }) {
  const paths = {
    bell: "M5 8a5 5 0 0 1 10 0v4l2 2H3l2-2Z M8 17h4",
    folder: "M2 5h5l2 2h9v10H2Z",
    conversation: "M3 3h14v11H8l-5 3Z",
    pin: "m7 2 6 0-1 5 3 3v2H5v-2l3-3Z M10 12v6",
    search: "M14 14l4 4 M16 9a7 7 0 1 1-14 0 7 7 0 0 1 14 0",
  };
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d={paths[kind]} />
    </svg>
  );
}
function PinButton({
  name,
  pinned,
  onClick,
}: {
  name: string;
  pinned: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className="row-action pin-action"
      aria-label={`${pinned ? "Unpin" : "Pin"} ${name}`}
      aria-pressed={pinned}
      onClick={onClick}
    >
      <Icon kind="pin" />
    </button>
  );
}
export function Sidebar({
  api,
  projects,
  projectId,
  threads,
  threadId,
  revision,
  busy,
  onSelect,
  onCreate,
  activeRun,
  children,
}: {
  api: Api;
  projects: Project[];
  projectId: string;
  threads: Thread[];
  threadId: string;
  revision: number;
  busy: boolean;
  onSelect: (repository: string, conversation?: string) => void;
  onCreate: (repository: string) => void;
  activeRun?: Run;
  children?: ReactNode;
}) {
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [notifications, setNotifications] = useState(false);
  const [pins, setPins] = useState(readPins);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [runStates, setRunStates] = useState<Record<string, Run | undefined>>({});
  const [others, setOthers] = useState<Record<string, Thread[]>>({});
  useEffect(() => {
    let cancelled = false;
    setOthers({});
    for (const repository of projects) {
      if (repository.id === projectId) continue;
      void api
        .threads(repository.id)
        .then((items) => {
          if (!cancelled) setOthers((all) => ({ ...all, [repository.id]: items }));
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [api, projects, projectId, revision]);
  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    const load = async () => {
      if (inFlight) return;
      inFlight = true;
      await Promise.all(
        [...Object.values(others).flat(), ...threads]
          .filter((item) => item.id !== threadId)
          .map(async (item) => {
            try {
              const snapshot = await api.snapshot(item.id);
              if (!cancelled) setRunStates((all) => ({ ...all, [item.id]: snapshot.runs.at(-1) }));
            } catch {
              /* Unknown state has no indicator. */
            }
          }),
      );
      inFlight = false;
    };
    void load();
    const timer = window.setInterval(() => {
      if (!document.hidden) void load();
    }, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [api, others, threads, threadId, revision]);
  const stateIndicator = (item: Thread) => {
    const run = item.id === threadId ? activeRun : runStates[item.id];
    if (!run) return null;
    const states: Record<Run["status"], [string, string]> = {
      queued: ["◷", "Queued"],
      running: ["◌", "In progress"],
      waiting_user: ["?", "Needs your attention"],
      awaiting_review: ["◇", "Awaiting review"],
      completed: ["✓", "Completed"],
      failed: ["!", "Failed"],
      stopped: ["□", "Stopped"],
    };
    const [symbol, label] = states[run.status];
    return (
      <span
        className={`conversation-state state-${run.status}`}
        role="img"
        aria-label={label}
        title={label}
      >
        {symbol}
      </span>
    );
  };
  useEffect(() => {
    try {
      localStorage.setItem(preferenceKey, JSON.stringify(pins));
    } catch {
      /* Navigation works without storage. */
    }
  }, [pins]);
  const togglePin = (kind: keyof Pins, id: string) =>
    setPins((all) => ({
      ...all,
      [kind]: all[kind].includes(id) ? all[kind].filter((item) => item !== id) : [...all[kind], id],
    }));
  const conversations = (id: string) => (id === projectId ? threads : (others[id] ?? []));
  const conversationRow = (item: Thread) => (
    <div className="sidebar-row" key={item.id}>
      <button
        className={`sidebar-item ${item.id === threadId ? "selected" : ""}`}
        aria-current={item.id === threadId ? "page" : undefined}
        aria-label={item.title}
        title={item.title}
        disabled={busy}
        onClick={() => {
          setCollapsed((all) => ({ ...all, [item.projectId]: false }));
          onSelect(item.projectId, item.id);
        }}
      >
        <span className="row-name conversation-name">{item.title}</span>
        {stateIndicator(item)}
      </button>
      <PinButton
        name={`conversation ${item.title}`}
        pinned={pins.conversations.includes(item.id)}
        onClick={() => togglePin("conversations", item.id)}
      />
    </div>
  );
  const repositoryRow = (item: Project, pinnedSection = false) => (
    <div className="sidebar-row repository-row" key={item.id}>
      <button
        className="sidebar-item"
        aria-label={`${item.name} · ${item.repository}`}
        title={item.repository}
        aria-expanded={!pinnedSection ? !(collapsed[item.id] ?? item.id !== projectId) : undefined}
        disabled={busy}
        onClick={() => {
          if (!pinnedSection && item.id === projectId)
            setCollapsed((all) => ({ ...all, [item.id]: !(all[item.id] ?? false) }));
          else {
            setCollapsed((all) => ({ ...all, [item.id]: false }));
            onSelect(item.id);
          }
        }}
      >
        <Icon kind="folder" />
        <span className="row-name">{item.name}</span>
      </button>
      <button
        className="row-action"
        disabled={busy}
        aria-label={`New conversation in ${item.name}`}
        onClick={() => {
          setCollapsed((all) => ({ ...all, [item.id]: false }));
          onCreate(item.id);
        }}
      >
        +
      </button>
      <PinButton
        name={`repository ${item.name}`}
        pinned={pins.repositories.includes(item.id)}
        onClick={() => togglePin("repositories", item.id)}
      />
    </div>
  );
  const matching = projects.filter((item) =>
    `${item.name} ${item.repository}`.toLowerCase().includes(query.trim().toLowerCase()),
  );
  return (
    <aside className="sidebar" aria-label="Repositories and conversations">
      <div className="brand">
        <strong>Pitcrew</strong>
        <div className="sidebar-tools">
          <button
            className="row-action"
            aria-label="Notifications"
            aria-expanded={notifications}
            aria-controls="sidebar-notifications"
            onClick={() => {
              setNotifications((value) => !value);
              setSearching(false);
              setQuery("");
            }}
          >
            <Icon kind="bell" />
          </button>
          <button
            className="row-action"
            aria-label="Search repositories"
            aria-expanded={searching}
            aria-controls="repository-search"
            onClick={() => {
              setSearching((value) => !value);
              setQuery("");
              setNotifications(false);
            }}
          >
            <Icon kind="search" />
          </button>
        </div>
      </div>
      {notifications && (
        <div
          id="sidebar-notifications"
          className="sidebar-notifications"
          role="region"
          aria-label="Notifications"
        >
          <p>Mention notifications aren’t available yet.</p>
        </div>
      )}
      {searching && (
        <div id="repository-search" className="repository-search">
          <input
            autoFocus
            aria-label="Search repositories"
            placeholder="Search repositories"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setSearching(false);
                setQuery("");
              }
            }}
          />
          {query && (
            <button aria-label="Clear repository search" onClick={() => setQuery("")}>
              ×
            </button>
          )}
        </div>
      )}
      <section className="sidebar-section" aria-label="Pinned">
        <h2 className="section-label">Pinned</h2>
        {projects
          .filter((item) => pins.repositories.includes(item.id))
          .map((item) => repositoryRow(item, true))}
        {projects
          .flatMap((item) => conversations(item.id))
          .filter((item) => pins.conversations.includes(item.id))
          .map((item) => conversationRow(item))}
      </section>
      <nav className="sidebar-section" aria-label="Repositories">
        <h2 className="section-label">Repositories</h2>
        {matching.map((item) => (
          <div key={item.id}>
            {repositoryRow(item)}
            {!(collapsed[item.id] ?? item.id !== projectId) && (
              <div
                className="repository-conversations"
                aria-label={`Conversations in ${item.name}`}
              >
                {conversations(item.id).map((conversation) => conversationRow(conversation))}
                {item.id === projectId && children}
              </div>
            )}
          </div>
        ))}
        {!matching.length && query.trim() && <p className="search-empty">No repositories found.</p>}
      </nav>
    </aside>
  );
}
