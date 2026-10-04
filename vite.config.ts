import { defineConfig } from "vite-plus";
export default defineConfig({
  fmt: {},
  lint: {},
  test: { include: ["apps/worker/src/**/*.test.ts", "packages/**/*.test.ts"] },
});
