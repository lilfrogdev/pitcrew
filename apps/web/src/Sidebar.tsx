import { useEffect, useState, type ReactNode } from "react";
import type { Api, Project, Thread, Run } from "./api";
import { useSidebarData } from "./useSidebarData";

const preferenceKey = "pitcrew.sidebar.pins.v1";
type Pins = {
  repositories: string[];
  conversations: string[];
  conversationRepositories: Record<string, string>;
};
function readPins(): Pins {
  try {
    const value = JSON.parse(localStorage.getItem(preferenceKey) ?? "{}");
    const ids = (items: unknown): string[] =>
      Array.isArray(items)
        ? [...new Set(items.filter((id): id is string => typeof id === "string"))]
        : [];
    const conversations = ids(value.conversations);
    const associations = value.conversationRepositories;
    return {
      repositories: ids(value.repositories),
      conversations,
      conversationRepositories:
        associations && typeof associations === "object"
          ? Object.fromEntries(
              Object.entries(associations).filter(
                (entry): entry is [string, string] =>
                  conversations.includes(entry[0]) && typeof entry[1] === "string",
              ),
            )
          : {},
    };
  } catch {
    return { repositories: [], conversations: [], conversationRepositories: {} };
  }
}
const iconPaths = {
  bell: "M5 8a5 5 0 0 1 10 0v4l2 2H3l2-2Z M8 17h4",
  repository:
    "M5 2.5h10a1 1 0 0 1 1 1v14H5a2 2 0 0 1-2-2v-11a2 2 0 0 1 2-2Z M3 15.5a2 2 0 0 1 2-2h11 M7 2.5v6l2-1.5 2 1.5v-6",
  pin: "m7 2 6 0-1 5 3 3v2H5v-2l3-3Z M10 12v6",
  search: "M14 14l4 4 M16 9a7 7 0 1 1-14 0 7 7 0 0 1 14 0",
  queued: "M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z M10 6v4l3 2",
  working: "M17 10a7 7 0 1 1-7-7",
  input:
    "M5 3h10a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H8l-4 3v-3a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z M8 7a2 2 0 0 1 4 0c0 1.5-2 1.5-2 3 M10 11.5v.1",
  review: "M2 10s3-5 8-5 8 5 8 5-3 5-8 5-8-5-8-5Z M12.5 10a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0Z",
  completed: "M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z M6.5 10l2.5 2.5 4.5-5",
  failed: "M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z M10 6.5v4 M10 13v.1",
  stopped: "M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z M7 7h6v6H7Z",
};
type IconKind = keyof typeof iconPaths;
const runIcons: Record<Run["status"], { kind: IconKind; label: string }> = {
  queued: { kind: "queued", label: "Queued" },
  running: { kind: "working", label: "In progress" },
  waiting_user: { kind: "input", label: "Needs your attention" },
  awaiting_review: { kind: "review", label: "Awaiting review" },
  completed: { kind: "completed", label: "Completed" },
  failed: { kind: "failed", label: "Failed" },
  stopped: { kind: "stopped", label: "Stopped" },
};
function Icon({ kind }: { kind: IconKind }) {
  return (
    <svg
      viewBox="0 0 20 20"
      aria-hidden="true"
      className={kind === "working" ? "working-spinner" : undefined}
    >
      <path d={iconPaths[kind]} />
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
  const matching = projects.filter((item) =>
    `${item.name} ${item.repository}`.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const { lists: others, runs: runStates } = useSidebarData({
    api,
    projects,
    projectId,
    threads,
    threadId,
    activeRun,
    revision,
    visibleRepositories: matching
      .filter((item) => !(collapsed[item.id] ?? item.id !== projectId))
      .map((item) => item.id),
    pinnedConversations: pins.conversations,
  });
  const stateIndicator = (item: Thread) => {
    const run = item.id === threadId ? activeRun : runStates[item.id];
    if (!run) return null;
    const { kind, label } = runIcons[run.status];
    return (
      <span
        className={`conversation-state state-${run.status}`}
        role="img"
        aria-label={label}
        title={label}
      >
        <Icon kind={kind} />
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
  const conversations = (id: string) => (id === projectId ? threads : (others[id] ?? []));
  const knownConversations = projects.flatMap((item) => conversations(item.id));
  const associations = { ...pins.conversationRepositories };
  for (const item of knownConversations) {
    if (pins.conversations.includes(item.id)) associations[item.id] = item.projectId;
  }
  const associationKey = JSON.stringify(associations);
  useEffect(() => {
    setPins((all) =>
      JSON.stringify(all.conversationRepositories) === associationKey
        ? all
        : { ...all, conversationRepositories: JSON.parse(associationKey) },
    );
  }, [associationKey]);
  const pinnedRepositories = new Set([
    ...pins.repositories,
    ...pins.conversations.flatMap((id) => (associations[id] ? [associations[id]] : [])),
  ]);
  const toggleConversationPin = (item: Thread) =>
    setPins((all) => {
      const pinned = all.conversations.includes(item.id);
      const conversationRepositories = { ...all.conversationRepositories };
      if (pinned) delete conversationRepositories[item.id];
      else conversationRepositories[item.id] = item.projectId;
      return {
        ...all,
        conversationRepositories,
        conversations: pinned
          ? all.conversations.filter((id) => id !== item.id)
          : [...all.conversations, item.id],
      };
    });
  const toggleRepositoryPin = (id: string) =>
    setPins((all) => ({
      ...all,
      repositories: pinnedRepositories.has(id)
        ? all.repositories.filter((item) => item !== id)
        : [...all.repositories, id],
    }));
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
        onClick={() => toggleConversationPin(item)}
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
        <Icon kind="repository" />
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
        pinned={pinnedRepositories.has(item.id)}
        onClick={() => toggleRepositoryPin(item.id)}
      />
    </div>
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
          .filter((item) => pinnedRepositories.has(item.id))
          .map((item) => (
            <div key={item.id}>
              {repositoryRow(item, true)}
              <div
                className="repository-conversations"
                aria-label={`Pinned conversations in ${item.name}`}
              >
                {conversations(item.id)
                  .filter((conversation) => pins.conversations.includes(conversation.id))
                  .map(conversationRow)}
              </div>
            </div>
          ))}
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
