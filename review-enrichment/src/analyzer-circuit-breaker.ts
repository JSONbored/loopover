// Per-analyzer circuit breaker (#2541). Analyzers that depend on a third-party HTTP API (registry lookups,
// GitHub API calls, endoflife.date, etc) have no memory of recent failures by default -- every incoming
// enrichment request re-attempts a currently-unhealthy dependency from a cold state, even seconds after an
// identical call just timed out or errored. Trip a short, in-process cooldown after a run of CONSECUTIVE
// thrown failures (a timeout counts -- runWithTimeout's rejection is a thrown failure) and skip that analyzer
// entirely -- no network/CLI call at all -- for the cooldown window, falling through the SAME plan.skipped
// path any other skip reason already uses. In-process only (no persistence layer), but scoped by repository
// so one PR cannot suppress security analysis for unrelated repositories sharing the same long-lived process,
// matching the main app's equivalent per-provider AI circuit breaker
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
// A repo×analyzer entry with no new failure in this long is assumed dead (the repo stopped sending PRs, or
// started succeeding via a path that never calls recordAnalyzerCircuitSuccess, e.g. a skip for an unrelated
// reason). Comfortably longer than the cooldown so a still-cooling-down entry is never swept mid-cooldown.
const ANALYZER_CIRCUIT_IDLE_EVICTION_MS = 6 * ANALYZER_CIRCUIT_COOLDOWN_MS;

interface AnalyzerCircuitState {
  consecutiveFailures: number;
  cooldownUntilMs: number;
  probeClaimed: boolean;
  lastFailureMs: number;
}

/** Scope the in-memory breaker to the repository whose request produced the failures. */
export interface AnalyzerCircuitScope {
  repoFullName: string;
}

const analyzerCircuits = new Map<string, AnalyzerCircuitState>();

// GitHub repository full names are case-insensitive, so "Org/Repo" and "org/repo" must key the same breaker
// bucket -- otherwise casing drift across callers would silently split one repository's failure history
// across multiple never-tripping entries, and each entry would also count separately against the eviction
// sweep below.
function analyzerCircuitKey(name: AnalyzerName, scope: AnalyzerCircuitScope): string {
  return `${scope.repoFullName.trim().toLowerCase()}\0${name}`;
}

/** Bound the map's size by dropping entries that have not failed recently, regardless of whether they ever
 *  tripped -- otherwise a long-lived worker retains one entry per repo×analyzer pair that has EVER failed
 *  even once, forever. Runs on every recorded failure (the only path that grows the map) rather than on a
 *  timer, so it stays correct in tests that fake `Date.now` and needs no background interval to manage. */
function evictIdleAnalyzerCircuits(nowMs: number): void {
  for (const [key, state] of analyzerCircuits) {
    if (state.lastFailureMs + ANALYZER_CIRCUIT_IDLE_EVICTION_MS < nowMs) {
      analyzerCircuits.delete(key);
    }
  }
}

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
export function isAnalyzerCircuitOpen(
  name: AnalyzerName,
  scope: AnalyzerCircuitScope,
  nowMs = Date.now(),
): boolean {
  const key = analyzerCircuitKey(name, scope);
  const state = analyzerCircuits.get(key);
  if (state === undefined || state.cooldownUntilMs === 0) return false;
  if (state.cooldownUntilMs > nowMs) return true;
  if (state.probeClaimed) return true;
  state.probeClaimed = true;
  return false;
}

/** A completed run (whether a clean "ok" or a non-throwing "degraded"/"capped" partial result) resets the
 *  streak -- the dependency responded, so it is not the failure mode this breaker guards against. */
export function recordAnalyzerCircuitSuccess(name: AnalyzerName, scope: AnalyzerCircuitScope): void {
  analyzerCircuits.delete(analyzerCircuitKey(name, scope));
}

/** A THROWN failure (including the analyzer_timeout rejection) is the signal this breaker tracks. Trips the
 *  cooldown once the consecutive count reaches the streak threshold; stays open (extends nothing further --
 *  the analyzer is simply skipped while open, so no additional failures accrue until it is tried again). A
 *  half-open probe's failure re-extends the cooldown via this same threshold check, since consecutiveFailures
 *  is already at/above it by the time a probe can be claimed -- no separate re-trip path needed. */
export function recordAnalyzerCircuitFailure(
  name: AnalyzerName,
  scope: AnalyzerCircuitScope,
  nowMs = Date.now(),
): void {
  evictIdleAnalyzerCircuits(nowMs);
  const key = analyzerCircuitKey(name, scope);
  const state = analyzerCircuits.get(key) ?? { consecutiveFailures: 0, cooldownUntilMs: 0, probeClaimed: false, lastFailureMs: nowMs };
  state.consecutiveFailures += 1;
  state.probeClaimed = false;
  state.lastFailureMs = nowMs;
  if (state.consecutiveFailures >= ANALYZER_CIRCUIT_FAILURE_STREAK) {
    state.cooldownUntilMs = nowMs + ANALYZER_CIRCUIT_COOLDOWN_MS;
  }
  analyzerCircuits.set(key, state);
}

/** Frees a claimed half-open probe WITHOUT recording success or failure -- for when the probing attempt never
 *  actually reached the analyzer call (capped by budget/timeout in brief.ts first). Safe no-op when `name` has
 *  no circuit state or no claimed probe, so callers can call this unconditionally on every capped early-return
 *  without needing to know whether this particular call was the one that claimed the probe. */
export function releaseAnalyzerCircuitProbe(name: AnalyzerName, scope: AnalyzerCircuitScope): void {
  const state = analyzerCircuits.get(analyzerCircuitKey(name, scope));
  if (state !== undefined) state.probeClaimed = false;
}

/** Test-only reset so circuit-breaker state from one test can't leak into the next (module-level Map). */
export function resetAnalyzerCircuitsForTest(): void {
  analyzerCircuits.clear();
}
