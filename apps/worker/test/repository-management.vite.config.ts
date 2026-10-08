import { defineConfig } from "vite-plus";
export default defineConfig({
  test: {
    include: ["apps/worker/test/repository-management*.test.ts"],
    testTimeout: 90000,
    hookTimeout: 90000,
  },
});
