import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { App } from "./App";
import { createFixtureApi } from "./fixtures";
import { Workspace, WorkspaceResize } from "./Workspace";
afterEach(cleanup);
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
