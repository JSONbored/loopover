// System clock-drift detection (#3811). edge-us-01's system clock silently drifted ~3 minutes off true
// time because its sole configured NTP source was dead (`chronyc sources` showed Reach: 0 the whole
// time, no redundant fallback), breaking GitHub App JWT auth ("Bad credentials") for a window before
// anyone noticed. GitHub App JWTs are signed with iat/exp derived from the local clock (createAppJwt,
// src/github/app.ts), so drift shows up there first. Rather than spend a network round-trip just to
// check the clock, this piggybacks on the `Date` response header of the JWT-authenticated
// installation-token mint call that's ALREADY made whenever a token needs (re-)minting -- no new
// outbound request, sampled at exactly the cadence the vulnerable code path itself runs.

let lastSkewSeconds = 0;
// The wall-clock time (ms) of the last SUCCESSFUL sample, or null before the first one. Backs the staleness
// signal below so an old sample can't silently look current if token-mint activity — the only thing that
// refreshes lastSkewSeconds — stalls (#7000).
let lastSkewSampleAtMs: number | null = null;
// #9128 (sibling audit): module-load time, the fallback "since" reference for clockSkewSampleAgeSeconds
// when no sample has ever landed -- mirrors the SAME fix applied to the relay-drain "never happened" gauge,
// which read a flat -1 forever (never ageing into a threshold no matter how long the underlying condition
// persisted). No alert currently reads this gauge (confirmed: zero references in prometheus/rules/alerts.yml
// and zero dashboard panels), so today this closes a latent hole rather than an active one -- but the SAME
// shape would silently defeat any FUTURE alert added on this metric, exactly as it did for relay-drain.
let moduleLoadedAtMs = Date.now();

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
  const localMs = Date.now();
  lastSkewSeconds = (localMs - remoteMs) / 1000;
  lastSkewSampleAtMs = localMs;
}

/** The most recently observed clock-skew sample in seconds (0 until the first successful sample). */
export function clockSkewSecondsSample(): number {
  return lastSkewSeconds;
}

/**
 * Seconds since the last successful clock-skew sample -- or, before any sample has ever landed, seconds
 * since this module was loaded (#9128: previously a flat -1 sentinel that never aged, the same "never
 * happened" shape that let the relay-drain staleness alarm go permanently quiet). No alert reads this gauge
 * today, so this only closes a latent hole, but it means a future threshold on it behaves correctly from
 * the start rather than needing its own follow-up fix.
 */
export function clockSkewSampleAgeSeconds(): number {
  const sinceMs = lastSkewSampleAtMs ?? moduleLoadedAtMs;
  return (Date.now() - sinceMs) / 1000;
}

/** Test-only: reset the module-level sample between tests, including the #9128 boot-time reference (so a
 *  test can control "time since load" precisely, matching resetPostHogForTest-style module resets elsewhere). */
export function resetClockSkewForTest(): void {
  lastSkewSeconds = 0;
  lastSkewSampleAtMs = null;
  moduleLoadedAtMs = Date.now();
}
