import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    include: ["src/visualizations/*.test.tsx", "src/visualizations/*.test.ts"],
  },
});
