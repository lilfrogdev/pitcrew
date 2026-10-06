import { createRoot } from "react-dom/client";
import { useState } from "react";
import { Workspace } from "../src/Workspace";
import { httpApi } from "../src/api";
import { VisualizationWorkspace } from "../src/visualizations/VisualizationWorkspace";
import type { VisualizationSource } from "../src/visualizations/controller";
import "../src/styles.css";
import "./visualizations.css";
const source: VisualizationSource = {
  accountId: "account:demo",
  repositoryId: "pitcrew",
  threadId: "visualization",
  load: (signal) => httpApi.visualizations!("pitcrew", "visualization", signal),
};
function Demo() {
  const [collapsed, setCollapsed] = useState(false);
  return (
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
      <Workspace
        scope="pitcrew:visualization"
        snapshot={{ messages: [], runs: [], reviews: [], evidence: [] }}
        api={httpApi}
        collapsed={collapsed}
        onCollapse={setCollapsed}
        visualizations={<VisualizationWorkspace source={source} authorized />}
      >
        Review fixture
      </Workspace>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Demo />);
