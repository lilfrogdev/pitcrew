import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  server: { host: "127.0.0.1", proxy: { "/api": "http://127.0.0.1:8787" } },
  test: { environment: "jsdom", include: ["src/**/*.test.tsx", "src/**/*.test.ts"] },
});
