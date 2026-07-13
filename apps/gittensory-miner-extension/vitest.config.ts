import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      // Import-based suite only: content.js/options.js need a jsdom mount harness (deferred follow-up).
      include: ["background.js", "opportunity-badge.js", "toolbar-badge.js"],
      reporter: ["text", "lcov"],
      // Measured baseline (#4865) with a small buffer below the day-this-was-wired numbers so routine
      // churn does not false-fail. Raise per-PR as content.js/options.js get covered.
      thresholds: {
        statements: 98,
        branches: 94,
        functions: 98,
        lines: 98,
      },
    },
  },
});
