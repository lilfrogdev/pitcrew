import { defineConfig } from "vite-plus";
export default defineConfig({
  fmt: {},
  lint: {},
  test: {
    include: [
      "apps/worker/src/**/*.test.ts",
      "apps/worker/test/repository-management*.test.ts",
      "apps/worker/test/agent-team*.test.ts",
      "packages/**/*.test.ts",
    ],
  },
});
