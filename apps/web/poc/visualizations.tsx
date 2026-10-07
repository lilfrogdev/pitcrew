import { createRoot } from "react-dom/client";
import { useState } from "react";
import { VisualizationFrame } from "../src/visualizations/VisualizationFrame";
import type { Scope, Visualization } from "../src/visualizations/document";
import "../src/styles.css";
import "./visualizations.css";
const scope: Scope = {
  accountId: "local-demo",
  repositoryId: "pitcrew",
  threadId: "visualization",
  accessEpoch: "1",
};
const artifact: Visualization = {
  ...scope,
  id: "chart-demo",
  version: 1,
  kind: "bars",
  title: "Where a turn spends time",
  summary:
    "Illustrative data: context 12, implementation 48, review 25, verification 15. Use the slider to filter categories and the sort button to compare values.",
  height: 360,
  points: [
    { label: "Context", value: 12 },
    { label: "Implementation", value: 48 },
    { label: "Review", value: 25 },
    { label: "Verification", value: 15 },
  ],
};
const tokens = {
  light: {
    canvas: "#f7f7f8",
    surface: "#ffffff",
    text: "#24262b",
    muted: "#626772",
    border: "#e3e5e8",
    accent: "#484d57",
    focus: "#737983",
  },
  dark: {
    canvas: "#18191c",
    surface: "#24262b",
    text: "#f1f3f7",
    muted: "#b1b6c0",
    border: "#40444d",
    accent: "#96a8cb",
    focus: "#adc0e5",
  },
};
function Demo() {
  const [mode, setMode] = useState<"light" | "dark">("light");
  const [authorized, setAuthorized] = useState(true);
  const [view, setView] = useState<"thread" | "workspace">("thread");
  const [hostile, setHostile] = useState(false);
  const [html, setHtml] = useState(false);
  function changeTheme(next: "light" | "dark") {
    setMode(next);
    document.documentElement.style.colorScheme = next;
    for (const [token, value] of Object.entries(tokens[next]))
      document.documentElement.style.setProperty(`--${token}`, value);
  }
  const selected: Visualization = hostile
    ? {
        ...artifact,
        kind: "html",
        fragment: '<img src="https://example.invalid/leak" onerror="parent.alert(1)"/>',
      }
    : html
      ? {
          ...artifact,
          kind: "html",
          title: "A visual planning note",
          summary:
            "A safe HTML planning note: gather context, make the change, and verify the outcome. The expandable explanation works without generated scripts.",
          fragment:
            '<section class="viz-card"><h2>A small change, clearly explained</h2><p class="viz-muted">HTML uses the same theme as the conversation.</p><ol><li>Gather context</li><li>Make the change</li><li>Verify the outcome</li></ol><details><summary>Why this order?</summary><p>Context narrows the work. Verification checks the result.</p></details></section>',
        }
      : artifact;
  return (
    <main className="viz-demo">
      <header>
        <span>PITCREW · LOCAL PROOF OF CONCEPT</span>
        <h1>Visual replies that feel at home</h1>
        <p>A chart in the conversation or the right workspace, using the host theme.</p>
      </header>
      <nav aria-label="Demo controls">
        <button
          onClick={() => {
            setHtml(!html);
            setHostile(false);
          }}
        >
          {html ? "Show chart" : "Show HTML summary"}
        </button>
        <button onClick={() => changeTheme(mode === "light" ? "dark" : "light")}>
          {mode === "light" ? "Dark" : "Light"} theme
        </button>
        <button onClick={() => setView(view === "thread" ? "workspace" : "thread")}>
          {view === "thread" ? "Open in workspace" : "Return to thread"}
        </button>
        <button onClick={() => setAuthorized(!authorized)}>
          {authorized ? "Simulate access loss" : "Restore demo access"}
        </button>
        <button onClick={() => setHostile(!hostile)}>
          {hostile ? "Show chart" : "Try blocked content"}
        </button>
      </nav>
      <div className={`demo-layout ${view}`}>
        <section className="demo-thread" aria-label="Conversation">
          <p className="demo-user">Show me where the work goes.</p>
          <p className="demo-reply">
            Here is an illustrative breakdown. You can filter and sort it.
          </p>
          {view === "thread" && (
            <VisualizationFrame artifact={selected} scope={scope} authorized={authorized} />
          )}
        </section>
        {view === "workspace" && (
          <aside aria-label="Thread workspace">
            <h2>Workspace</h2>
            <VisualizationFrame artifact={selected} scope={scope} authorized={authorized} />
          </aside>
        )}
      </div>
      <footer>
        Local fixture only. No account, repository, model, or storage requests. Arbitrary generated
        scripts are disabled in this first slice.
      </footer>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Demo />);
