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
    include: ["test/workers/**/*.test.ts"],
  },
});
