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
      // Emit lcov for Codecov to compute patch (changed-lines) coverage.
      reporter: ["text", "lcov"],
      // The 97% requirement now lives in codecov.yml as a *patch* gate (changed
      // lines only), which is compositional: merging one PR can't drop another
      // below the bar. These global thresholds are only a loose catastrophe net
      // (e.g. a deleted test file), set well below actual coverage so routine
      // PRs never trip them. Do NOT raise these toward the real coverage number
      // or the cross-PR churn returns.
      //
      // Disabled when COVERAGE_NO_THRESHOLDS is set: CI shards the suite, and a
      // single shard only exercises part of the tree, so a per-shard global
      // threshold would always false-fail. CI gates coverage via Codecov on the
      // merged shards instead; this backstop still runs on the full local
      // `npm run test:coverage`. Spread-omit the key (rather than set it to
      // undefined) to satisfy exactOptionalPropertyTypes.
      ...(process.env.COVERAGE_NO_THRESHOLDS
        ? {}
        : {
            thresholds: {
              lines: 90,
              functions: 90,
              branches: 90,
              statements: 90,
            },
          }),
    },
  },
});
