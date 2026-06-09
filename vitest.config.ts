import { defineConfig } from "vitest/config";

export default defineConfig({
  ssr: {
    noExternal: ["agents", "partyserver"],
  },
  resolve: {
    alias: {
      "cloudflare:email": new URL("./test/stubs/cloudflare-email.ts", import.meta.url).pathname,
      "cloudflare:workers": new URL("./test/stubs/cloudflare-workers.ts", import.meta.url).pathname,
    },
  },
  test: {
    environment: "node",
    globals: true,
    testTimeout: 15000,
    include: ["test/**/*.test.ts"],
    exclude: ["test/workers/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/env.d.ts", "apps/**"],
      thresholds: {
        lines: 97,
        functions: 97,
        branches: 97,
        statements: 97,
      },
    },
  },
});
