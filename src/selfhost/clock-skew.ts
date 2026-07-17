// System clock-drift detection (#3811). edge-us-01's system clock silently drifted ~3 minutes off true
// time because its sole configured NTP source was dead (`chronyc sources` showed Reach: 0 the whole
// time, no redundant fallback), breaking GitHub App JWT auth ("Bad credentials") for a window before
// anyone noticed. GitHub App JWTs are signed with iat/exp derived from the local clock (createAppJwt,
// src/github/app.ts), so drift shows up there first. Rather than spend a network round-trip just to
// check the clock, this piggybacks on the `Date` response header of the JWT-authenticated
// installation-token mint call that's ALREADY made whenever a token needs (re-)minting -- no new
// outbound request, sampled at exactly the cadence the vulnerable code path itself runs.

let lastSkewSeconds = 0;
// Epoch ms of the last successful sample; -1 until one is observed (#7000). The skew gauge alone can't
// distinguish a fresh reading from one that stopped updating (e.g. a long-lived cached/broker token means
// no fresh JWT-mint call happens, so `Date` headers stop arriving), so an operator needs the sample's age.
let lastSkewObservedAtMs = -1;

/**
 * Update the last-observed clock-skew sample from a GitHub response's `Date` header. Positive means
 * this process's clock is AHEAD of GitHub's; negative means it's BEHIND. A missing or unparseable
 * header is ignored (the previous sample is left in place) rather than reset to 0, so one malformed
 * response can never mask real drift until the next successful sample.
 */
export function recordClockSkewFromResponse(response: Response): void {
  const dateHeader = response.headers.get("date");
  if (!dateHeader) return;
  const remoteMs = Date.parse(dateHeader);
  if (!Number.isFinite(remoteMs)) return;
  lastSkewSeconds = (Date.now() - remoteMs) / 1000;
  lastSkewObservedAtMs = Date.now();
}

/** The most recently observed clock-skew sample in seconds (0 until the first successful sample). */
export function clockSkewSecondsSample(): number {
  return lastSkewSeconds;
}

/**
 * Age in seconds of the most recent clock-skew sample, or `-1` when none has been observed yet (#7000).
 * The `-1` sentinel matches `d1-size-probe.ts`/`loopover_host_load_avg1_per_core`'s convention: it separates
 * "never sampled" from a genuine fresh 0-second age, so a dashboard can flag a stale/stalled reading.
 */
export function clockSkewSampleAgeSeconds(): number {
  if (lastSkewObservedAtMs < 0) return -1;
  return (Date.now() - lastSkewObservedAtMs) / 1000;
}

/** Test-only: reset the module-level sample between tests. */
export function resetClockSkewForTest(): void {
  lastSkewSeconds = 0;
  lastSkewObservedAtMs = -1;
}
