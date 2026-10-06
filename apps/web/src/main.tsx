import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { httpApi } from "./api";
import { createFixtureApi } from "./fixtures";
import { AuthGate } from "./AuthGate";
import { httpAuthApi } from "./auth-api";
const demo = import.meta.env.DEV && import.meta.env.VITE_PITCREW_DEMO === "true";
const root = document.getElementById("root");
if (!root) throw new Error("Missing application root");
createRoot(root).render(
  <StrictMode>
    {demo ? (
      <App api={createFixtureApi()} demo />
    ) : (
      <AuthGate api={httpAuthApi}>
        {(viewer) => <App api={httpApi} auth={httpAuthApi} viewer={viewer} />}
      </AuthGate>
    )}
  </StrictMode>,
);
