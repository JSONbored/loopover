import { performance } from "node:perf_hooks";

// Pure micro-benchmark harness for the miner package (#4845): timing, summary statistics, human/JSON reporting,
// and baseline comparison. Deliberately dependency-free (only `node:perf_hooks`) and side-effect-free so it can be
// unit-tested with an injected clock and reused by `benchmark.mjs`. It measures; it never decides pass/fail on its
// own (the caller applies a tolerance) so a timing wobble can't become a flaky hard failure.

const defaultNow = () => performance.now();

function median(sortedAscending) {
  const mid = Math.floor(sortedAscending.length / 2);
  return sortedAscending.length % 2 === 0
    ? (sortedAscending[mid - 1] + sortedAscending[mid]) / 2
    : sortedAscending[mid];
}

/** Round to 4 decimal places so committed baselines stay stable against sub-microsecond jitter. */
export function roundMetric(value) {
  return Math.round(value * 1e4) / 1e4;
}

/** Summary statistics for a list of per-iteration durations (ms). An empty list yields all-zero stats. */
export function summarizeDurations(durationsMs) {
  const sorted = [...durationsMs].sort((a, b) => a - b);
  const iterations = sorted.length;
  if (iterations === 0) {
    return { iterations: 0, totalMs: 0, meanMs: 0, medianMs: 0, minMs: 0, maxMs: 0, opsPerSec: 0 };
  }
  const totalMs = sorted.reduce((sum, value) => sum + value, 0);
  const meanMs = totalMs / iterations;
  return {
    iterations,
    totalMs,
    meanMs,
    medianMs: median(sorted),
    minMs: sorted[0],
    maxMs: sorted[iterations - 1],
    opsPerSec: meanMs > 0 ? 1000 / meanMs : 0,
  };
}

/**
 * Time `fn` over `iterations` runs (after `warmup` untimed runs), collecting per-iteration durations from the
 * injectable `now` clock. Returns `{ name, group, status: "ok", ...summary }`. `fn` may be sync or async.
 */
export async function runBenchmark(name, fn, options = {}) {
  const iterations = Number.isInteger(options.iterations) && options.iterations > 0 ? options.iterations : 100;
  const warmup = Number.isInteger(options.warmup) && options.warmup >= 0 ? options.warmup : 10;
  const now = typeof options.now === "function" ? options.now : defaultNow;
  const group = typeof options.group === "string" ? options.group : "";

  for (let index = 0; index < warmup; index += 1) await fn();
  const durations = [];
  for (let index = 0; index < iterations; index += 1) {
    const start = now();
    await fn();
    durations.push(now() - start);
  }
  return { name, group, status: "ok", ...summarizeDurations(durations) };
}

/** One-line-per-case human report. Non-`ok` cases print their status/reason instead of numbers. */
export function formatBenchmarkReport(results) {
  return results
    .map((result) => {
      if (result.status !== "ok") {
        return `${result.name.padEnd(30)} ${result.status}${result.reason ? `: ${result.reason}` : ""}`;
      }
      return (
        `${result.name.padEnd(30)} ${roundMetric(result.meanMs)} ms mean  ` +
        `${roundMetric(result.medianMs)} ms median  ${Math.round(result.opsPerSec)} ops/s  (n=${result.iterations})`
      );
    })
    .join("\n");
}

/**
 * Compare current results against a committed baseline by name. A case regresses when its mean time exceeds the
 * baseline mean by more than `tolerance` (default 25%). Cases missing from the baseline, or not `ok`, are reported
 * with `deltaPct: null` and `regressed: false` — never a failure, so a newly-added case can't break a check run.
 */
export function compareToBaseline(results, baseline, options = {}) {
  const tolerance = typeof options.tolerance === "number" ? options.tolerance : 0.25;
  const baselineByName = new Map((baseline?.results ?? []).map((entry) => [entry.name, entry]));
  return results.map((result) => {
    const base = baselineByName.get(result.name);
    if (result.status !== "ok" || !base || base.status !== "ok" || typeof base.meanMs !== "number") {
      return {
        name: result.name,
        baseline: base && typeof base.meanMs === "number" ? base.meanMs : null,
        current: result.status === "ok" ? result.meanMs : null,
        deltaPct: null,
        regressed: false,
      };
    }
    // A legitimately zero-mean baseline (an all-zero-duration run below clock granularity) has no meaningful
    // ratio, so it reports a 0% delta rather than dividing by zero. This can in principle mask a real slowdown
    // from 0 -> nonzero; such a case is a signal the iteration count is too low to time, not a silent pass —
    // regenerate the baseline with more `--iterations` so the case produces a nonzero mean.
    const deltaPct = base.meanMs > 0 ? (result.meanMs - base.meanMs) / base.meanMs : 0;
    return { name: result.name, baseline: base.meanMs, current: result.meanMs, deltaPct, regressed: deltaPct > tolerance };
  });
}

/**
 * Identify cases a `--check` run cannot meaningfully regression-check (#4845): a case that did not produce an `ok`
 * result in this run (no current number), or whose committed baseline entry exists but is non-`ok` (nothing to
 * compare against). `compareToBaseline` reports both as `regressed: false`, so without this a non-`ok` committed
 * baseline would silently disable regression detection for that case. A brand-new case that ran `ok` but is absent
 * from the baseline is NOT flagged — it is simply new and cannot regress yet. Returns `{ name, reason }[]`.
 */
export function findUncheckableCases(results, baseline) {
  const baselineByName = new Map((baseline?.results ?? []).map((entry) => [entry.name, entry]));
  const uncheckable = [];
  for (const result of results) {
    const base = baselineByName.get(result.name);
    const currentOk = result.status === "ok";
    const baselineOk = base ? base.status === "ok" : false;
    if (currentOk && baselineOk) continue;
    if (currentOk && !base) continue;
    const reason = !currentOk
      ? `current run is ${result.status}${result.reason ? ` (${result.reason})` : ""}`
      : `baseline is ${base.status}${base.reason ? ` (${base.reason})` : ""}`;
    uncheckable.push({ name: result.name, reason });
  }
  return uncheckable;
}

/** Serialize results into the committed baseline document shape (rounded numbers + provenance metadata). */
export function renderBaselineDocument(results, meta = {}) {
  const rendered = results.map((result) =>
    result.status === "ok"
      ? {
          name: result.name,
          group: result.group ?? "",
          status: "ok",
          iterations: result.iterations,
          meanMs: roundMetric(result.meanMs),
          medianMs: roundMetric(result.medianMs),
          minMs: roundMetric(result.minMs),
          maxMs: roundMetric(result.maxMs),
          opsPerSec: roundMetric(result.opsPerSec),
        }
      : { name: result.name, group: result.group ?? "", status: result.status, reason: result.reason ?? null },
  );
  const document = {
    note:
      "Machine-dependent micro-benchmark baseline for the gittensory-miner package (#4845). " +
      "Numbers are only comparable within the same runtime; regenerate on yours with: " +
      "npm run miner:bench -- --update-baseline",
    nodeVersion: meta.nodeVersion ?? null,
    generatedAt: meta.generatedAt ?? null,
    results: rendered,
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}
