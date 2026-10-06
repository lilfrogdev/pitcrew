import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vite-plus/test";
import type { SourceTree, SourceFile, SourceDiff, SourcePatch, Run } from "@pitcrew/protocol";
import { RepositoryFiles, RepositoryDiffs } from "./RepositoryViewers";
import { ApiError } from "./api";
import { createFixtureApi } from "./fixtures";
const hash = "a".repeat(40),
  candidate = "b".repeat(40),
  version = "1".repeat(64);
const binding = {
  projectId: "pitcrew",
  threadId: "welcome",
  sourceId: "source-id",
  sha: hash,
  version,
};
const tree: SourceTree = {
  ...binding,
  path: "",
  entries: [
    { name: "src", path: "src", kind: "directory", mode: "40000" },
    { name: "README.md", path: "README.md", kind: "file", mode: "100644" },
  ],
  cursor: null,
};
const file: SourceFile = {
  ...binding,
  path: "README.md",
  status: "text",
  text: "<script>alert(1)</script>\n",
  bytes: 26,
};
const run: Run = {
  id: "run",
  threadId: "welcome",
  baseSha: hash,
  candidateSha: candidate,
  configurationRevision: "cfg",
  status: "awaiting_review",
};
const diffBinding = {
  projectId: "pitcrew",
  threadId: "welcome",
  sourceId: "source-id",
  artifactId: "fork-id",
  runId: "run",
  baseSha: hash,
  candidateSha: candidate,
  configurationRevision: "cfg",
  version,
};
const diff: SourceDiff = {
  ...diffBinding,
  entries: [{ path: "README.md", change: "modified", beforeMode: "100644", afterMode: "100644" }],
  total: 1,
  cursor: null,
  renameDetection: false,
};
const patch: SourcePatch = {
  ...diffBinding,
  path: "README.md",
  status: "text",
  patch:
    '--- "a/README.md"\n+++ "b/README.md"\n@@ -1,1 +1,1 @@\n-old\n+<script>alert(2)</script>\n',
  beforeMode: "100644",
  afterMode: "100644",
};
function fixture() {
  const api = createFixtureApi();
  api.source = {
    tree: vi.fn(async () => structuredClone(tree)),
    file: vi.fn(async () => structuredClone(file)),
    diff: vi.fn(async () => structuredClone(diff)),
    patch: vi.fn(async () => structuredClone(patch)),
  };
  return api;
}
afterEach(cleanup);
it("reads source tree/file, escapes code and keeps version bound during navigation", async () => {
  const api = fixture(),
    user = userEvent.setup();
  render(<RepositoryFiles api={api} projectId="pitcrew" threadId="welcome" />);
  await user.click(await screen.findByRole("button", { name: "README.md" }));
  expect(await screen.findByText("<script>alert(1)</script>")).toBeTruthy();
  expect(document.querySelector("script")).toBeNull();
  expect(api.source!.file).toHaveBeenCalledWith("welcome", "README.md", version);
  (api.source!.tree as ReturnType<typeof vi.fn>).mockResolvedValue({
    ...tree,
    path: "src",
    entries: [],
    cursor: null,
  });
  await user.click(screen.getByRole("button", { name: "src directory" }));
  expect(await screen.findByText("Empty directory.")).toBeTruthy();
  expect(screen.queryByText("<script>alert(1)</script>")).toBeNull();
});
it("reads an admitted patch with additions/removals displayed as escaped text", async () => {
  const api = fixture(),
    user = userEvent.setup();
  render(<RepositoryDiffs api={api} projectId="pitcrew" threadId="welcome" run={run} />);
  await user.click(await screen.findByRole("button", { name: "README.md modified" }));
  expect(await screen.findByText("+<script>alert(2)</script>")).toBeTruthy();
  expect(document.querySelector("script")).toBeNull();
  expect(api.source!.patch).toHaveBeenCalledWith("welcome", "run", "README.md", version);
});
it("clears source and patch contents on stale/revoked/mismatched replies", async () => {
  for (const failure of [new ApiError(409), new ApiError(404), "mismatch"]) {
    const api = fixture(),
      user = userEvent.setup();
    (api.source!.file as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      if (failure === "mismatch") return { ...file, threadId: "other" };
      throw failure;
    });
    render(<RepositoryFiles api={api} projectId="pitcrew" threadId="welcome" />);
    await user.click(await screen.findByRole("button", { name: "README.md" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.queryByRole("list")).toBeNull();
    expect(screen.queryByRole("region")).toBeNull();
    cleanup();
  }
  const api = fixture(),
    user = userEvent.setup();
  (api.source!.patch as ReturnType<typeof vi.fn>).mockResolvedValue({
    ...patch,
    candidateSha: hash,
  });
  render(<RepositoryDiffs api={api} projectId="pitcrew" threadId="welcome" run={run} />);
  await user.click(await screen.findByRole("button", { name: "README.md modified" }));
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(screen.queryByRole("region")).toBeNull();
});
it("bounds rendering of newline-heavy file replies", async () => {
  const api = fixture(),
    user = userEvent.setup();
  (api.source!.file as ReturnType<typeof vi.fn>).mockResolvedValue({
    ...file,
    text: "\n".repeat(64000),
  });
  render(<RepositoryFiles api={api} projectId="pitcrew" threadId="welcome" />);
  await user.click(await screen.findByRole("button", { name: "README.md" }));
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(document.querySelectorAll(".source-line")).toHaveLength(0);
});
it("paginates immutable lists and reports supported non-text states truthfully", async () => {
  const api = fixture(),
    user = userEvent.setup();
  (api.source!.tree as ReturnType<typeof vi.fn>)
    .mockResolvedValueOnce({ ...tree, cursor: "100" })
    .mockResolvedValueOnce({
      ...tree,
      entries: [{ name: "link", path: "link", kind: "symlink", mode: "120000" }],
    });
  (api.source!.file as ReturnType<typeof vi.fn>).mockResolvedValue({
    ...file,
    path: "link",
    status: "symlink",
    text: undefined,
  });
  render(<RepositoryFiles api={api} projectId="pitcrew" threadId="welcome" />);
  await user.click(await screen.findByRole("button", { name: "Load more files" }));
  expect(api.source!.tree).toHaveBeenLastCalledWith("welcome", "", version, "100");
  await user.click(await screen.findByRole("button", { name: "link symlink" }));
  expect(await screen.findByText("Symbolic link. The viewer does not follow links.")).toBeTruthy();
});
it("drops old pending thread reads on unmount and does not claim source for fixture connections", async () => {
  const api = fixture();
  let resolve!: (tree: SourceTree) => void;
  (api.source!.tree as ReturnType<typeof vi.fn>).mockImplementationOnce(
    () =>
      new Promise<SourceTree>((r) => {
        resolve = r;
      }),
  );
  const view = render(
    <RepositoryFiles key="welcome" api={api} projectId="pitcrew" threadId="welcome" />,
  );
  view.rerender(<RepositoryFiles key="other" api={api} projectId="pitcrew" threadId="other" />);
  resolve(tree);
  await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
  expect(screen.queryByRole("list")).toBeNull();
  cleanup();
  render(<RepositoryFiles api={createFixtureApi()} projectId="pitcrew" threadId="welcome" />);
  expect(screen.getByText("Repository source is unavailable on this connection.")).toBeTruthy();
});
