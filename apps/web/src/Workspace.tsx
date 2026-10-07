import { isStoredFile } from "@pitcrew/protocol";
import { StoredFile } from "./uploads/Preview";
import { useEffect, useRef, useState, type ReactNode, type CSSProperties } from "react";
import {
  IconWorld,
  IconFiles,
  IconGitCompare,
  IconGitPullRequest,
  IconLayoutSidebarRightCollapse,
  IconLayoutSidebarRightExpand,
} from "@tabler/icons-react";
import type { Api, Project, Snapshot } from "./api";
import "./Workspace.css";
import { Select } from "./Select";
import { RepositoryFiles, RepositoryDiffs } from "./RepositoryViewers";
import { runDisplayStatus } from "./landing-receipt";

type Tab = "browser" | "files" | "diffs" | "review" | "visualizations";
const baseTabs = [
  { id: "browser", label: "Browser", Icon: IconWorld },
  { id: "files", label: "Files", Icon: IconFiles },
  { id: "diffs", label: "Diffs", Icon: IconGitCompare },
  { id: "review", label: "Review / PR", Icon: IconGitPullRequest },
] as const;
type Selection = {
  tab: Tab;
  file?: string;
  run?: string;
  address?: string;
  url?: string;
  error?: string;
};
export function Workspace({
  scope,
  threadId,
  project,
  snapshot,
  api,
  children,
  collapsed,
  onCollapse,
  visualizations,
}: {
  scope: string;
  threadId?: string;
  project?: Project;
  snapshot: Snapshot;
  api: Api;
  children: ReactNode;
  collapsed: boolean;
  onCollapse: (value: boolean) => void;
  visualizations?: ReactNode;
}) {
  const tabs = visualizations
    ? [...baseTabs, { id: "visualizations" as const, label: "Visuals", Icon: IconWorld }]
    : baseTabs;
  const [selections, setSelections] = useState<Record<string, Selection>>({});
  const selected = selections[scope] ?? { tab: "browser" };
  const state =
    selected.tab === "visualizations" && !visualizations
      ? { ...selected, tab: "browser" as const }
      : selected;
  const update = (next: Partial<Selection>) =>
    setSelections((all) => ({
      ...all,
      [scope]: { ...(all[scope] ?? { tab: "browser" }), ...next },
    }));
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const files = snapshot.messages.flatMap((message) =>
    (message.attachments ?? []).map((attachment) => ({
      ...attachment,
      key: `${message.id}:${attachment.id}`,
      threadId: message.threadId,
    })),
  );
  const selectedFile = files.find((file) => file.key === state.file) ?? files[0];
  const selectedRun = snapshot.runs.find((run) => run.id === state.run) ?? snapshot.runs.at(-1);
  return (
    <aside
      className={`workspace ${collapsed ? "workspace-collapsed" : ""}`}
      aria-label="Thread workspace"
    >
      <header className="workspace-heading">
        <strong>{collapsed ? "" : "Workspace"}</strong>
        <button
          type="button"
          aria-label={collapsed ? "Expand workspace" : "Collapse workspace"}
          aria-expanded={!collapsed}
          aria-controls="workspace-body"
          onClick={() => onCollapse(!collapsed)}
        >
          {collapsed ? (
            <IconLayoutSidebarRightExpand size={19} />
          ) : (
            <IconLayoutSidebarRightCollapse size={19} />
          )}
        </button>
      </header>
      <div id="workspace-body" hidden={collapsed}>
        <div role="tablist" aria-label="Workspace views" className="workspace-tabs">
          {tabs.map(({ id, label, Icon }, index) => (
            <button
              key={id}
              ref={(element) => {
                tabRefs.current[index] = element;
              }}
              type="button"
              role="tab"
              id={`workspace-tab-${id}`}
              aria-selected={state.tab === id}
              aria-controls={`workspace-panel-${id}`}
              tabIndex={state.tab === id ? 0 : -1}
              onClick={() => update({ tab: id })}
              onKeyDown={(event) => {
                const next =
                  event.key === "ArrowRight"
                    ? (index + 1) % tabs.length
                    : event.key === "ArrowLeft"
                      ? (index + tabs.length - 1) % tabs.length
                      : event.key === "Home"
                        ? 0
                        : event.key === "End"
                          ? tabs.length - 1
                          : undefined;
                if (next !== undefined) {
                  event.preventDefault();
                  update({ tab: tabs[next].id });
                  tabRefs.current[next]?.focus();
                }
              }}
            >
              <Icon size={17} aria-hidden="true" />
              <span>{label}</span>
            </button>
          ))}
        </div>
        <div className="workspace-context">{project?.repository ?? "No repository selected"}</div>
        {!collapsed && state.tab === "visualizations" && visualizations && (
          <section
            className="workspace-panel"
            role="tabpanel"
            id="workspace-panel-visualizations"
            aria-labelledby="workspace-tab-visualizations"
            tabIndex={0}
          >
            {visualizations}
          </section>
        )}
        <section
          className="workspace-panel"
          role="tabpanel"
          id="workspace-panel-browser"
          aria-labelledby="workspace-tab-browser"
          hidden={state.tab !== "browser"}
          tabIndex={0}
        >
          <form
            className="preview-address"
            onSubmit={(event) => {
              event.preventDefault();
              try {
                const url = new URL(state.address ?? "");
                if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
                  throw Error();
                update({ url: url.href, error: "" });
              } catch {
                update({ error: "Enter a complete http:// or https:// URL without credentials." });
              }
            }}
          >
            <label htmlFor="preview-url">Preview URL</label>
            <div>
              <input
                id="preview-url"
                type="text"
                placeholder="http://localhost:3000"
                value={state.address ?? ""}
                onChange={(event) => {
                  update({ address: event.target.value });
                  update({ error: "" });
                }}
              />
              <button type="submit">Load</button>
            </div>
          </form>
          {state.error && <p role="alert">{state.error}</p>}
          {state.url ? (
            <>
              <div className="preview-toolbar">
                <a href={state.url} target="_blank" rel="noopener noreferrer">
                  Open in browser ↗
                </a>
                <button type="button" onClick={() => update({ url: undefined })}>
                  Close preview
                </button>
              </div>
              <p className="hint">
                Embedded preview is sandboxed. Some sites block embedding; use Open in browser if
                the frame is blank. No browser automation is connected.
              </p>
              <iframe
                key={`${scope}:${state.url}`}
                title="Workspace browser preview"
                src={state.url}
                sandbox="allow-scripts"
                referrerPolicy="no-referrer"
              />
            </>
          ) : (
            <div className="workspace-empty">
              <IconWorld size={30} />
              <h2>A browser beside your chat</h2>
              <p>Load a preview URL to inspect your app while you discuss changes.</p>
              <p className="hint">
                No preview session or browser automation is connected. Loading a URL contacts that
                site.
              </p>
            </div>
          )}
        </section>
        <section
          className="workspace-panel"
          role="tabpanel"
          id="workspace-panel-files"
          aria-labelledby="workspace-tab-files"
          hidden={state.tab !== "files"}
          tabIndex={0}
        >
          {state.tab === "files" && !collapsed && project && threadId ? (
            <RepositoryFiles key={scope} api={api} projectId={project.id} threadId={threadId} />
          ) : (
            <p className="hint">Select a repository thread to read source files.</p>
          )}
          <h2>Conversation attachments</h2>
          <p className="hint">Submitted files from this thread.</p>
          {files.length ? (
            <>
              <label className="workspace-select">
                File
                <Select
                  label="File"
                  value={selectedFile?.key ?? ""}
                  onChange={(value) => update({ file: value })}
                  options={files.map((file) => ({ value: file.key, label: file.name }))}
                />
              </label>
              {selectedFile && (
                <article className="workspace-file">
                  <h3>{selectedFile.name}</h3>
                  {isStoredFile(selectedFile) ? (
                    <StoredFile
                      attachment={selectedFile}
                      url={
                        api.attachmentUrl?.(selectedFile.threadId, selectedFile.attachmentId) ??
                        `/api/threads/${encodeURIComponent(selectedFile.threadId)}/attachments/${encodeURIComponent(selectedFile.attachmentId)}`
                      }
                    />
                  ) : selectedFile.mediaType === "text/plain" ? (
                    <pre>{selectedFile.text}</pre>
                  ) : (
                    <img
                      alt={`Attached ${selectedFile.name}`}
                      src={
                        api.attachmentUrl?.(selectedFile.threadId, selectedFile.attachmentId) ??
                        `/api/threads/${encodeURIComponent(selectedFile.threadId)}/attachments/${encodeURIComponent(selectedFile.attachmentId)}`
                      }
                    />
                  )}
                </article>
              )}
            </>
          ) : (
            <div className="workspace-empty">
              <IconFiles size={30} />
              <h3>No submitted files</h3>
              <p>Attach a text file or image to a message to inspect it here after sending.</p>
            </div>
          )}
        </section>
        <section
          className="workspace-panel"
          role="tabpanel"
          id="workspace-panel-diffs"
          aria-labelledby="workspace-tab-diffs"
          hidden={state.tab !== "diffs"}
          tabIndex={0}
        >
          <h2>Base vs. candidate</h2>
          {selectedRun ? (
            <>
              <label className="workspace-select">
                Change run
                <Select
                  label="Change run"
                  value={selectedRun.id}
                  onChange={(value) => update({ run: value })}
                  options={[...snapshot.runs].reverse().map((run) => ({
                    value: run.id,
                    label: `${run.id} · ${runDisplayStatus(run).replaceAll("_", " ")}`,
                  }))}
                />
              </label>
              <dl>
                <dt>Base</dt>
                <dd>
                  <code>{selectedRun.baseSha}</code>
                </dd>
                <dt>Candidate</dt>
                <dd>
                  <code>{selectedRun.candidateSha ?? "Not available yet"}</code>
                </dd>
                <dt>Configuration</dt>
                <dd>{selectedRun.configurationRevision}</dd>
              </dl>
            </>
          ) : (
            <p>No change runs in this conversation.</p>
          )}
          {state.tab === "diffs" && !collapsed && project && threadId ? (
            <RepositoryDiffs
              key={`${scope}:${selectedRun?.id}:${selectedRun?.baseSha}:${selectedRun?.candidateSha}:${selectedRun?.configurationRevision}`}
              api={api}
              projectId={project.id}
              threadId={threadId}
              run={selectedRun}
            />
          ) : (
            <p className="hint">Patch content unavailable. Select a repository thread.</p>
          )}
          <button
            type="button"
            onClick={() => {
              update({ tab: "review" });
              tabRefs.current[3]?.focus();
            }}
          >
            Inspect review evidence
          </button>
        </section>
        <section
          role="tabpanel"
          id="workspace-panel-review"
          aria-labelledby="workspace-tab-review"
          hidden={state.tab !== "review"}
          tabIndex={0}
        >
          <div className="workspace-panel">
            <h2>Proposed changes</h2>
            <p className="hint">
              Inspect run candidates, verification and trusted reviews below. GitHub PR metadata and
              status are not connected.
            </p>
          </div>
          {children}
        </section>
      </div>
    </aside>
  );
}
export function WorkspaceResize({
  width,
  onWidth,
}: {
  width: number;
  onWidth: (width: number) => void;
}) {
  const separator = useRef<HTMLDivElement>(null);
  const [maximum, setMaximum] = useState(640);
  useEffect(() => {
    const parent = separator.current?.parentElement;
    if (!parent || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const sidebar = parent.querySelector(".sidebar")?.getBoundingClientRect().width ?? 250;
      const chatMinimum = window.matchMedia("(min-width: 1500px)").matches ? 400 : 320;
      setMaximum(Math.max(300, Math.min(640, parent.clientWidth - sidebar - chatMinimum - 6)));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    return () => observer.disconnect();
  }, []);
  const currentWidth = Math.min(width, maximum);
  const clamp = (value: number) => Math.min(maximum, Math.max(300, value));
  return (
    <div
      ref={separator}
      className="workspace-resize"
      role="separator"
      tabIndex={0}
      aria-label="Resize workspace"
      aria-orientation="vertical"
      aria-valuemin={300}
      aria-valuemax={maximum}
      aria-valuenow={currentWidth}
      onKeyDown={(event) => {
        if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
          event.preventDefault();
          onWidth(
            event.key === "Home"
              ? 300
              : event.key === "End"
                ? maximum
                : clamp(currentWidth + (event.key === "ArrowLeft" ? 20 : -20)),
          );
        }
      }}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          onWidth(
            clamp(event.currentTarget.parentElement!.getBoundingClientRect().right - event.clientX),
          );
      }}
      onPointerUp={(event) => {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
    />
  );
}
export const workspaceStyle = (width: number) =>
  ({ "--workspace-width": `${width}px` }) as CSSProperties;
