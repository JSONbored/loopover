import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

// Package-local test runner for @loopover/ui-kit (#7437). Mirrors apps/loopover-miner-ui/vitest.config.ts's shape
// (jsdom + the React plugin + a Testing-Library cleanup setup) so the design system's own logic-bearing exports
// are verified directly, not only incidentally through whichever consuming app happens to import them. No
// `coverage` block: this package is deliberately not in the root vitest.config.ts's coverage.include and is not
// Codecov-gated -- the acceptance signal is that this suite runs and passes, not a percentage (see the issue).
export default defineConfig({
  plugins: [react(), tsconfigPaths()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
