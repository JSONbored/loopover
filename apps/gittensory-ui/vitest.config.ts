import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

// Standalone vitest config for component tests — intentionally NOT the full TanStack Start build config
// (which pulls in nitro/cloudflare wiring that has no place in a jsdom unit test). Only the React JSX
// transform and the `@/` path alias are needed.
export default defineConfig({
  plugins: [react(), tsconfigPaths()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
