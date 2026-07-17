import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react(), tsconfigPaths()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}", "vite-*.ts"],
      exclude: ["src/routeTree.gen.ts", "src/main.tsx"],
      reporter: ["text", "lcov"],
      // A real baseline (#4865), not an aspirational target: measured at ~87.65/87.17/78.9/88.79 the day this
      // was wired up, with a few points of buffer below that so routine formatting/refactor churn doesn't
      // false-fail. This is a floor meant to catch a genuine regression (a big untested addition), not a
      // ratchet — raise it incrementally as more of the pre-existing gaps (the three sibling API plugins'
      // own middleware-wiring layer, __root.tsx's nav shell) get covered over time, per-PR, not in one sweep.
      thresholds: {
        statements: 85,
        branches: 85,
        functions: 75,
        lines: 85,
      },
    },
  },
});
