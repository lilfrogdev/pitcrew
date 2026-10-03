import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { httpApi } from "./api";
import { createFixtureApi } from "./fixtures";
const demo = import.meta.env.DEV && import.meta.env.VITE_PITCREW_DEMO === "true";
const root = document.getElementById("root");
if (!root) throw new Error("Missing application root");
createRoot(root).render(
  <StrictMode>
    <App api={demo ? createFixtureApi() : httpApi} demo={demo} />
  </StrictMode>,
);
