import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import { openRouterConnectionPlugin } from "../../scripts/openrouter-connection.mjs";
export default defineConfig({
  plugins: [
    react(),
    openRouterConnectionPlugin({ enabled: process.env.PITCREW_OPENROUTER_SETUP === "true" }),
  ],
  server: { host: "127.0.0.1", proxy: { "/api": "http://127.0.0.1:8787" } },
  test: { environment: "jsdom", include: ["src/**/*.test.tsx", "src/**/*.test.ts"] },
});
