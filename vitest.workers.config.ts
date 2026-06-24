import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.vitest.jsonc" },
    }),
  ],
  test: {
    globals: true,
    // Retry once before failing — a transient flake must not red the required CI and one-shot-close a PR.
    retry: 1,
    include: ["test/workers/**/*.test.ts"],
  },
});
