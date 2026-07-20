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
        "packages/loopover-miner/lib/**/*.js",
        // Files converted to real TypeScript (#7290 / #7317) execute as the compiled .js above, but
        // v8's coverage provider remaps through the inline sourcemap tsc emits, attributing coverage to
        // the .ts source instead -- this entry is what keeps that remapped file in the report.
        "packages/loopover-miner/lib/**/*.ts",
        // bin/loopover-miner-mcp.ts exports createMinerMcpServer, imported in-process by
        // test/unit/miner-mcp-*.test.ts -- genuinely unit-coverable, same as lib/ above. Its sibling
        // bin/loopover-miner.ts (the plain CLI dispatcher: no exports, subprocess-only tested via
        // test/unit/support/miner-cli-harness.ts) is NOT ignore-listed in codecov.yml -- test/unit/
        // codecov-policy.test.ts (#4864) forbids a blanket exemption for packages/loopover-miner, so it
        // stays included and genuinely graded (near-0% today) until it either gains real in-process tests
        // or is refactored into a testable export the way bin/loopover-miner-mcp.ts already was.
        "packages/loopover-miner/bin/**/*.js",
        "packages/loopover-miner/bin/**/*.ts",
        "packages/discovery-index/src/**/*.ts",
        // packages/loopover-mcp/lib/*.js are plain JS today; issue #7291 migrates them to real TypeScript,
        // keeping the same .js/.ts/.d.ts triplet shape packages/loopover-miner/lib/** already has (so
        // coverage is wired BEFORE that PR lands, not as a follow-up fix). All 5 files
        // (format-table/local-branch/redact-local-path/telemetry/cli-error) are now imported in-process
        // by test/unit/*.test.ts (cli-error's own test/unit/mcp-cli-error.test.ts landed in #7409), so a
        // PR touching any of them is covered by codecov/patch -- that's intended enforcement, not a bug.
        "packages/loopover-mcp/lib/**/*.js",
        "packages/loopover-mcp/lib/**/*.ts",
        // packages/loopover-mcp/bin/loopover-mcp.js (~6,600 of ~7,400 lines in the package) is tested
        // exclusively via subprocess spawn (test/unit/mcp-cli-*.test.ts, mcp-discovery.test.ts et al,
        // through test/unit/support/mcp-cli-harness.ts's execFileSync/StdioClientTransport). Same shape as
        // packages/loopover-miner/bin/loopover-miner.ts above -- and, consistent with that file NOT getting
        // a codecov.yml exemption (#4864), this isn't ignore-listed either: #7291 (the TS migration) will
        // need real in-process tests or a testable-export refactor for this file, not a free pass.
        "packages/loopover-mcp/bin/**/*.js",
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
      // packages/loopover-miner/lib/**/*.ts (above) also glob-matches its own emitted *.d.ts siblings
      // (a ".d.ts" path ends in ".ts" too) -- those aren't real modules and can't be
      // parsed as coverage source, so they're excluded the same way src/env.d.ts already is. Same story
      // for the *.ts entries under packages/loopover-miner/bin/** and packages/loopover-mcp/{lib,bin}/**
      // added above -- each glob-matches its own *.d.ts siblings too.
      exclude: [
        "src/env.d.ts",
        "apps/**",
        "packages/discovery-index/src/server.ts",
        "packages/loopover-miner/lib/**/*.d.ts",
        "packages/loopover-miner/bin/**/*.d.ts",
        "packages/loopover-mcp/lib/**/*.d.ts",
        "packages/loopover-mcp/bin/**/*.d.ts",
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
      // All four are set below 90 (not just branches) because of a reproducible v8
      // `--mergeReports` artifact, not a real coverage drop: merging a shard that
      // never touches a given compiled-from-.ts miner lib file (packages/loopover-
      // miner/lib/**/*.js, remapped to .ts via inline sourcemap, #7290) with a
      // shard that does can REDUCE that file's reported hit ratio -- on ANY of the
      // four metrics -- below what the exercising shard alone reported. Confirmed
      // with an isolated 2-shard --reporter=blob + --mergeReports repro on a single
      // file (a file at 99%+ branches in its own shard dropped to ~71% once merged
      // with a shard that ran zero of its tests), unaffected by `coverage.all`. It
      // does not reproduce on plain live-transformed .ts (src/**, packages/loopover-
      // engine/src/**), only on this pre-compiled .ts-with-inline-sourcemap remap
      // path, and grows as more packages/loopover-miner/lib files convert from .js
      // to .ts (#7290 phase 2+) -- branches alone tripped first (PR #7351, widened
      // to 85), then functions tripped next batch at 89.74% even with branches
      // fixed, confirming this isn't a one-metric fluke. All four are widened
      // together now, with real margin, so each further batch in this multi-phase
      // migration doesn't need its own one-metric-at-a-time fix here.
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
