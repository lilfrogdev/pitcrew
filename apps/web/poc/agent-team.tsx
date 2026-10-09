import { createRoot } from "react-dom/client";
import { AuthGate } from "../src/AuthGate";
import { httpAuthApi } from "../src/auth-api";
import { httpApi } from "../src/api";
import { App } from "../src/App";

// Production UI/adapters, temporary native-account Worker behind real relays.
createRoot(document.getElementById("root")!).render(
  <AuthGate api={httpAuthApi}>
    {(viewer) => <App api={httpApi} auth={httpAuthApi} viewer={viewer} />}
  </AuthGate>,
);
