import { useEffect, useRef, useState } from "react";
import { IconFolder, IconFile, IconChevronUp } from "@tabler/icons-react";
import type { SourceTree, SourceFile, SourceDiff, SourcePatch, Run } from "@pitcrew/protocol";
import type { Api } from "./api";
import { ApiError } from "./api";
import "./RepositoryViewers.css";

const problem = (error: unknown) =>
  error instanceof ApiError
    ? error.status === 409
      ? "The repository or run changed. Refresh to read its current version."
      : error.status === 413
        ? "This content exceeds the viewer's read budget."
        : error.status === 404
          ? "This source or shared item is no longer available."
          : error.status === 429
            ? "Repository reads are busy. Try again shortly."
            : "Repository content is unavailable. Check the protected Artifacts connection, then refresh."
    : "The source response did not match this view. Refresh to try again.";
const sha = (value: string) => /^[a-f0-9]{40}$/.test(value);
const digest = (value: string) => /^[a-f0-9]{64}$/.test(value);
const pathValid = (value: string) =>
  typeof value === "string" &&
  value.length <= 1024 &&
  // eslint-disable-next-line no-control-regex -- Match the server path validation before rendering.
  !/[\\\u0000-\u001f\u007f]/.test(value) &&
  !value.startsWith("/") &&
  (!value || value.split("/").every((part) => part && part !== "." && part !== ".."));
const contentStatus = new Set(["text", "binary", "too_large", "symlink", "submodule", "mode_only"]);
function contentValid(value: SourceFile | SourcePatch) {
  if (!contentStatus.has(value.status) || !pathValid(value.path)) throw Error();
  if (
    value.status === "text" &&
    ("sha" in value
      ? typeof value.text !== "string" || value.text.length > 65536
      : typeof value.patch !== "string" || value.patch.length > 196608)
  )
    throw Error();
  const text = "sha" in value ? value.text : value.patch;
  if (value.status === "text" && text!.split("\n").length > ("sha" in value ? 4000 : 8010))
    throw Error();
}
function Content({ value }: { value: SourceFile | SourcePatch }) {
  const explanations = {
    binary: "Binary or non-UTF-8 content is not displayed.",
    too_large: "Content exceeds the file, line or patch size limit.",
    symlink: "Symbolic link. The viewer does not follow links.",
    submodule: "Submodule. The viewer does not read external repositories.",
    mode_only: "File permissions changed; text content is identical.",
    text: "",
  };
  if (value.status !== "text") return <p className="hint">{explanations[value.status]}</p>;
  const text = "sha" in value ? value.text! : value.patch!;
  return (
    <div
      className="source-code"
      tabIndex={0}
      role="region"
      aria-label={"sha" in value ? "File content" : "Unified patch"}
    >
      <pre>
        {text.split("\n").map((line, index) => (
          <span
            key={index}
            className={
              "sha" in value
                ? "source-line"
                : `source-line ${line.startsWith("+") ? "patch-add" : line.startsWith("-") ? "patch-remove" : line.startsWith("@@") ? "patch-hunk" : ""}`
            }
          >
            <span aria-hidden="true" className="source-line-number">
              {index + 1}
            </span>
            <code>{line || " "}</code>
          </span>
        ))}
      </pre>
    </div>
  );
}
export function RepositoryFiles({
  api,
  projectId,
  threadId,
}: {
  api: Api;
  projectId: string;
  threadId: string;
}) {
  const [tree, setTree] = useState<SourceTree>();
  const [file, setFile] = useState<SourceFile>();
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const serial = useRef(0);
  const load = async (path = "", version?: string, cursor?: string) => {
    const ticket = ++serial.current;
    setBusy(true);
    setError("");
    setFile(undefined);
    setSelected("");
    if (!cursor) setTree(undefined);
    try {
      const value = await api.source!.tree(threadId, path, version, cursor);
      if (
        value.projectId !== projectId ||
        value.threadId !== threadId ||
        value.path !== path ||
        !sha(value.sha) ||
        !digest(value.version) ||
        !value.sourceId ||
        (version && value.version !== version) ||
        !Array.isArray(value.entries) ||
        value.entries.length > 100 ||
        value.entries.some(
          (entry) =>
            !pathValid(entry.path) ||
            entry.path !== (path ? `${path}/${entry.name}` : entry.name) ||
            !["file", "directory", "symlink", "submodule"].includes(entry.kind),
        ) ||
        !(value.cursor === null || /^\d{1,5}$/.test(value.cursor))
      )
        throw Error();
      if (ticket !== serial.current) return;
      setTree((previous) =>
        cursor && previous?.version === value.version && previous.path === path
          ? { ...value, entries: [...previous.entries, ...value.entries] }
          : value,
      );
    } catch (failure) {
      if (ticket === serial.current) {
        setTree(undefined);
        setError(problem(failure));
      }
    } finally {
      if (ticket === serial.current) setBusy(false);
    }
  };
  useEffect(() => {
    if (api.source) void load();
    return () => {
      serial.current++;
    };
  }, [api, projectId, threadId]);
  const open = async (path: string) => {
    if (!tree) return;
    const binding = tree;
    const ticket = ++serial.current;
    setBusy(true);
    setError("");
    setSelected(path);
    setFile(undefined);
    try {
      const value = await api.source!.file(threadId, path, binding.version);
      if (
        value.projectId !== projectId ||
        value.threadId !== threadId ||
        value.path !== path ||
        value.version !== binding.version ||
        value.sourceId !== binding.sourceId ||
        value.sha !== binding.sha
      )
        throw Error();
      contentValid(value);
      if (ticket === serial.current) setFile(value);
    } catch (failure) {
      if (ticket === serial.current) {
        setTree(undefined);
        setSelected("");
        setError(problem(failure));
      }
    } finally {
      if (ticket === serial.current) setBusy(false);
    }
  };
  if (!api.source)
    return <p className="hint">Repository source is unavailable on this connection.</p>;
  return (
    <div className="repository-viewer">
      <div className="source-toolbar">
        <h2>Repository files</h2>
        <button type="button" disabled={busy} onClick={() => void load()}>
          Refresh files
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
      {tree && (
        <>
          <p className="source-version">
            Source <code title={tree.sha}>{tree.sha.slice(0, 12)}</code>
          </p>
          <nav className="source-toolbar" aria-label="Repository directory">
            <strong>{tree.path || "/"}</strong>
            {tree.path && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void load(tree.path.split("/").slice(0, -1).join("/"), tree.version)}
              >
                <IconChevronUp size={14} /> Parent directory
              </button>
            )}
          </nav>
          <ul className="source-entries" aria-label="Repository entries">
            {tree.entries.map((entry) => (
              <li key={entry.path}>
                <button
                  type="button"
                  aria-label={`${entry.name}${entry.kind === "file" ? "" : " " + entry.kind}`}
                  aria-pressed={selected === entry.path}
                  disabled={busy}
                  onClick={() =>
                    entry.kind === "directory"
                      ? void load(entry.path, tree.version)
                      : void open(entry.path)
                  }
                >
                  {entry.kind === "directory" ? <IconFolder size={16} /> : <IconFile size={16} />}
                  <span>{entry.name}</span>
                  <small>{entry.kind === "file" ? "" : entry.kind}</small>
                </button>
              </li>
            ))}
          </ul>
          {!tree.entries.length && <p className="hint">Empty directory.</p>}
          {tree.cursor && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void load(tree.path, tree.version, tree.cursor!)}
            >
              Load more files
            </button>
          )}
        </>
      )}
      {busy && <p role="status">Reading repository…</p>}
      {file && (
        <article className="source-content">
          <h3>{file.path}</h3>
          <p className="hint">
            {file.bytes === undefined ? "" : `${file.bytes.toLocaleString()} bytes · `}Read only
          </p>
          <Content value={file} />
        </article>
      )}
    </div>
  );
}
export function RepositoryDiffs({
  api,
  projectId,
  threadId,
  run,
}: {
  api: Api;
  projectId: string;
  threadId: string;
  run?: Run;
}) {
  const [diff, setDiff] = useState<SourceDiff>();
  const [patch, setPatch] = useState<SourcePatch>();
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const serial = useRef(0);
  const matches = (value: SourceDiff | SourcePatch) => {
    if (
      !run ||
      value.projectId !== projectId ||
      value.threadId !== threadId ||
      value.runId !== run.id ||
      value.baseSha !== run.baseSha ||
      value.candidateSha !== run.candidateSha ||
      value.configurationRevision !== run.configurationRevision ||
      !digest(value.version) ||
      !value.sourceId ||
      !value.artifactId
    )
      throw Error();
  };
  const load = async (version?: string, cursor?: string) => {
    if (!run?.candidateSha || !api.source) return;
    const ticket = ++serial.current;
    setBusy(true);
    setError("");
    setPatch(undefined);
    setSelected("");
    if (!cursor) setDiff(undefined);
    try {
      const value = await api.source.diff(threadId, run.id, version, cursor);
      matches(value);
      if (
        (version && value.version !== version) ||
        !Array.isArray(value.entries) ||
        value.entries.length > 100 ||
        value.entries.some(
          (entry) =>
            !pathValid(entry.path) || !["added", "deleted", "modified"].includes(entry.change),
        ) ||
        !Number.isSafeInteger(value.total) ||
        value.total < value.entries.length ||
        value.total > 6000 ||
        !(value.cursor === null || /^\d{1,5}$/.test(value.cursor))
      )
        throw Error();
      if (ticket === serial.current)
        setDiff((previous) =>
          cursor && previous?.version === value.version
            ? { ...value, entries: [...previous.entries, ...value.entries] }
            : value,
        );
    } catch (failure) {
      if (ticket === serial.current) {
        setDiff(undefined);
        setError(problem(failure));
      }
    } finally {
      if (ticket === serial.current) setBusy(false);
    }
  };
  useEffect(() => {
    void load();
    return () => {
      serial.current++;
    };
  }, [
    api,
    projectId,
    threadId,
    run?.id,
    run?.baseSha,
    run?.candidateSha,
    run?.configurationRevision,
  ]);
  const open = async (path: string) => {
    if (!diff || !run) return;
    const ticket = ++serial.current;
    setBusy(true);
    setError("");
    setSelected(path);
    setPatch(undefined);
    try {
      const value = await api.source!.patch(threadId, run.id, path, diff.version);
      matches(value);
      contentValid(value);
      if (
        value.path !== path ||
        value.version !== diff.version ||
        value.sourceId !== diff.sourceId ||
        value.artifactId !== diff.artifactId
      )
        throw Error();
      if (ticket === serial.current) setPatch(value);
    } catch (failure) {
      if (ticket === serial.current) {
        setDiff(undefined);
        setSelected("");
        setError(problem(failure));
      }
    } finally {
      if (ticket === serial.current) setBusy(false);
    }
  };
  if (!api.source) return <p className="hint">Patch content is unavailable on this connection.</p>;
  if (!run) return <p>No change runs in this conversation.</p>;
  if (!run.candidateSha) return <p className="hint">The candidate has not been published yet.</p>;
  return (
    <div className="repository-viewer">
      <div className="source-toolbar">
        <h3>Changed files</h3>
        <button type="button" disabled={busy} onClick={() => void load()}>
          Refresh diff
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
      {busy && <p role="status">Reading changes…</p>}
      {diff && (
        <>
          <p className="hint">
            {diff.total} changed {diff.total === 1 ? "file" : "files"} · Renames appear as added and
            deleted files.
          </p>
          <ul className="source-entries" aria-label="Changed files">
            {diff.entries.map((entry) => (
              <li key={entry.path}>
                <button
                  type="button"
                  aria-label={`${entry.path} ${entry.change}`}
                  aria-pressed={selected === entry.path}
                  disabled={busy}
                  onClick={() => void open(entry.path)}
                >
                  <IconFile size={16} />
                  <span>{entry.path}</span>
                  <small>{entry.change}</small>
                </button>
              </li>
            ))}
          </ul>
          {diff.total === 0 && <p>No file changes between these commits.</p>}
          {diff.cursor && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void load(diff.version, diff.cursor!)}
            >
              Load more changes
            </button>
          )}
        </>
      )}
      {patch && (
        <article className="source-content">
          <h3>{patch.path}</h3>
          <p className="hint">
            Mode {patch.beforeMode ?? "absent"} → {patch.afterMode ?? "absent"}
          </p>
          <Content value={patch} />
        </article>
      )}
    </div>
  );
}
