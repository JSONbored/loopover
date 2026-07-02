// Per-analyzer circuit breaker (#2541). Analyzers that depend on a third-party HTTP API (registry lookups,
// GitHub API calls, endoflife.date, etc) have no memory of recent failures by default -- every incoming
// enrichment request re-attempts a currently-unhealthy dependency from a cold state, even seconds after an
// identical call just timed out or errored. Trip a short, in-process cooldown after a run of CONSECUTIVE
// thrown failures (a timeout counts -- runWithTimeout's rejection is a thrown failure) and skip that analyzer
// entirely -- no network/CLI call at all -- for the cooldown window, falling through the SAME plan.skipped
// path any other skip reason already uses. In-process only (no persistence layer): review-enrichment is a
// single long-lived process (Railway), matching the main app's equivalent per-provider AI circuit breaker
// (src/selfhost/ai.ts's createChainAi).
//
// Half-open probing: review-enrichment serves CONCURRENT requests (one per in-flight PR review), so once the
// cooldown expires, a burst of near-simultaneous requests would all see the circuit as "not open" and all
// retry the same still-unhealthy dependency at once. `isAnalyzerCircuitOpen` claims a single probe slot the
// first time it observes an expired cooldown; every other caller sees the circuit as still open until that
// one probe resolves (recordAnalyzerCircuitSuccess/Failure). `releaseAnalyzerCircuitProbe` frees a claimed
// slot without recording an outcome, for the case where the analyzer never actually ran (budget/timeout
// capped in brief.ts before reaching the real call) -- otherwise a stuck claim would block re-probing forever.
import type { AnalyzerName } from "./analyzers/types.js";

const ANALYZER_CIRCUIT_FAILURE_STREAK = 3;
const ANALYZER_CIRCUIT_COOLDOWN_MS = 5 * 60_000;

interface AnalyzerCircuitState {
  consecutiveFailures: number;
  cooldownUntilMs: number;
  probeClaimed: boolean;
}

const analyzerCircuits = new Map<AnalyzerName, AnalyzerCircuitState>();

/** True while `name`'s breaker should skip the caller: either still within the full cooldown window, or past
 *  it but another caller already claimed this cycle's single half-open probe. The FIRST caller to observe an
 *  expired cooldown claims the probe as a side effect and gets `false` (proceed) -- this is the one function
 *  planning calls to decide runnable vs skipped, so the claim has to happen here, not at execution time.
 *
 *  `cooldownUntilMs === 0` means the circuit has NEVER actually tripped (below the streak threshold) --
 *  recordAnalyzerCircuitFailure only sets a non-zero cooldownUntilMs once consecutiveFailures reaches the
 *  threshold, so this is a reliable "never opened" check. Without it, a caller after just 1-2 failures would
 *  claim the half-open probe slot too, spuriously skipping a concurrent second caller as circuit_open even
 *  though the breaker was never actually open. */
export function isAnalyzerCircuitOpen(name: AnalyzerName, nowMs = Date.now()): boolean {
  const state = analyzerCircuits.get(name);
  if (state === undefined || state.cooldownUntilMs === 0) return false;
  if (state.cooldownUntilMs > nowMs) return true;
  if (state.probeClaimed) return true;
  state.probeClaimed = true;
  return false;
}

/** A completed run (whether a clean "ok" or a non-throwing "degraded"/"capped" partial result) resets the
 *  streak -- the dependency responded, so it is not the failure mode this breaker guards against. */
export function recordAnalyzerCircuitSuccess(name: AnalyzerName): void {
  analyzerCircuits.delete(name);
}

/** A THROWN failure (including the analyzer_timeout rejection) is the signal this breaker tracks. Trips the
 *  cooldown once the consecutive count reaches the streak threshold; stays open (extends nothing further --
 *  the analyzer is simply skipped while open, so no additional failures accrue until it is tried again). A
 *  half-open probe's failure re-extends the cooldown via this same threshold check, since consecutiveFailures
 *  is already at/above it by the time a probe can be claimed -- no separate re-trip path needed. */
export function recordAnalyzerCircuitFailure(name: AnalyzerName, nowMs = Date.now()): void {
  const state = analyzerCircuits.get(name) ?? { consecutiveFailures: 0, cooldownUntilMs: 0, probeClaimed: false };
  state.consecutiveFailures += 1;
  state.probeClaimed = false;
  if (state.consecutiveFailures >= ANALYZER_CIRCUIT_FAILURE_STREAK) {
    state.cooldownUntilMs = nowMs + ANALYZER_CIRCUIT_COOLDOWN_MS;
  }
  analyzerCircuits.set(name, state);
}

/** Frees a claimed half-open probe WITHOUT recording success or failure -- for when the probing attempt never
 *  actually reached the analyzer call (capped by budget/timeout in brief.ts first). Safe no-op when `name` has
 *  no circuit state or no claimed probe, so callers can call this unconditionally on every capped early-return
 *  without needing to know whether this particular call was the one that claimed the probe. */
export function releaseAnalyzerCircuitProbe(name: AnalyzerName): void {
  const state = analyzerCircuits.get(name);
  if (state !== undefined) state.probeClaimed = false;
}

/** Test-only reset so circuit-breaker state from one test can't leak into the next (module-level Map). */
export function resetAnalyzerCircuitsForTest(): void {
  analyzerCircuits.clear();
}
