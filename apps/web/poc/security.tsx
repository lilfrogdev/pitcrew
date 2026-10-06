import { createRoot } from "react-dom/client";
import { VisualizationWorkspace } from "../src/visualizations/VisualizationWorkspace";
import { loadVisualizationJson, type VisualizationSource } from "../src/visualizations/controller";
import "../src/styles.css";
import "./visualizations.css";
const source: VisualizationSource = {
  accountId: "account:demo",
  repositoryId: "pitcrew",
  threadId: "visualization",
  load: (signal) =>
    loadVisualizationJson("/api/projects/pitcrew/threads/visualization/visualizations", signal),
};
createRoot(document.getElementById("root")!).render(
  <main className="viz-demo">
    <h1>Private visual replies</h1>
    <p>Local admission and lifecycle harness</p>
    <button
      onClick={() => {
        void fetch("/fixture/revoke", { method: "POST" });
      }}
    >
      Revoke fixture membership
    </button>
    <VisualizationWorkspace source={source} authorized />
  </main>,
);
