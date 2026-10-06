import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import { openRouterConnectionPlugin } from "../../scripts/openrouter-connection.mjs";
import { backendRelayPlugin } from "../../scripts/backend-relay.mjs";
import { authRelayPlugin } from "../../scripts/auth-relay.mjs";
const accountsEnabled = process.env.PITCREW_ACCOUNT_AUTH === "true";
const userAccessSession = process.env.PITCREW_ACCESS_SESSION === "user-cache";
const authRelay = authRelayPlugin({
  enabled: accountsEnabled,
  userAccessSession,
  origin: "http://127.0.0.1:5173",
});
export default defineConfig({
  plugins: [
    react(),
    authRelay,
    backendRelayPlugin({
      enabled: accountsEnabled || process.env.PITCREW_REPOSITORY_RELAY === "true",
      userAccessSession,
      sharedApi: accountsEnabled,
      sessionHeaders: authRelay.sessionHeaders,
    }),
    openRouterConnectionPlugin({
      enabled: process.env.PITCREW_OPENROUTER_SETUP === "true",
      userAccessSession,
      sharedApi: accountsEnabled,
      sessionHeaders: authRelay.sessionHeaders,
    }),
  ],
  server: { host: "127.0.0.1", port: 5173, strictPort: true, proxy: { "/api": "http://127.0.0.1:8787" } },
  test: { environment: "jsdom", include: ["src/**/*.test.tsx", "src/**/*.test.ts"] },
});
