import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { App } from "./App";
import { createFixtureApi } from "./fixtures";
import { Workspace, WorkspaceResize } from "./Workspace";
import { VisualizationWorkspace } from "./visualizations/VisualizationWorkspace";
import type { Snapshot } from "./api";
afterEach(cleanup);
it("mounts visual replies once and disposes frame/private text on tab switch, collapse, scope and access loss", async () => {
  const user = userEvent.setup(),
    api = createFixtureApi(),
    snapshot: Snapshot = { messages: [], runs: [], reviews: [], evidence: [] };
  const version = "1".repeat(64),
    baseSha = "a".repeat(40),
    candidateSha = "b".repeat(40);
  const project = {
    id: "repo",
    name: "Repository",
    repository: "synthetic/example",
    baseSha,
    configurationRevision: "cfg",
  };
  const binding = { projectId: "repo", threadId: "thread", sourceId: "source", version };
  const diffBinding = {
    ...binding,
    artifactId: "fork",
    runId: "run",
    baseSha,
    candidateSha,
    configurationRevision: "cfg",
  };
  snapshot.runs.push({
    id: "run",
    threadId: "thread",
    baseSha,
    candidateSha,
    configurationRevision: "cfg",
    status: "awaiting_review",
  });
  api.source = {
    tree: async () => ({
      ...binding,
      sha: baseSha,
      path: "",
      entries: [{ name: "README.md", path: "README.md", kind: "file", mode: "100644" }],
      cursor: null,
    }),
    file: async () => ({
      ...binding,
      sha: baseSha,
      path: "README.md",
      status: "text",
      text: "Combined source file",
      bytes: 20,
    }),
    diff: async () => ({
      ...diffBinding,
      entries: [{ path: "README.md", change: "modified" }],
      total: 1,
      cursor: null,
      renameDetection: false,
    }),
    patch: async () => ({
      ...diffBinding,
      path: "README.md",
      status: "text",
      patch: "--- a/README.md\n+++ b/README.md\n@@ -1,1 +1,1 @@\n-old\n+Combined patch\n",
    }),
  };
  const record = {
    id: "chart",
    version: 1,
    repositoryId: "repo",
    threadId: "thread",
    creatorActor: "account:viewer",
    turnId: "turn",
    invocationId: "call",
    createdAt: 1,
    revision: 1,
    digest: "a".repeat(64),
    content: {
      kind: "bars",
      title: "Private visual",
      summary: "Private fallback",
      height: 320,
      points: [{ label: "A", value: 1 }],
    },
  };
  let permitted = true;
  const source = {
    accountId: "account:viewer",
    repositoryId: "repo",
    threadId: "thread",
    load: async () => {
      if (!permitted) throw Error("revoked");
      return {
        accountId: "account:viewer",
        repositoryId: "repo",
        threadId: "thread",
        accessEpoch: "epoch",
        leaseMs: 5000,
        artifacts: [
          record,
          {
            ...record,
            id: "second",
            content: { ...record.content, title: "Second visual", summary: "Second fallback" },
          },
          {
            ...record,
            id: "third",
            content: { ...record.content, title: "Third visual", summary: "Third fallback" },
          },
        ],
      };
    },
  };
  const visualizations = <VisualizationWorkspace source={source} authorized />;
  const props = {
    scope: "repo:thread",
    project,
    threadId: "thread",
    snapshot,
    api,
    onCollapse: () => {},
    visualizations,
    children: "Review",
  };
  const view = render(<Workspace {...props} collapsed={false} />);
  expect(view.container.querySelector("iframe")).toBeNull();
  await user.click(screen.getByRole("tab", { name: "Visuals" }));
  await screen.findByText("Private fallback");
  expect(view.container.querySelectorAll("iframe")).toHaveLength(2);
  await user.click(screen.getByRole("button", { name: "Next visualizations" }));
  expect(screen.getByTitle("Third visual")).toBeTruthy();
  expect(view.container.querySelectorAll("iframe")).toHaveLength(1);
  expect(screen.queryByTitle("Private visual")).toBeNull();
  expect(screen.queryByTitle("Second visual")).toBeNull();
  expect(
    (screen.getByRole("button", { name: "Next visualizations" }) as HTMLButtonElement).disabled,
  ).toBe(true);
  await user.click(screen.getByRole("button", { name: "Previous visualizations" }));
  expect(view.container.querySelectorAll("iframe")).toHaveLength(2);
  await user.click(screen.getByRole("tab", { name: "Files" }));
  expect(view.container.querySelector("iframe")).toBeNull();
  expect(view.container.textContent).not.toContain("Private fallback");
  await user.click(await screen.findByRole("button", { name: "README.md" }));
  expect(await screen.findByText("Combined source file")).toBeTruthy();
  await user.click(screen.getByRole("tab", { name: "Diffs" }));
  expect(screen.queryByText("Combined source file")).toBeNull();
  await user.click(await screen.findByRole("button", { name: "README.md modified" }));
  expect(await screen.findByText("+Combined patch")).toBeTruthy();
  await user.click(screen.getByRole("tab", { name: "Visuals" }));
  await screen.findByText("Private fallback");
  expect(screen.queryByText("+Combined patch")).toBeNull();
  view.rerender(<Workspace {...props} collapsed />);
  expect(view.container.querySelector("iframe")).toBeNull();
  expect(view.container.textContent).not.toContain("Private fallback");
  view.rerender(<Workspace {...props} collapsed={false} />);
  await screen.findByText("Private fallback");
  view.rerender(<Workspace {...props} scope="other" collapsed={false} />);
  expect(view.container.querySelector("iframe")).toBeNull();
  await user.click(screen.getByRole("tab", { name: "Visuals" }));
  await screen.findByText("Private fallback");
  permitted = false;
  window.dispatchEvent(new Event("pitcrew-access-lost"));
  await screen.findByText("Visualizations are unavailable or awaiting access verification.");
  expect(view.container.querySelector("iframe")).toBeNull();
  expect(view.container.textContent).not.toContain("Private fallback");
  expect(screen.queryByRole("navigation", { name: "Visualization pages" })).toBeNull();
});
it("retains thread-specific workspace tabs and chat drafts across collapse and thread switches", async () => {
  const user = userEvent.setup();
  render(<App api={createFixtureApi()} demo />);
  await screen.findByRole("heading", { name: "Make agent work visible" });
  const composer = screen.getByLabelText("Message your crew");
  await user.type(composer, "Keep this draft");
  await user.click(screen.getByRole("tab", { name: "Review / PR" }));
  expect(screen.getByText("Synthetic review: layout and tests match the candidate.")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Collapse workspace" }));
  expect(screen.queryByRole("tab")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Expand workspace" }));
  expect(screen.getByRole("tab", { name: "Review / PR" }).getAttribute("aria-selected")).toBe(
    "true",
  );
  await user.click(screen.getByRole("button", { name: "Recover interrupted work" }));
  expect(screen.getByRole("tab", { name: "Browser" }).getAttribute("aria-selected")).toBe("true");
  await user.click(screen.getByRole("button", { name: "Make agent work visible" }));
  expect(screen.getByRole("tab", { name: "Review / PR" }).getAttribute("aria-selected")).toBe(
    "true",
  );
  expect((composer as HTMLTextAreaElement).value).toBe("Keep this draft");
});
it("supports keyboard tabs, submitted text files, truthful diff states and safe preview URLs", async () => {
  const user = userEvent.setup();
  const snapshot = await createFixtureApi().snapshot("welcome");
  snapshot.messages[0].attachments = [
    {
      id: "text",
      name: "notes.txt",
      mediaType: "text/plain",
      text: "<script>plain text only</script>",
    },
  ];
  render(
    <Workspace
      scope="one"
      snapshot={snapshot}
      api={createFixtureApi()}
      collapsed={false}
      onCollapse={() => {}}
    >
      review controls
    </Workspace>,
  );
  screen.getByRole("tab", { name: "Browser" }).focus();
  await user.keyboard("{ArrowRight}");
  expect(screen.getByRole("tab", { name: "Files" })).toBe(document.activeElement);
  expect(screen.getByText("<script>plain text only</script>")).toBeTruthy();
  await user.keyboard("{ArrowRight}");
  expect(screen.getByText(/Patch content unavailable/)).toBeTruthy();
  expect(screen.getByText(snapshot.runs[0].candidateSha!)).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Inspect review evidence" }));
  expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Review / PR" }));
  await user.click(screen.getByRole("tab", { name: "Browser" }));
  for (const url of ["javascript:alert(1)", "https://user:secret@example.com"]) {
    await user.clear(screen.getByLabelText("Preview URL"));
    await user.type(screen.getByLabelText("Preview URL"), url);
    await user.click(screen.getByRole("button", { name: "Load" }));
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.queryByTitle("Workspace browser preview")).toBeNull();
  }
  await user.clear(screen.getByLabelText("Preview URL"));
  await user.type(screen.getByLabelText("Preview URL"), "http://localhost:3000");
  await user.click(screen.getByRole("button", { name: "Load" }));
  expect(screen.getByTitle("Workspace browser preview").getAttribute("sandbox")).toBe(
    "allow-scripts",
  );
  const workspace = screen.getByRole("complementary", { name: "Thread workspace" });
  expect(
    within(workspace).getByRole("link", { name: "Open in browser ↗" }).getAttribute("rel"),
  ).toBe("noopener noreferrer");
});
it("resizes with keyboard within bounds", async () => {
  const onWidth = vi.fn();
  const user = userEvent.setup();
  render(<WorkspaceResize width={380} onWidth={onWidth} />);
  screen.getByRole("separator").focus();
  await user.keyboard("{ArrowLeft}{Home}{End}");
  expect(onWidth.mock.calls).toEqual([[400], [300], [640]]);
});
