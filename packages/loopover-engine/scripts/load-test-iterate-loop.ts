#!/usr/bin/env node
import { performance } from "node:perf_hooks";
import { parseFocusManifest, runIterateLoop } from "../dist/index.js";

// Load-testing harness for the AMS iterate-loop orchestrator (#5224): every existing iterate-loop test is
// correctness-oriented (single attempt, fake driver returns instantly), so there is no signal today for how
// runIterateLoop behaves when many tenants' attempts run concurrently against shared infra. This harness
// reuses the SAME fake-driver injection seam iterate-loop.test.ts already exercises (a CodingAgentDriver whose
// `run()` never spawns a real subprocess or spends API budget) but adds a configurable artificial per-iteration
// delay, so the measured throughput reflects iterate-loop's own orchestration/scheduling overhead under
// concurrency rather than a network call's latency. See docs/iterate-loop-load-test.md (#5224) for how to run
// this and read the numbers, and issue #4913 for the parallel Worker-endpoint load-testing precedent.

export const DEFAULT_CONCURRENCY_LEVELS = [1, 8, 32, 128];
export const DEFAULT_ATTEMPTS_PER_LEVEL = 32;
export const DEFAULT_SIMULATED_DRIVER_LATENCY_MS = 15;

const SYNTHETIC_ISSUE_NUMBER = 7;

/** One open issue per synthetic tenant repo, matching that tenant's own `passesPredictedGate` linkage below --
 *  each tenant is a fully independent repo/contributor pair (`buildSelfReviewPredictedGateInput`'s own identity
 *  fields), the same "multi-tenant-like" shape the issue's Problem section asks this harness to load-test. */
function buildReviewContext(tenantRepoFullName) {
  return {
    manifest: parseFocusManifest({ gate: { duplicates: "block", linkedIssue: "advisory" } }),
    repo: { fullName: tenantRepoFullName, owner: tenantRepoFullName.split("/")[0], name: tenantRepoFullName.split("/")[1], isInstalled: true, isRegistered: true, isPrivate: false },
    issues: [{ repoFullName: tenantRepoFullName, number: SYNTHETIC_ISSUE_NUMBER, title: "Synthetic load-test issue", state: "open", labels: [], linkedPrs: [] }],
    pullRequests: [],
  };
}

/** A `CodingAgentDriver` (coding-agent-driver.ts) that never spawns a real subprocess or spends API budget --
 *  it resolves after `latencyMs` (simulating the wall-clock an iteration of a real coding-agent invocation
 *  would take) with a scripted, always-passing result. `latencyMs` uses a real `setTimeout`, not a busy-loop, so
 *  concurrent attempts genuinely interleave on the event loop the way concurrent live attempts would. */
export function buildFakeLoadTestDriver(latencyMs) {
  return {
    async run(task) {
      await new Promise((resolve) => setTimeout(resolve, latencyMs));
      return { ok: true, changedFiles: [`src/${task.attemptId}.ts`], summary: `synthetic load-test change for ${task.attemptId}`, turnsUsed: 1 };
    },
  };
}

const NOOP_SLOP_ASSESSMENT = { slopRisk: 0, band: "clean", findings: [] };

/** One simulated tenant attempt: a distinct `repoFullName`/`contributorLogin` per `tenantIndex`, a linked open
 *  issue that matches on the first iteration, so every attempt hands off in exactly one iteration -- isolating
 *  the measurement to iterate-loop's own per-attempt orchestration overhead rather than varying iteration counts
 *  across runs. */
async function runOneAttempt(tenantIndex, driver) {
  const repoFullName = `load-test-tenant-${tenantIndex}/repo`;
  const attemptId = `attempt-${tenantIndex}`;
  const input = {
    attemptId,
    workingDirectory: `/tmp/${attemptId}`,
    acceptanceCriteriaPath: `/tmp/${attemptId}/acceptance-criteria.json`,
    instructions: "Synthetic load-test instructions",
    mode: "live",
    maxIterations: 3,
    maxTurnsPerIteration: 20,
    repoFullName,
    contributorLogin: `miner-${tenantIndex}`,
    title: "Synthetic load-test attempt",
    body: `Closes #${SYNTHETIC_ISSUE_NUMBER}`,
    linkedIssues: [SYNTHETIC_ISSUE_NUMBER],
    reviewContext: buildReviewContext(repoFullName),
    rejectionSignaled: false,
  };
  const deps = {
    driver,
    runSlopAssessment: () => NOOP_SLOP_ASSESSMENT,
    appendAttemptLogEvent: () => {},
  };
  const start = performance.now();
  const result = await runIterateLoop(input, deps);
  return { elapsedMs: performance.now() - start, result };
}

/**
 * Run `attemptCount` simulated tenant attempts concurrently (`Promise.all`, all started in the same tick) against
 * one shared fake driver, and report the aggregate wall time plus derived throughput. Every attempt is expected
 * to hand off after its first iteration (see {@link runOneAttempt}) -- a non-`"handoff"` outcome or a driver
 * error would silently understate real concurrent load, so both are counted and surfaced rather than ignored.
 */
export async function runConcurrencyLevel(concurrency, options = {}) {
  const attemptCount = options.attemptCount ?? DEFAULT_ATTEMPTS_PER_LEVEL;
  const latencyMs = options.latencyMs ?? DEFAULT_SIMULATED_DRIVER_LATENCY_MS;
  const driver = buildFakeLoadTestDriver(latencyMs);

  const start = performance.now();
  const outcomes = [];
  for (let batchStart = 0; batchStart < attemptCount; batchStart += concurrency) {
    const batchSize = Math.min(concurrency, attemptCount - batchStart);
    const batch = await Promise.all(
      Array.from({ length: batchSize }, (_unused, offset) => runOneAttempt(batchStart + offset, driver)),
    );
    outcomes.push(...batch);
  }
  const wallMs = performance.now() - start;
  const handoffCount = outcomes.filter((o) => o.result.outcome === "handoff").length;

  return {
    concurrency,
    attemptCount,
    latencyMs,
    wallMs,
    handoffCount,
    attemptsPerSecond: attemptCount / (wallMs / 1000),
  };
}

/** Run every concurrency level in `levels` in sequence (never overlapping each other), so one level's
 *  scheduling contention never bleeds into the next level's measurement. */
export async function runLoadTest(options = {}) {
  const levels = options.levels ?? DEFAULT_CONCURRENCY_LEVELS;
  const results = [];
  for (const concurrency of levels) {
    results.push(await runConcurrencyLevel(concurrency, options));
  }
  return results;
}

/** Render load-test results as a stable, greppable text report (no locale-dependent number formatting). */
export function formatLoadTestReport(results) {
  const lines = ["iterate-loop load test", ""];
  for (const r of results) {
    lines.push(
      `concurrency=${r.concurrency}: ${r.wallMs.toFixed(2)}ms wall for ${r.attemptCount} attempts, ` +
        `${Math.round(r.attemptsPerSecond)} attempts/sec, ${r.handoffCount}/${r.attemptCount} handed off ` +
        `(simulated driver latency ${r.latencyMs}ms)`,
    );
  }
  return lines.join("\n");
}

async function main() {
  const results = await runLoadTest();
  console.log(formatLoadTestReport(results));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
