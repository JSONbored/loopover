import { defineConfig } from "vitest/config";

const junitPath = process.env.VITEST_JUNIT_PATH;

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
    globalSetup: ["./test/helpers/vitest-global-setup-node-version.ts"],
    setupFiles: ["./test/helpers/vitest-setup.ts"],
    // Retry a failed test once before failing the run. The loopover gate auto-CLOSES a contributor PR
    // on a red required CI, so a single transient flake must not kill an honest PR; a deterministic
    // failure still fails both attempts (and vitest flags the retried test as flaky so it stays visible).
    // "Stays visible" means Codecov Test Analytics, not just the vitest run log: ci.yml already uploads
    // each shard's JUnit report with report_type: test_results, which auto-enables Codecov's flaky-test
    // detection with no extra config -- it's live today (see the "Tests" tab on any recent PR/commit in
    // Codecov, or that PR's own Codecov bot comment). No dashboard is wired up to surface it proactively,
    // so check it deliberately if a retry shows up in CI output rather than assuming it's pure infra noise.
    retry: 1,
    include: ["test/**/*.test.ts"],
    exclude: ["test/workers/**/*.test.ts"],
    reporters: junitPath ? ["default", "junit"] : ["default"],
    ...(junitPath ? { outputFile: { junit: junitPath } } : {}),
    coverage: {
      provider: "v8",
      include: [
        "src/**/*.ts",
        "packages/loopover-engine/src/**/*.ts",
        // packages/loopover-{miner,mcp} compile out-of-place into dist/ (lib/foo.ts -> dist/lib/foo.js,
        // matching packages/loopover-engine's src/ -> dist/ split since the 2026-07-24 migration -- see
        // each package's tsconfig.json outDir comment). Only .ts is listed: dist/ is gitignored, never
        // scanned by coverage, and holds no .ts of its own, so there's no id-mismatch to work around --
        // Vite/esbuild resolve these packages' NodeNext .js-suffixed import specifiers straight to the
        // sibling .ts by ordinary default fallback (nothing lives at the .js path inside lib/bin/ to
        // resolve to instead), the same behavior packages/loopover-engine/src/**'s own .js-suffixed
        // imports have always relied on. (Before the migration, an in-place compiled .js sitting next to
        // its .ts source caused Vite to resolve the literal .js instead, misattributing coverage to the
        // built-file identity -- the 2026-07-24 codecov/patch (0%/99%) incident, temporarily worked around
        // with a custom resolver plugin before this directory split made the workaround unnecessary.)
        "packages/loopover-miner/lib/**/*.ts",
        // bin/loopover-miner-mcp.ts exports createMinerMcpServer, imported in-process by
        // test/unit/miner-mcp-*.test.ts -- genuinely unit-coverable, same as lib/ above. Its sibling
        // bin/loopover-miner.ts (the plain CLI dispatcher: no exports, subprocess-only tested via
        // test/unit/support/miner-cli-harness.ts, spawned via Node's own --experimental-strip-types)
        // is NOT ignore-listed in codecov.yml -- test/unit/codecov-policy.test.ts (#4864) forbids a
        // blanket exemption for packages/loopover-miner, so it stays included and genuinely graded
        // (near-0% today) until it either gains real in-process tests or is refactored into a testable
        // export the way bin/loopover-miner-mcp.ts already was.
        "packages/loopover-miner/bin/**/*.ts",
        "packages/discovery-index/src/**/*.ts",
        // All 5 packages/loopover-mcp/lib/*.ts files (format-table/local-branch/redact-local-path/
        // telemetry/cli-error) are imported in-process by test/unit/*.test.ts (cli-error's own
        // test/unit/mcp-cli-error.test.ts landed in #7409), so a PR touching any of them is covered by
        // codecov/patch -- that's intended enforcement, not a bug.
        "packages/loopover-mcp/lib/**/*.ts",
        // packages/loopover-mcp/bin/loopover-mcp.ts (~6,600 of ~7,400 lines in the package) is tested
        // exclusively via subprocess spawn (test/unit/mcp-cli-*.test.ts, mcp-discovery.test.ts et al) --
        // same shape as packages/loopover-miner/bin/loopover-miner.ts above -- and, consistent with that
        // file not getting a codecov.yml exemption either (#4864), this isn't ignore-listed: it stays
        // included and genuinely graded until it either gains real in-process tests or is refactored
        // into a testable export.
        "packages/loopover-mcp/bin/**/*.ts",
        // review-enrichment is a standalone (non-workspace) package with its own node:test suite; its
        // coverage is collected separately via `npm run rees:coverage` (c8 over the built dist, remapped
        // to src through source maps) and uploaded to Codecov under the `rees` flag -- vitest never runs
        // it, so it must not be listed here (an entry here just reports 0% for files vitest can't reach).
      ],
      // packages/discovery-index/src/server.ts is the process entrypoint (calls @hono/node-server's serve()
      // as a side effect of import) -- like the main app's own src/server.ts, it's exercised by a Docker
      // build+boot path, not unit-coverable without actually binding a port. See codecov.yml's matching
      // ignore entry; app.ts (everything server.ts wires together) is what tests actually import.
      //
      // packages/discovery-index/src/worker.ts (#7167) is the Cloudflare Container/Durable Object entry
      // point -- pure infra glue exercised only by real Cloudflare Containers infrastructure, same
      // reasoning as server.ts above. rate-limiter.ts is NOT excluded despite living alongside it -- its
      // DiscoveryIndexRateLimiter DO and enforceDiscoveryIndexRateLimit are unit-tested directly with a
      // fake DurableObjectState/namespace, the same pattern the main app's own RateLimiter DO already uses
      // (test/unit/auth.test.ts's memoryDurableObjectState helper) -- see
      // test/unit/discovery-index/rate-limiter.test.ts. env.d.ts is an ambient .d.ts (no executable
      // statements, matches src/env.d.ts's own exclusion above). worker-configuration.d.ts is
      // wrangler-generated.
      //
      // packages/loopover-{miner,mcp}'s *.ts include globs above need no *.d.ts exclusion: since the
      // 2026-07-24 dist/ migration, tsc emits declarations into dist/lib/ and dist/bin/ (gitignored,
      // never scanned by coverage), so lib/** and bin/** now contain only hand-written .ts source -- no
      // emitted .d.ts sibling for a ".ts"-ending glob to accidentally sweep in.
      exclude: [
        "src/env.d.ts",
        "apps/**",
        "packages/discovery-index/src/server.ts",
        "packages/discovery-index/src/worker.ts",
        "packages/discovery-index/src/env.d.ts",
        "packages/discovery-index/worker-configuration.d.ts",
      ],
      // Emit lcov for Codecov to compute patch (changed-lines) coverage.
      reporter: ["text", "lcov"],
      // The 99% requirement now lives in codecov.yml as a *patch* gate (changed
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
      // All four are set below 90 (not just branches), originally to route around a reproducible v8
      // `--mergeReports` artifact, not a real coverage drop: merging a shard that never touched a given
      // compiled-from-.ts miner lib file (packages/loopover-miner/lib/**/*.js, remapped to .ts via inline
      // sourcemap, #7290) with a shard that did could REDUCE that file's reported hit ratio -- on ANY of
      // the four metrics -- below what the exercising shard alone reported (confirmed with an isolated
      // 2-shard --reporter=blob + --mergeReports repro: a file at 99%+ branches in its own shard dropped
      // to ~71% once merged with a shard that ran zero of its tests, unaffected by `coverage.all`). That
      // never reproduced on plain live-transformed .ts (src/**, packages/loopover-engine/src/**), only on
      // the pre-compiled .ts-with-inline-sourcemap remap path -- which no longer exists anywhere in this
      // include list (packages/loopover-{miner,mcp} now execute their real .ts directly too, same as
      // everything else here), so this specific artifact's precondition is gone. Left at 80 anyway rather
      // than raised back toward 90: the widening predates the mergeReports fix by multiple rounds (PR
      // #7351 widened branches to 85 for it; the next batch tripped functions at 89.74% even with branches
      // already fixed) and the note two paragraphs up ("Do NOT raise these... or the cross-PR churn
      // returns") describes a separate, still-live reason to stay low that this change doesn't touch --
      // revisiting the threshold itself is a deliberate follow-up decision, not a side effect of this one.
      // `npm run test:coverage` (unsharded, no merge) is unaffected and is the
      // faithful local signal; only CI's sharded validate-tests-merge job sees
      // this. Real per-line/branch enforcement is Codecov's codecov/patch gate
      // (changed lines only, computed from the same merged lcov -- also
      // unaffected, since it diffs hit-or-not per line rather than trusting an
      // aggregate ratio), not this backstop.
      ...(process.env.COVERAGE_NO_THRESHOLDS
        ? {}
        : {
            thresholds: {
              lines: 80,
              functions: 80,
              branches: 80,
              statements: 80,
            },
          }),
    },
  },
});
