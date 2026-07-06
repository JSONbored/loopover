// System clock-drift detection (#3811). edge-us-01's system clock silently drifted ~3 minutes off true
// time because its sole configured NTP source was dead (`chronyc sources` showed Reach: 0 the whole
// time, no redundant fallback), breaking GitHub App JWT auth ("Bad credentials") for a window before
// anyone noticed. GitHub App JWTs are signed with iat/exp derived from the local clock (createAppJwt,
// src/github/app.ts), so drift shows up there first. Rather than spend a network round-trip just to
// check the clock, this piggybacks on the `Date` response header of the JWT-authenticated
// installation-token mint call that's ALREADY made whenever a token needs (re-)minting -- no new
// outbound request, sampled at exactly the cadence the vulnerable code path itself runs.

let lastSkewSeconds = 0;

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
}

/** The most recently observed clock-skew sample in seconds (0 until the first successful sample). */
export function clockSkewSecondsSample(): number {
  return lastSkewSeconds;
}

/** Test-only: reset the module-level sample between tests. */
export function resetClockSkewForTest(): void {
  lastSkewSeconds = 0;
}
