import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import { openRouterConnectionPlugin } from "../../scripts/openrouter-connection.mjs";
import { backendRelayPlugin } from "../../scripts/backend-relay.mjs";
export default defineConfig({
  plugins: [
    react(),
    backendRelayPlugin({
      enabled: process.env.PITCREW_REPOSITORY_RELAY === "true",
      userAccessSession: process.env.PITCREW_ACCESS_SESSION === "user-cache",
    }),
    openRouterConnectionPlugin({
      enabled: process.env.PITCREW_OPENROUTER_SETUP === "true",
      userWranglerAuth: process.env.PITCREW_OPENROUTER_AUTH_CONTEXT === "user-preferences",
    }),
  ],
  server: { host: "127.0.0.1", proxy: { "/api": "http://127.0.0.1:8787" } },
  test: { environment: "jsdom", include: ["src/**/*.test.tsx", "src/**/*.test.ts"] },
});
