import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Api, Project, Thread, Run } from "./api";
import { Icon, type IconKind } from "./icons";
import { useSidebarData } from "./useSidebarData";
import { ConversationTitle } from "./ConversationTitle";

const legacyExpansionKey = "pitcrew.sidebar.collapsed.v1";
const folderKey = (id: string, pinned = false) => `${pinned ? "pinned" : "repositories"}:${id}`;
function readCollapsed(key: string, migrateLegacy: boolean): Record<string, boolean> {
  try {
    const saved = localStorage.getItem(key);
    const legacy = saved === null && migrateLegacy;
    const value: unknown = JSON.parse(saved ?? (legacy ? localStorage.getItem(legacyExpansionKey) : null) ?? "{}");
    return value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value).filter(([, collapsed]) => typeof collapsed === "boolean")
            .map(([id, collapsed]) => [legacy ? folderKey(id) : id, collapsed]),
        )
      : {};
  } catch {
    return {};
  }
}
const preferenceKey = "pitcrew.sidebar.pins.v1";
type Pins = {
  repositories: string[];
  conversations: string[];
  conversationRepositories: Record<string, string>;
};
function readPins(key = preferenceKey): Pins {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "{}");
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
const runIcons: Record<Run["status"], { kind: IconKind; label: string }> = {
  queued: { kind: "queued", label: "Queued" },
  running: { kind: "working", label: "In progress" },
  waiting_user: { kind: "input", label: "Needs your attention" },
  awaiting_review: { kind: "review", label: "Awaiting review" },
  completed: { kind: "completed", label: "Completed" },
  failed: { kind: "failed", label: "Failed" },
  stopped: { kind: "stopped", label: "Stopped" },
};
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
  onArchive,
  activeRun,
  children,
  accountId,
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
  onArchive?: (thread: Thread, archived: boolean) => Promise<Thread | undefined>;
  activeRun?: Run;
  children?: ReactNode;
  accountId?: string;
}) {
  const expansionKey = `pitcrew.sidebar.collapsed.v2:${encodeURIComponent(accountId ?? "local")}`;
  const pinsKey = accountId ? `pitcrew.sidebar.pins.v2:${encodeURIComponent(accountId)}` : preferenceKey;
  const searchButton = useRef<HTMLButtonElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [archiveUpdates, setArchiveUpdates] = useState<Record<string, Thread>>({});
  const [searching, setSearching] = useState(false);
  const [notifications, setNotifications] = useState(false);
  const [creatingInPinned, setCreatingInPinned] = useState(false);
  const [pins, setPins] = useState(() => readPins(pinsKey));
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => ({
    [folderKey(projectId)]: false,
    ...readCollapsed(expansionKey, !accountId),
  }));
  useEffect(() => {
    try {
      localStorage.setItem(expansionKey, JSON.stringify(collapsed));
    } catch {
      /* Collapsing remains usable without storage. */
    }
  }, [collapsed, expansionKey]);
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
      .filter((item) => !(collapsed[folderKey(item.id)] ?? item.id !== projectId) ||
        (pins.repositories.includes(item.id) && !(collapsed[folderKey(item.id, true)] ?? false)))
      .map((item) => item.id),
    pinnedConversations: pins.conversations,
  });
  const stateIndicator = (item: Thread) => {
    const run = item.id === threadId ? activeRun : runStates[item.id];
    if (!run) return null;
    const { kind, label } = run.error
      ? {
          kind: "failed" as const,
          label:
            run.error === "reconciliation_required"
              ? "Reconciliation required"
              : run.error === "execution_unavailable"
                ? "Execution unavailable"
                : "Execution failed",
        }
      : runIcons[run.status];
    return (
      <span
        className={`conversation-state state-${run.error ? "failed" : run.status}`}
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
      localStorage.setItem(pinsKey, JSON.stringify(pins));
    } catch {
      /* Navigation works without storage. */
    }
  }, [pins, pinsKey]);
  useEffect(() => {
    const savedConversations = projects.flatMap((item) =>
      item.id === projectId ? threads : (others[item.id] ?? []),
    );
    setArchiveUpdates((all) => {
      const next = { ...all };
      for (const item of savedConversations) {
        if (next[item.id]?.archived === item.archived) delete next[item.id];
      }
      return Object.keys(next).length === Object.keys(all).length ? all : next;
    });
  }, [threads, others, projectId, projects]);
  const conversations = (id: string) =>
    (id === projectId ? threads : (others[id] ?? [])).map(
      (item) => archiveUpdates[item.id] ?? item,
    );
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
    ...(creatingInPinned && children && projectId ? [projectId] : []),
    ...pins.conversations.flatMap((id) =>
      associations[id] && !knownConversations.find((item) => item.id === id)?.archived
        ? [associations[id]]
        : [],
    ),
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
  const conversationRow = (item: Thread, pinnedSection = false) => (
    <div
      className={`sidebar-row conversation-row ${item.id === threadId ? "selected" : ""}`}
      key={item.id}
    >
      <button
        className="sidebar-item"
        aria-current={item.id === threadId ? "page" : undefined}
        aria-label={item.title}
        title={item.title}
        disabled={busy}
        onClick={() => {
          setCollapsed((all) => ({ ...all, [folderKey(item.projectId, pinnedSection)]: false }));
          onSelect(item.projectId, item.id);
        }}
      >
        <ConversationTitle title={item.title} />
        {stateIndicator(item)}
      </button>
      <div className="conversation-actions">
        {onArchive && api.setThreadArchived && (
          <button
            className="row-action archive-action"
            disabled={busy}
            aria-label={`${item.archived ? "Restore" : "Archive"} conversation ${item.title}`}
            title={`${item.archived ? "Restore" : "Archive"} conversation`}
            onClick={async () => {
              const updated = await onArchive(item, !item.archived);
              // A committed response survives a failed list revalidation.
              if (updated) {
                setArchiveUpdates((all) => ({ ...all, [updated.id]: updated }));
                if (updated.archived) setPins((all) => {
                  const conversationRepositories = { ...all.conversationRepositories };
                  delete conversationRepositories[updated.id];
                  return { ...all, conversationRepositories,
                    conversations: all.conversations.filter((id) => id !== updated.id) };
                });
              }
            }}
          >
            <Icon kind={item.archived ? "restore" : "archive"} />
          </button>
        )}
        <PinButton
          name={`conversation ${item.title}`}
          pinned={pins.conversations.includes(item.id)}
          onClick={() => toggleConversationPin(item)}
        />
      </div>
    </div>
  );
  const repositoryRow = (item: Project, pinnedSection = false) => (
    <div className="sidebar-row repository-row" key={item.id}>
      <button
        className="sidebar-item"
        aria-label={`${item.name} · ${item.repository}`}
        title={item.repository}
        aria-expanded={!(collapsed[folderKey(item.id, pinnedSection)] ?? (!pinnedSection && item.id !== projectId))}
        disabled={busy}
        onClick={() => {
          const wasCollapsed = collapsed[folderKey(item.id, pinnedSection)] ?? (!pinnedSection && item.id !== projectId);
          setCollapsed((all) => ({ ...all, [folderKey(item.id, pinnedSection)]: !wasCollapsed }));
          if (wasCollapsed && item.id !== projectId) onSelect(item.id);
        }}
      >
        <Icon
          kind={
            (collapsed[folderKey(item.id, pinnedSection)] ?? (!pinnedSection && item.id !== projectId))
              ? "repository"
              : "folderOpen"
          }
        />
        <span className="row-name">{item.name}</span>
      </button>
      <button
        className="row-action"
        disabled={busy}
        aria-label={`New conversation in ${item.name}`}
        onClick={() => {
          setCreatingInPinned(pinnedSection);
          setCollapsed((all) => ({ ...all, [folderKey(item.id, pinnedSection)]: false }));
          onCreate(item.id);
        }}
      >
        <Icon kind="plus" />
      </button>
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
            ref={searchButton}
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
            ref={searchInput}
            autoFocus
            aria-label="Search repositories"
            placeholder="Search repositories or conversations"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setSearching(false);
                setQuery("");
                searchButton.current?.focus();
              }
            }}
          />
          {query && (
            <button
              aria-label="Clear repository search"
              onClick={() => {
                setQuery("");
                searchInput.current?.focus();
              }}
            >
              <Icon kind="close" />
            </button>
          )}
        </div>
      )}
      {searching && query.trim() && (
        <section className="sidebar-section" aria-label="Conversation search results">
          {knownConversations
            .filter((item) => item.title.toLowerCase().includes(query.trim().toLowerCase()))
            .map((item) => conversationRow(item))}
        </section>
      )}
      <section className="sidebar-section" aria-label="Pinned">
        <h2 className="section-label">Pinned</h2>
        {projects
          .filter((item) => pinnedRepositories.has(item.id))
          .map((item) => (
            <div key={item.id}>
              {repositoryRow(item, true)}
              {!(collapsed[folderKey(item.id, true)] ?? false) && (
                <div
                  className="repository-conversations"
                  aria-label={`Pinned conversations in ${item.name}`}
                >
                  {conversations(item.id)
                    .filter(
                      (conversation) =>
                        !conversation.archived && pins.conversations.includes(conversation.id),
                    )
                    .map((conversation) => conversationRow(conversation, true))}
                  {item.id === projectId && creatingInPinned && children}
                </div>
              )}
            </div>
          ))}
      </section>
      <nav className="sidebar-section" aria-label="Repositories">
        <h2 className="section-label">Repositories</h2>
        {matching.map((item) => (
          <div key={item.id}>
            {repositoryRow(item)}
            {!(collapsed[folderKey(item.id)] ?? item.id !== projectId) && (
              <div
                className="repository-conversations"
                aria-label={`Conversations in ${item.name}`}
              >
                {conversations(item.id)
                  .filter((conversation) => !conversation.archived)
                  .map((conversation) => conversationRow(conversation))}
                {item.id === projectId && !creatingInPinned && children}
              </div>
            )}
          </div>
        ))}
        {!matching.length &&
          query.trim() &&
          !knownConversations.some((item) =>
            item.title.toLowerCase().includes(query.trim().toLowerCase()),
          ) && <p className="search-empty">No repositories found.</p>}
      </nav>
    </aside>
  );
}
