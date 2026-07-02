// Per-analyzer circuit breaker (#2541). Analyzers that depend on a third-party HTTP API (registry lookups,
// GitHub API calls, endoflife.date, etc) have no memory of recent failures by default -- every incoming
// enrichment request re-attempts a currently-unhealthy dependency from a cold state, even seconds after an
// identical call just timed out or errored. Trip a short, in-process cooldown after a run of CONSECUTIVE
// thrown failures (a timeout counts -- runWithTimeout's rejection is a thrown failure) and skip that analyzer
// entirely -- no network/CLI call at all -- for the cooldown window, falling through the SAME plan.skipped
// path any other skip reason already uses. In-process only (no persistence layer): review-enrichment is a
// single long-lived process (Railway), matching the main app's equivalent per-provider AI circuit breaker
// (src/selfhost/ai.ts's createChainAi).
import type { AnalyzerName } from "./analyzers/types.js";

const ANALYZER_CIRCUIT_FAILURE_STREAK = 3;
const ANALYZER_CIRCUIT_COOLDOWN_MS = 5 * 60_000;

interface AnalyzerCircuitState {
  consecutiveFailures: number;
  cooldownUntilMs: number;
}

const analyzerCircuits = new Map<AnalyzerName, AnalyzerCircuitState>();

/** True while `name`'s breaker is open (tripped and still within its cooldown window). */
export function isAnalyzerCircuitOpen(name: AnalyzerName, nowMs = Date.now()): boolean {
  const state = analyzerCircuits.get(name);
  return state !== undefined && state.cooldownUntilMs > nowMs;
}

/** A completed run (whether a clean "ok" or a non-throwing "degraded"/"capped" partial result) resets the
 *  streak -- the dependency responded, so it is not the failure mode this breaker guards against. */
export function recordAnalyzerCircuitSuccess(name: AnalyzerName): void {
  analyzerCircuits.delete(name);
}

/** A THROWN failure (including the analyzer_timeout rejection) is the signal this breaker tracks. Trips the
 *  cooldown once the consecutive count reaches the streak threshold; stays open (extends nothing further --
 *  the analyzer is simply skipped while open, so no additional failures accrue until it is tried again). */
export function recordAnalyzerCircuitFailure(name: AnalyzerName, nowMs = Date.now()): void {
  const state = analyzerCircuits.get(name) ?? { consecutiveFailures: 0, cooldownUntilMs: 0 };
  state.consecutiveFailures += 1;
  if (state.consecutiveFailures >= ANALYZER_CIRCUIT_FAILURE_STREAK) {
    state.cooldownUntilMs = nowMs + ANALYZER_CIRCUIT_COOLDOWN_MS;
  }
  analyzerCircuits.set(name, state);
}

/** Test-only reset so circuit-breaker state from one test can't leak into the next (module-level Map). */
export function resetAnalyzerCircuitsForTest(): void {
  analyzerCircuits.clear();
}
