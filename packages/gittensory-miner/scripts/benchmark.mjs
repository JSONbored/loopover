#!/usr/bin/env node
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  DEFAULT_RATE_LIMIT_HIGH_WATER_MARK,
  DEFAULT_RATE_LIMIT_LOW_WATER_MARK,
  resolveThrottledConcurrency,
} from "../lib/discovery-throttle.js";
import { resolveForgeConfig } from "../lib/forge-config.js";
import { fetchWithRetry } from "../lib/http-retry.js";
import {
  compareToBaseline,
  findUncheckableCases,
  formatBenchmarkReport,
  renderBaselineDocument,
  runBenchmark,
} from "./benchmark-harness.mjs";

// Committed micro-benchmark suite for the miner package (#4845), covering the two hot paths the issue names: the
// discovery fanout and the local-store read/write path. Runs on demand (`npm run miner:bench`) and produces a
// comparable, repeatable number per case, plus a committed baseline (`benchmarks/baseline.json`) to compare against.
//
// The two heaviest cases exercise real library code that requires the package's own runtime (Node >= 22.13:
// `node:sqlite` for the stores, JSON import attributes in the engine that the fanout pulls in). They are imported
// LAZILY and guarded, so this script still runs — and the lighter fanout-internal cases still produce real numbers —
// on any Node, degrading an unavailable case to a recorded `unavailable` status instead of crashing.

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_BASELINE_PATH = resolve(HERE, "../benchmarks/baseline.json");

// Per-case work sizes and defaults, named so a future tuner can see the intent rather than a bare literal. Each is
// chosen to push the timed unit well above clock granularity (steadier numbers) without making a run slow.
const THROTTLE_SWEEP_MAX_REMAINING = 300; // rate-limit-remaining values the throttle decision is swept across
const CONFIG_BATCH_SIZE = 50; // forge-config / http-retry calls batched per timed iteration
const SCHEDULER_ITEM_COUNT = 500; // items fed to the fanout scheduler / events seeded for the read case
const FANOUT_CONCURRENCY = 5; // in-flight worker cap the scheduler benchmark drives
const DEFAULT_ITERATIONS = 100;
const DEFAULT_WARMUP = 10;
const DEFAULT_REGRESSION_TOLERANCE = 0.25; // a case regresses when its mean exceeds baseline by more than this

/** Each case's `make()` returns `{ fn, teardown? }`, or throws to mark the case unavailable in this environment. */
const CASES = [
  {
    name: "discovery_throttle_resolve",
    group: "discovery-fanout",
    make() {
      // The rate-limit-aware concurrency decision the fanout re-evaluates on every worker-loop iteration (#4844).
      const fn = () => {
        for (let remaining = 0; remaining <= THROTTLE_SWEEP_MAX_REMAINING; remaining += 3) {
          resolveThrottledConcurrency(
            FANOUT_CONCURRENCY,
            remaining,
            DEFAULT_RATE_LIMIT_LOW_WATER_MARK,
            DEFAULT_RATE_LIMIT_HIGH_WATER_MARK,
          );
        }
      };
      return { fn };
    },
  },
  {
    name: "forge_config_resolve",
    group: "discovery-fanout",
    make() {
      // Per-fanout forge-config resolution (#4784). Batched per iteration so the timed unit is well above clock
      // granularity and the number is steadier.
      const overrides = { apiBaseUrl: "https://ghe.example.com/api/v3", userAgent: "gittensory-bench" };
      const fn = () => {
        for (let index = 0; index < CONFIG_BATCH_SIZE; index += 1) {
          resolveForgeConfig(overrides);
          resolveForgeConfig({});
        }
      };
      return { fn };
    },
  },
  {
    name: "http_retry_passthrough",
    group: "discovery-fanout",
    make() {
      // The per-request retry wrapper every fanout fetch goes through (#4829); a 2xx returns on the first attempt.
      // Batched per iteration so the timed unit is well above clock granularity.
      const okFetch = async () => ({ status: 200 });
      const instantSleep = async () => {};
      const fn = async () => {
        for (let index = 0; index < CONFIG_BATCH_SIZE; index += 1) {
          await fetchWithRetry(okFetch, "https://api.example.com/x", undefined, { sleepFn: instantSleep });
        }
      };
      return { fn };
    },
  },
  {
    name: "discovery_fanout_scheduler",
    group: "discovery-fanout",
    async make() {
      // The real bounded-concurrency scheduler that drives the fanout over many repos. Requires the package runtime
      // (the module imports the engine, which uses JSON import attributes).
      const { mapWithConcurrency } = await import("../lib/opportunity-fanout.js");
      const items = Array.from({ length: SCHEDULER_ITEM_COUNT }, (_unused, index) => index);
      const instantSleep = async () => {};
      const fn = async () => {
        await mapWithConcurrency(items, FANOUT_CONCURRENCY, async (value) => value * 2, () => FANOUT_CONCURRENCY, instantSleep);
      };
      return { fn };
    },
  },
  {
    name: "local_store_write",
    group: "local-store",
    async make() {
      const { initEventLedger } = await import("../lib/event-ledger.js"); // requires node:sqlite (Node >= 22.5)
      const root = mkdtempSync(join(tmpdir(), "gittensory-miner-bench-write-"));
      const ledger = initEventLedger(join(root, "event-ledger.sqlite3"));
      let counter = 0;
      const fn = () => {
        ledger.appendEvent({
          type: "discovered_issue",
          repoFullName: "acme/widgets",
          payload: { n: counter++ },
        });
      };
      return {
        fn,
        teardown: () => {
          ledger.close();
          rmSync(root, { recursive: true, force: true });
        },
      };
    },
  },
  {
    name: "local_store_read",
    group: "local-store",
    async make() {
      const { initEventLedger } = await import("../lib/event-ledger.js"); // requires node:sqlite (Node >= 22.5)
      const root = mkdtempSync(join(tmpdir(), "gittensory-miner-bench-read-"));
      const ledger = initEventLedger(join(root, "event-ledger.sqlite3"));
      for (let index = 0; index < SCHEDULER_ITEM_COUNT; index += 1) {
        ledger.appendEvent({ type: "discovered_issue", repoFullName: "acme/widgets", payload: { n: index } });
      }
      const fn = () => {
        ledger.readEvents({ repoFullName: "acme/widgets" });
      };
      return {
        fn,
        teardown: () => {
          ledger.close();
          rmSync(root, { recursive: true, force: true });
        },
      };
    },
  },
];

export function parseBenchmarkArgs(argv) {
  const options = {
    json: false,
    update: false,
    check: false,
    iterations: DEFAULT_ITERATIONS,
    warmup: DEFAULT_WARMUP,
    tolerance: DEFAULT_REGRESSION_TOLERANCE,
    baselinePath: DEFAULT_BASELINE_PATH,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--json") options.json = true;
    else if (token === "--update-baseline") options.update = true;
    else if (token === "--check") options.check = true;
    else if (token === "--iterations") options.iterations = readPositiveInt(argv[(index += 1)], options.iterations);
    else if (token === "--warmup") options.warmup = readPositiveInt(argv[(index += 1)], options.warmup);
    else if (token === "--tolerance") options.tolerance = readNumber(argv[(index += 1)], options.tolerance);
    else if (token === "--baseline") options.baselinePath = argv[(index += 1)] ?? options.baselinePath;
    else return { error: `Unknown option: ${token}` };
  }
  return options;
}

function readPositiveInt(raw, fallback) {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function readNumber(raw, fallback) {
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

/** Run every case, degrading an unavailable/erroring case to a recorded status rather than aborting the suite. */
export async function runAllBenchmarks({ iterations, warmup } = {}) {
  const results = [];
  for (const benchCase of CASES) {
    let made;
    try {
      made = await benchCase.make();
    } catch (error) {
      results.push({
        name: benchCase.name,
        group: benchCase.group,
        status: "unavailable",
        reason: error instanceof Error ? error.message.split("\n")[0] : String(error),
      });
      continue;
    }
    try {
      const result = await runBenchmark(benchCase.name, made.fn, { iterations, warmup, group: benchCase.group });
      results.push(result);
    } catch (error) {
      results.push({
        name: benchCase.name,
        group: benchCase.group,
        status: "errored",
        reason: error instanceof Error ? error.message.split("\n")[0] : String(error),
      });
    } finally {
      if (typeof made.teardown === "function") await made.teardown();
    }
  }
  return results;
}

function readBaseline(baselinePath) {
  if (!existsSync(baselinePath)) return null;
  try {
    return JSON.parse(readFileSync(baselinePath, "utf8"));
  } catch (error) {
    // Surface the parse failure instead of swallowing it: a corrupted baseline must not look identical to "no
    // baseline", which would silently disable regression checking on a bad commit (#4845).
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(`benchmark: failed to parse baseline at ${baselinePath}: ${detail}\n`);
    return null;
  }
}

async function main(argv) {
  const options = parseBenchmarkArgs(argv);
  if ("error" in options) {
    process.stderr.write(
      `${options.error}\nUsage: node scripts/benchmark.mjs [--json] [--iterations N] [--warmup N] [--update-baseline] [--check] [--tolerance F] [--baseline PATH]\n`,
    );
    process.exit(2);
  }

  const results = await runAllBenchmarks({ iterations: options.iterations, warmup: options.warmup });

  if (options.update) {
    const document = renderBaselineDocument(results, {
      nodeVersion: process.version,
      generatedAt: new Date().toISOString(),
    });
    writeFileSync(options.baselinePath, document);
    process.stdout.write(`benchmark: wrote baseline to ${options.baselinePath}\n`);
    return;
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ results }, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatBenchmarkReport(results)}\n`);
  }

  const baseline = readBaseline(options.baselinePath);
  if (baseline) {
    const comparisons = compareToBaseline(results, baseline, { tolerance: options.tolerance });
    const regressions = comparisons.filter((entry) => entry.regressed);
    if (!options.json && regressions.length > 0) {
      process.stderr.write(
        `\nRegressions (> ${Math.round(options.tolerance * 100)}% over baseline):\n` +
          regressions
            .map((entry) => `  ${entry.name}: ${entry.current} ms vs ${entry.baseline} ms baseline`)
            .join("\n") +
          "\n",
      );
    }
    // A non-`ok` current run or a non-`ok` committed baseline yields `regressed: false`, so a `--check` that only
    // looked at regressions would silently pass a baseline that cannot detect regressions for those cases (#4845).
    // Fail `--check` loudly instead, pointing at the supported-runtime regeneration that produces a full baseline.
    const uncheckable = options.check ? findUncheckableCases(results, baseline) : [];
    if (options.check && uncheckable.length > 0) {
      process.stderr.write(
        "\nUncheckable cases (no regression signal; regenerate the baseline on the package-supported runtime " +
          "(Node >= 22.13) with `npm run miner:bench -- --update-baseline`):\n" +
          uncheckable.map((entry) => `  ${entry.name}: ${entry.reason}`).join("\n") +
          "\n",
      );
    }
    if (options.check && (regressions.length > 0 || uncheckable.length > 0)) process.exit(1);
  } else if (options.check) {
    process.stderr.write("benchmark: no baseline to check against; run with --update-baseline first.\n");
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main(process.argv.slice(2));
}
